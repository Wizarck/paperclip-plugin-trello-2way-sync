import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { TrelloSyncConfig } from "./types.js";
import { TrelloClient } from "./trello-client.js";
import { SyncStore } from "./sync-store.js";
import { PendingQueue } from "./pending-queue.js";
import { WebhookRegistration } from "./webhook-registration.js";
import { handleIssueCreated, handleIssueUpdated } from "./event-handlers.js";
import { handleTrelloWebhook } from "./webhook-handler.js";
import { registerBridgeHandlers } from "./bridge.js";
import { reconcileAllIssues } from "./reconcile.js";
import {
  PLUGIN_ID,
  WEBHOOK_KEY,
  STATE_KEYS,
  STATUS_KEYS,
} from "./constants.js";
import { TrelloAuthError, TrelloNotFoundError } from "./trello-client.js";

// Module-level sets for antiloop create+create prevention.
// These are reset whenever the worker process restarts.
const inFlightTrelloCreations = new Set<string>();
const inFlightPaperclipCreations = new Set<string>();

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const companies = await ctx.companies.list({ limit: 1 });
    const companyId = companies[0]?.id;
    if (!companyId) {
      ctx.logger.warn("trello-sync: no company found, plugin will be idle");
      return;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    async function getConfig(): Promise<TrelloSyncConfig> {
      return (await ctx.config.get()) as unknown as TrelloSyncConfig;
    }

    // Returns config enriched with auto-provisioned listIds/labelIds from state
    // so event handlers always have the IDs regardless of whether they are in config.
    async function getEffectiveConfig(): Promise<TrelloSyncConfig> {
      const config = await getConfig();
      const hasListIds = STATUS_KEYS.some((k) => config.listIds?.[k as keyof typeof config.listIds]);
      if (!hasListIds) {
        const stateListIds = (await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: STATE_KEYS.autoListIds,
        })) as Record<string, string> | null;
        const stateLabelIds = (await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: STATE_KEYS.autoLabelIds,
        })) as Record<string, string> | null;
        if (stateListIds) config.listIds = stateListIds as TrelloSyncConfig["listIds"];
        if (stateLabelIds) config.labelIds = stateLabelIds as TrelloSyncConfig["labelIds"];
      }
      return config;
    }

    async function buildTrelloClient(config: TrelloSyncConfig): Promise<TrelloClient> {
      const apiKey = config.apiKeyRef;
      const token = config.tokenRef;
      return new TrelloClient(apiKey, token);
    }

    const syncStore = new SyncStore(ctx.state, companyId);
    const pendingQueue = new PendingQueue(ctx.state, companyId);
    const webhookReg = new WebhookRegistration(ctx.state, ctx.logger, companyId);

    function callbackUrl(config: TrelloSyncConfig): string {
      const base = (config.paperclipBaseUrl ?? "").replace(/\/$/, "");
      return `${base}/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_KEY}`;
    }

    // ─── Bridge handlers ─────────────────────────────────────────────────────

    registerBridgeHandlers({
      ctx,
      getConfig,
      getTrello: buildTrelloClient,
      syncStore,
      webhookReg,
      companyId,
    });

    // ─── Event subscriptions ─────────────────────────────────────────────────

    ctx.events.on("issue.created", async (event) => {
      try {
        const config = await getEffectiveConfig();
        if (!(config.createCardOnNewIssue ?? true)) return;
        const trello = await buildTrelloClient(config);
        await handleIssueCreated(event, {
          ctx,
          trello,
          syncStore,
          pendingQueue,
          config,
          inFlightTrelloCreations,
        });
      } catch (err) {
        ctx.logger.error("trello-sync: unhandled error in issue.created", { err: String(err) });
        await ctx.metrics.write("trello_sync.error", 1, { type: "handler_crash" });
      }
    });

    ctx.events.on("issue.updated", async (event) => {
      try {
        const config = await getEffectiveConfig();
        const trello = await buildTrelloClient(config);
        await handleIssueUpdated(event, {
          ctx,
          trello,
          syncStore,
          pendingQueue,
          config,
          inFlightTrelloCreations,
        });
      } catch (err) {
        ctx.logger.error("trello-sync: unhandled error in issue.updated", { err: String(err) });
        await ctx.metrics.write("trello_sync.error", 1, { type: "handler_crash" });
      }
    });

    // ─── Scheduled jobs ──────────────────────────────────────────────────────

    ctx.jobs.register("reconcile", async () => {
      ctx.logger.info("trello-sync: starting reconcile job");
      try {
        const config = await getEffectiveConfig();
        const trello = await buildTrelloClient(config);
        await reconcileAllIssues(ctx, trello, syncStore, config, companyId);
      } catch (err) {
        ctx.logger.error("trello-sync: reconcile job failed", { err: String(err) });
        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.lastError },
          String(err),
        );
      }
    });

    ctx.jobs.register("check-webhook-health", async () => {
      ctx.logger.info("trello-sync: checking webhook health");
      try {
        const config = await getConfig(); // no list IDs needed here
        if (!config.paperclipBaseUrl) return;
        const trello = await buildTrelloClient(config);
        const cb = callbackUrl(config);
        const isHealthy = await webhookReg.checkExists(trello, cb);
        await ctx.metrics.write("trello_sync.webhook.healthy", isHealthy ? 1 : 0);
        if (!isHealthy) {
          ctx.logger.warn("trello-sync: webhook not active, re-registering");
          await webhookReg.ensureRegistered(trello, config.boardId, cb);
        }
      } catch (err) {
        ctx.logger.error("trello-sync: webhook health check failed", { err: String(err) });
      }
    });

    ctx.jobs.register("process-pending", async () => {
      ctx.logger.info("trello-sync: processing pending queue");
      // Note: The pending queue enqueues by op+id keys. Since the SDK state
      // client has no list/scan capability, we track pending items within the
      // reconcile job instead. This job serves as a trigger for reconcile when
      // there are pending failures.
      // Full pending-queue processing would require a separate index key.
      // Current implementation: call reconcile to fix any drift.
      try {
        const config = await getEffectiveConfig();
        const trello = await buildTrelloClient(config);
        await reconcileAllIssues(ctx, trello, syncStore, config, companyId);
      } catch (err) {
        ctx.logger.error("trello-sync: process-pending job failed", { err: String(err) });
      }
    });

    // ─── Initial setup ───────────────────────────────────────────────────────

    try {
      const config = await getConfig();

      // Detect boardId change
      const storedBoardId = (await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.configuredBoardId,
      })) as string | null;

      if (storedBoardId && storedBoardId !== config.boardId) {
        ctx.logger.warn("trello-sync: boardId changed, clearing stale mappings", {
          old: storedBoardId,
          new: config.boardId,
        });
        // List all issues and clear their mappings
        const issues = await ctx.issues.list({ companyId, limit: 100 });
        const issueIds = issues.map((i) => i.id);
        await syncStore.clearAllMappings(issueIds);
        // Deregister old webhook
        const trello = await buildTrelloClient(config);
        await webhookReg.deregister(trello);
      }

      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.configuredBoardId },
        config.boardId,
      );

      // Auto-create default lists and labels if not yet provisioned
      const storedListIds = (await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.autoListIds,
      })) as Record<string, string> | null;

      const hasListIds =
        storedListIds && STATUS_KEYS.some((k) => storedListIds[k]);

      if (!hasListIds && config.boardId && config.apiKeyRef && config.tokenRef) {
        ctx.logger.info(
          "trello-sync: no list IDs found — auto-creating 7 lists and 4 priority labels on the board",
        );
        try {
          const trello = await buildTrelloClient(config);
          const { createDefaultListsAndLabels } = await import("./bridge.js");
          const { listIds, labelIds } = await createDefaultListsAndLabels(
            trello,
            config,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.autoListIds },
            listIds,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.autoLabelIds },
            labelIds,
          );
          ctx.logger.info("trello-sync: auto-provisioning complete", { listIds, labelIds });
        } catch (err) {
          ctx.logger.warn("trello-sync: auto-create lists failed — will retry on next restart", {
            err: String(err),
          });
        }
      }

      // Register webhook if URL is configured
      if (config.paperclipBaseUrl && config.boardId) {
        const trello = await buildTrelloClient(config);
        const cb = callbackUrl(config);
        await webhookReg.ensureRegistered(trello, config.boardId, cb);
      }
    } catch (err) {
      ctx.logger.warn("trello-sync: initial setup incomplete (config may not be set yet)", {
        err: String(err),
      });
    }
  },

  // ─── Webhook handler ───────────────────────────────────────────────────────

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEY) return;

    // We need context — but onWebhook doesn't receive ctx directly.
    // This limitation means we need to store ctx at module scope during setup.
    // See _pluginCtx below.
    if (!_pluginCtx) return;

    const ctx = _pluginCtx;
    const companies = await ctx.companies.list({ limit: 1 });
    const companyId = companies[0]?.id;
    if (!companyId) return;

    const baseConfig = (await ctx.config.get()) as unknown as TrelloSyncConfig;
    // Enrich with auto-provisioned IDs from state
    const stateListIds = (await ctx.state.get({
      scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.autoListIds,
    })) as Record<string, string> | null;
    const stateLabelIds = (await ctx.state.get({
      scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.autoLabelIds,
    })) as Record<string, string> | null;
    const hasListIds = STATUS_KEYS.some((k) => baseConfig.listIds?.[k as keyof typeof baseConfig.listIds]);
    const config: TrelloSyncConfig = {
      ...baseConfig,
      listIds: hasListIds ? baseConfig.listIds : (stateListIds as TrelloSyncConfig["listIds"] ?? baseConfig.listIds),
      labelIds: hasListIds ? baseConfig.labelIds : (stateLabelIds as TrelloSyncConfig["labelIds"] ?? baseConfig.labelIds),
    };
    const apiKey = config.apiKeyRef;
    const apiSecret = config.apiSecretRef;
    const token = config.tokenRef;
    const trello = new TrelloClient(apiKey, token);
    const syncStore = new SyncStore(ctx.state, companyId);
    const pendingQueue = new PendingQueue(ctx.state, companyId);
    const cb = buildCallbackUrl(config);

    await handleTrelloWebhook(input, {
      ctx,
      trello,
      syncStore,
      pendingQueue,
      config,
      apiSecret,
      callbackUrl: cb,
      inFlightPaperclipCreations,
    });
  },

  // ─── Config validation ─────────────────────────────────────────────────────

  async onValidateConfig(config: Record<string, unknown>) {
    const c = config as unknown as TrelloSyncConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!c.apiKeyRef) errors.push("apiKeyRef is required");
    if (!c.apiSecretRef) errors.push("apiSecretRef is required");
    if (!c.tokenRef) errors.push("tokenRef is required");
    if (!c.boardId) errors.push("boardId is required");

    if (errors.length > 0) return { ok: false, errors };

    // Resolve credentials and validate
    if (!_pluginCtx) return { ok: true };

    try {
      const apiKey = c.apiKeyRef;
      const token = c.tokenRef;
      const trello = new TrelloClient(apiKey, token);

      // Test connection
      const ok = await trello.ping();
      if (!ok) {
        errors.push("Could not connect to Trello. Check your API Key and Token.");
        return { ok: false, errors };
      }

      // Validate token permissions
      try {
        const perms = await trello.getTokenPermissions();
        const hasWrite = perms.permissions.some((p) => p.write === true);
        if (!hasWrite) {
          warnings.push("Trello token appears to have read-only permissions. Write operations may fail.");
        }
      } catch {
        warnings.push("Could not verify Trello token permissions.");
      }

      // Validate listIds belong to the boardId
      if (c.listIds && c.boardId) {
        for (const [status, listId] of Object.entries(c.listIds)) {
          if (!listId) continue;
          try {
            const list = await trello.getList(listId);
            if (list.idBoard !== c.boardId) {
              errors.push(`List "${status}" (${listId}) does not belong to the configured board.`);
            }
          } catch (err) {
            if (err instanceof TrelloNotFoundError) {
              errors.push(`List "${status}" (${listId}) not found. Use 'Create default lists' to reconfigure.`);
            }
          }
        }
      }

      // Warn if Trello→Paperclip toggles enabled but no public URL
      const trelloToPaperclipEnabled =
        c.createIssueOnNewCard ||
        c.syncStatusToPaperclip ||
        c.syncTitleToPaperclip ||
        c.syncDescToPaperclip ||
        c.syncPriorityToPaperclip ||
        c.cancelOnCardArchive;

      if (trelloToPaperclipEnabled && !c.paperclipBaseUrl) {
        warnings.push(
          "Trello→Paperclip sync toggles are enabled but 'Paperclip Public URL' is not set. These toggles will have no effect until a public URL is configured.",
        );
      }

      if (c.paperclipBaseUrl) {
        if (!isPublicHttpsUrl(c.paperclipBaseUrl)) {
          errors.push("paperclipBaseUrl must be a public HTTPS URL (not localhost or private IP).");
        }
      }

    } catch (err) {
      if (err instanceof TrelloAuthError) {
        errors.push("Trello authentication failed. Check your API Key and Token.");
      } else {
        errors.push(`Validation error: ${String(err)}`);
      }
    }

    return { ok: errors.length === 0, errors, warnings };
  },

  // ─── Health ────────────────────────────────────────────────────────────────

  async onHealth() {
    if (!_pluginCtx) return { status: "degraded" as const, message: "Plugin not initialized" };

    const ctx = _pluginCtx;
    const companies = await ctx.companies.list({ limit: 1 });
    const companyId = companies[0]?.id;
    if (!companyId) return { status: "degraded" as const, message: "No company found" };

    const config = (await ctx.config.get()) as unknown as TrelloSyncConfig;

    let trelloOk = false;
    let webhookOk = false;

    try {
      if (config.apiKeyRef && config.tokenRef) {
        const apiKey = config.apiKeyRef;
        const token = config.tokenRef;
        const trello = new TrelloClient(apiKey, token);
        trelloOk = await trello.ping();

        if (config.paperclipBaseUrl && config.boardId) {
          const webhookReg = new WebhookRegistration(ctx.state, ctx.logger, companyId);
          webhookOk = await webhookReg.checkExists(trello, buildCallbackUrl(config));
        } else {
          webhookOk = true; // Not required when no public URL
        }
      }
    } catch {
      // Leave as false
    }

    const lastError = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: STATE_KEYS.lastError,
    });

    const status = !trelloOk ? "error" : "ok";

    return {
      status,
      details: {
        trello_api: trelloOk ? "connected" : "unreachable",
        webhook: webhookOk ? "registered" : "not_registered",
        last_error: lastError ?? null,
      },
    };
  },

  async onShutdown() {
    // Deregister webhook on clean shutdown
    if (!_pluginCtx) return;
    const ctx = _pluginCtx;
    try {
      const companies = await ctx.companies.list({ limit: 1 });
      const companyId = companies[0]?.id;
      if (!companyId) return;
      const config = (await ctx.config.get()) as unknown as TrelloSyncConfig;
      if (!config.apiKeyRef || !config.tokenRef) return;
      const apiKey = config.apiKeyRef;
      const token = config.tokenRef;
      const trello = new TrelloClient(apiKey, token);
      const webhookReg = new WebhookRegistration(ctx.state, ctx.logger, companyId);
      await webhookReg.deregister(trello);
    } catch {
      // Best-effort
    }
  },
});

// Module-level context reference — needed for onWebhook/onHealth which don't
// receive ctx as a parameter in the current SDK surface.
let _pluginCtx: PluginContext | null = null;

// Monkey-patch setup to capture ctx
const originalSetup = plugin.definition.setup;
(plugin.definition as { setup: (ctx: PluginContext) => Promise<void> }).setup = async (ctx: PluginContext) => {
  _pluginCtx = ctx;
  await originalSetup(ctx);
};

export default plugin;
runWorker(plugin, import.meta.url);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCallbackUrl(config: TrelloSyncConfig): string {
  const base = (config.paperclipBaseUrl ?? "").replace(/\/$/, "");
  return `${base}/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_KEY}`;
}

function isPublicHttpsUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:") return false;
    const privatePatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^192\.168\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^169\.254\./,
    ];
    return !privatePatterns.some((p) => p.test(hostname));
  } catch {
    return false;
  }
}
