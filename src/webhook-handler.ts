import { createHmac, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { TrelloSyncConfig, TrelloAction } from "./types.js";
import type { TrelloClient } from "./trello-client.js";
import type { SyncStore } from "./sync-store.js";
import type { PendingQueue } from "./pending-queue.js";
import { stripSyncTag } from "./event-handlers.js";
import {
  DEBOUNCE_MS,
  STATE_KEYS,
  REVERSE_STATUS_MAP,
} from "./constants.js";
import { getPriorityFromLabelIds } from "./labels.js";
import { TrelloNotFoundError } from "./trello-client.js";

export interface WebhookHandlerDeps {
  ctx: PluginContext;
  companyId: string;
  trello: TrelloClient;
  syncStore: SyncStore;
  pendingQueue: PendingQueue;
  config: TrelloSyncConfig;
  apiSecret: string;
  callbackUrl: string;
  /** IDs of Paperclip issues currently being created by our Paperclip→Trello handler */
  inFlightPaperclipCreations: Set<string>;
}

export async function handleTrelloWebhook(
  input: PluginWebhookInput,
  deps: WebhookHandlerDeps,
): Promise<{ status: number }> {
  const { ctx, companyId, config, apiSecret, callbackUrl } = deps;

  // Trello sends HEAD to verify the endpoint — respond 200
  // (The host handles HEAD automatically; this guard is defensive)
  if (!input.rawBody) return { status: 200 };

  // HMAC verification
  const signature = Array.isArray(input.headers["x-trello-webhook"])
    ? input.headers["x-trello-webhook"][0]
    : (input.headers["x-trello-webhook"] as string | undefined);

  if (!signature || !verifyTrelloWebhook(input.rawBody, signature, callbackUrl, apiSecret)) {
    ctx.logger.warn("trello-sync: webhook HMAC verification failed");
    await ctx.metrics.write("trello_sync.error", 1, { type: "hmac_fail" });
    return { status: 403 };
  }

  let action: TrelloAction;
  try {
    const parsed = input.parsedBody as { action?: TrelloAction };
    action = parsed?.action ?? (JSON.parse(input.rawBody) as { action: TrelloAction }).action;
  } catch {
    ctx.logger.warn("trello-sync: failed to parse webhook body");
    return { status: 400 };
  }

  // Replay protection
  const scopeKey = {
    scopeKind: "company" as const,
    scopeId: action.id, // reuse as scoped key — unique per Trello action
    stateKey: STATE_KEYS.seenAction(action.id),
  };
  const alreadySeen = await ctx.state.get(scopeKey);
  if (alreadySeen) {
    return { status: 200 }; // idempotent
  }
  await ctx.state.set(scopeKey, Date.now());
  // Note: state TTL not available in SDK — we rely on the 5-min dedup window being short

  await routeAction(action, deps);
  return { status: 200 };
}

async function routeAction(action: TrelloAction, deps: WebhookHandlerDeps): Promise<void> {
  const { type } = action;
  switch (type) {
    case "createCard":
      await handleCardCreated(action, deps);
      break;
    case "updateCard":
      await handleCardUpdated(action, deps);
      break;
    case "deleteCard":
      await handleCardDeleted(action, deps);
      break;
    case "copyCard":
      // Treat as create
      await handleCardCreated(action, deps);
      break;
    default:
      // Ignored action type
      break;
  }
}

async function handleCardCreated(action: TrelloAction, deps: WebhookHandlerDeps): Promise<void> {
  const { ctx, syncStore, config, inFlightPaperclipCreations } = deps;
  const cardId = action.data.card?.id;
  if (!cardId) return;

  if (!(config.createIssueOnNewCard ?? false)) return;

  // Check if already mapped (could be a card we just created from Paperclip)
  const existingIssueId = await syncStore.getByCardId(cardId);
  if (existingIssueId) return; // already mapped — skip

  const cardName = action.data.card?.name ?? "Untitled";
  const listId = action.data.list?.id ?? action.data.card?.idList ?? "";

  // Determine status from the list
  const status = reverseMapListId(listId, config) ?? "todo";

  inFlightPaperclipCreations.add(cardId);
  try {
    const companyId = deps.companyId;
    const issue = await ctx.issues.create({
      companyId,
      title: cardName,
      description: action.data.card?.desc ? stripSyncTag(action.data.card.desc) : undefined,
    });

    // Update status if not default
    if (status !== "todo" && status !== "backlog") {
      await ctx.issues.update(
        issue.id,
        { status: status as Parameters<typeof ctx.issues.update>[1]["status"] },
        companyId,
      );
    }

    await syncStore.setMapping(issue.id, cardId, "trello");
    await ctx.metrics.write("trello_sync.issue.created", 1, { direction: "trello_to_pc" });
  } catch (err) {
    ctx.logger.error("trello-sync: failed to create Paperclip issue from card", { cardId, err: String(err) });
    await deps.pendingQueue.enqueue("create-issue", cardId, { cardId, cardName, listId });
    await ctx.metrics.write("trello_sync.error", 1, { type: "create_issue" });
  } finally {
    inFlightPaperclipCreations.delete(cardId);
  }
}

async function handleCardUpdated(action: TrelloAction, deps: WebhookHandlerDeps): Promise<void> {
  const { ctx, syncStore, config, trello } = deps;
  const cardId = action.data.card?.id;
  if (!cardId) return;

  const issueId = await syncStore.getByCardId(cardId);
  if (!issueId) return; // not synced

  const mapping = await syncStore.getByIssueId(issueId);
  if (!mapping) return;

  // Debounce: if originated from Paperclip, skip
  if (syncStore.isDebounced(mapping, DEBOUNCE_MS, "paperclip")) {
    await ctx.metrics.write("trello_sync.debounce.skipped", 1);
    return;
  }

  const companyId = deps.companyId;
  const patch: Record<string, unknown> = {};

  // Card archived?
  const closed = action.data.card?.closed;
  if (closed === true) {
    if (config.cancelOnCardArchive ?? false) {
      try {
        await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
        await syncStore.touchMapping(issueId, "trello");
        await ctx.metrics.write("trello_sync.issue.updated", 1, { direction: "trello_to_pc" });
      } catch (err) {
        ctx.logger.error("trello-sync: failed to cancel issue on card archive", { issueId, err: String(err) });
      }
    }
    return;
  }

  // List changed → status
  if ((config.syncStatusToPaperclip ?? false) && action.data.listAfter) {
    const newStatus = reverseMapListId(action.data.listAfter.id, config);
    if (newStatus) patch.status = newStatus;
  }

  // Name changed → title
  if ((config.syncTitleToPaperclip ?? false) && action.data.old?.name != null) {
    patch.title = action.data.card?.name;
  }

  // Desc changed
  if ((config.syncDescToPaperclip ?? false) && action.data.old?.desc != null) {
    patch.description = stripSyncTag(action.data.card?.desc ?? "");
  }

  // Labels changed → priority
  if ((config.syncPriorityToPaperclip ?? false) && action.data.old?.idLabels != null) {
    const cardLabelIds = action.data.card?.idLabels ?? [];
    const priority = getPriorityFromLabelIds(cardLabelIds, config.labelIds ?? {});
    if (priority) patch.priority = priority;
  }

  if (Object.keys(patch).length === 0) return;

  try {
    await ctx.issues.update(issueId, patch as Parameters<typeof ctx.issues.update>[1], companyId);
    await syncStore.touchMapping(issueId, "trello");
    await ctx.metrics.write("trello_sync.issue.updated", 1, { direction: "trello_to_pc" });
  } catch (err) {
    ctx.logger.error("trello-sync: failed to update Paperclip issue from webhook", { issueId, cardId, err: String(err) });
    await deps.pendingQueue.enqueue("update-issue", issueId, { issueId, patch });
    await ctx.metrics.write("trello_sync.error", 1, { type: "update_issue" });
  }
}

async function handleCardDeleted(action: TrelloAction, deps: WebhookHandlerDeps): Promise<void> {
  const { ctx, syncStore } = deps;
  const cardId = action.data.card?.id;
  if (!cardId) return;

  const issueId = await syncStore.getByCardId(cardId);
  if (!issueId) return;

  await syncStore.deleteMappingByCardId(cardId);
  ctx.logger.info("trello-sync: card deleted, mapping removed", { cardId, issueId });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function verifyTrelloWebhook(
  rawBody: string,
  signature: string,
  callbackUrl: string,
  apiSecret: string,
): boolean {
  try {
    const content = rawBody + callbackUrl;
    const expected = createHmac("sha1", apiSecret).update(content).digest("base64");
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function reverseMapListId(
  listId: string,
  config: TrelloSyncConfig,
): string | undefined {
  if (!config.listIds) return undefined;
  const entry = Object.entries(config.listIds).find(([, id]) => id === listId);
  if (!entry) return undefined;
  return REVERSE_STATUS_MAP[entry[0] as keyof typeof REVERSE_STATUS_MAP];
}

