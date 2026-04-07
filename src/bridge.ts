import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { TrelloSyncConfig } from "./types.js";
import type { TrelloClient } from "./trello-client.js";
import type { SyncStore } from "./sync-store.js";
import type { WebhookRegistration } from "./webhook-registration.js";
import { syncPriorityLabels } from "./labels.js";
import { reconcileAllIssues } from "./reconcile.js";
import { STATUS_KEYS, DEFAULT_LIST_NAMES, STATE_KEYS } from "./constants.js";
import { TrelloAuthError } from "./trello-client.js";

export interface BridgeDeps {
  ctx: PluginContext;
  getConfig: () => Promise<TrelloSyncConfig>;
  getTrello: (config: TrelloSyncConfig) => Promise<TrelloClient>;
  syncStore: SyncStore;
  webhookReg: WebhookRegistration;
  companyId: string;
}

export function registerBridgeHandlers(deps: BridgeDeps): void {
  const { ctx } = deps;

  // ─── Data handlers ─────────────────────────────────────────────────────────

  ctx.data.register("getMyBoards", async () => {
    const config = await deps.getConfig();
    const trello = await deps.getTrello(config);
    const boards = await trello.getMyBoards();
    return boards.map((b) => ({ id: b.id, name: b.name, url: b.url }));
  });

  ctx.data.register("getTrelloLists", async (params) => {
    const config = await deps.getConfig();
    const boardId = (params.boardId as string | undefined) ?? config.boardId;
    if (!boardId) return { lists: [] };
    const trello = await deps.getTrello(config);
    const lists = await trello.getBoardLists(boardId);
    return { lists: lists.map((l) => ({ id: l.id, name: l.name })) };
  });

  ctx.data.register("getSyncStatus", async () => {
    const lastReconcileAt = await ctx.state.get({
      scopeKind: "company",
      scopeId: deps.companyId,
      stateKey: STATE_KEYS.lastReconcileAt,
    });
    const lastError = await ctx.state.get({
      scopeKind: "company",
      scopeId: deps.companyId,
      stateKey: STATE_KEYS.lastError,
    });
    return {
      lastReconcileAt: lastReconcileAt ?? null,
      lastError: lastError ?? null,
    };
  });

  // ─── Action handlers ───────────────────────────────────────────────────────

  ctx.actions.register("createDefaultLists", async (params) => {
    const config = await deps.getConfig();
    const trello = await deps.getTrello(config);
    const boardId = (params.boardId as string | undefined) ?? config.boardId;

    if (!boardId) {
      return { ok: false, error: "boardId is required" };
    }

    const listNames: Record<string, string> = {};
    for (const key of STATUS_KEYS) {
      listNames[key] = (config.listNames?.[key]) ?? DEFAULT_LIST_NAMES[key];
    }

    // Get existing lists
    const existingLists = await trello.getBoardLists(boardId);
    const listIds: Record<string, string> = {};

    for (const key of STATUS_KEYS) {
      const name = listNames[key];
      const existing = existingLists.find((l) => l.name === name);
      if (existing) {
        listIds[key] = existing.id;
      } else {
        const created = await trello.createList(boardId, name);
        listIds[key] = created.id;
      }
    }

    // Create/sync priority labels
    const labelIds = await syncPriorityLabels(trello, { ...config, boardId, listIds }, ctx.state, deps.companyId);

    return { ok: true, listIds, labelIds };
  });

  ctx.actions.register("triggerReconcile", async () => {
    // The host handles job triggering; we simulate by running inline
    // In production Paperclip, ctx.jobs.trigger would be available
    const config = await deps.getConfig();
    const trello = await deps.getTrello(config);
    reconcileAllIssues(ctx, trello, deps.syncStore, config, deps.companyId).catch(
      (err) => ctx.logger.error("trello-sync: manual reconcile failed", { err: String(err) }),
    );
    return { ok: true, message: "Reconciliación iniciada" };
  });

  ctx.actions.register("unlinkIssue", async (params) => {
    const issueId = params.issueId as string | undefined;
    if (!issueId) return { ok: false, error: "issueId is required" };

    await deps.syncStore.deleteMapping(issueId);
    await ctx.activity.log({
      companyId: deps.companyId,
      message: "Issue desvinculado de Trello",
      entityType: "issue",
      entityId: issueId,
    });
    return { ok: true };
  });

  ctx.actions.register("testConnection", async () => {
    const config = await deps.getConfig();
    try {
      const trello = await deps.getTrello(config);
      const ok = await trello.ping();
      return {
        ok,
        message: ok ? "Conexión con Trello correcta" : "No se pudo conectar con Trello",
      };
    } catch (err) {
      if (err instanceof TrelloAuthError) {
        return { ok: false, error: "Credenciales inválidas (401)" };
      }
      return { ok: false, error: String(err) };
    }
  });
}
