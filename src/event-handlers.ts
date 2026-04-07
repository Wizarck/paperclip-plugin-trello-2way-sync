import type { PluginContext, PluginEvent, Issue } from "@paperclipai/plugin-sdk";
import type { TrelloSyncConfig } from "./types.js";
import type { TrelloClient } from "./trello-client.js";
import type { SyncStore } from "./sync-store.js";
import type { PendingQueue } from "./pending-queue.js";
import { getLabelIdForPriority } from "./labels.js";
import { DEBOUNCE_MS, PLUGIN_ID } from "./constants.js";
import { TrelloNotFoundError } from "./trello-client.js";

export interface HandlerDeps {
  ctx: PluginContext;
  trello: TrelloClient;
  syncStore: SyncStore;
  pendingQueue: PendingQueue;
  config: TrelloSyncConfig;
  /** IDs of Trello cards currently being created by our Trello→Paperclip handler */
  inFlightTrelloCreations: Set<string>;
}

export async function handleIssueCreated(
  event: PluginEvent,
  deps: HandlerDeps,
): Promise<void> {
  const { ctx, trello, syncStore, config, inFlightTrelloCreations } = deps;
  const { companyId } = event;
  const issue = event.payload as Issue;
  const issueId = issue.id ?? event.entityId;

  if (!issueId) return;
  if (!(config.createCardOnNewIssue ?? true)) return;

  ctx.logger.info("trello-sync: issue.created payload", {
    issueId,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    descriptionLength: issue.description?.length ?? 0,
  });

  // Check if this issue was created by us (Trello→Paperclip flow)
  const existingMapping = await syncStore.getByIssueId(issueId);
  if (existingMapping) {
    // Already mapped — was created by the Trello→Paperclip flow, skip
    return;
  }

  // listIds required
  const listIds = config.listIds;
  if (!listIds) {
    ctx.logger.warn("trello-sync: createCardOnNewIssue enabled but listIds not configured");
    return;
  }

  const status = (issue.status as string) ?? "todo";
  const listId = listIds[status as keyof typeof listIds] ?? listIds["todo"] ?? listIds["backlog"];
  if (!listId) {
    ctx.logger.warn("trello-sync: no listId for status, skipping card creation", { status });
    return;
  }

  // Build label list from priority
  const idLabels: string[] = [];
  if (config.syncPriorityToTrello ?? true) {
    const labelId = getLabelIdForPriority(issue.priority, config.labelIds ?? {});
    if (labelId) idLabels.push(labelId);
  }

  let desc = (config.syncDescToTrello ?? true) ? (issue.description ?? "") : "";
  // Append sync tag to Trello description
  desc = appendSyncTag(desc, issueId);

  try {
    const card = await trello.createCard({
      idList: listId,
      name: issue.title,
      desc,
      idLabels,
    });

    await syncStore.setMapping(issueId, card.id, "paperclip", card.shortUrl);

    // Log link in Paperclip activity
    await ctx.activity.log({
      companyId,
      message: `🔗 Sincronizado con Trello: ${card.shortUrl}`,
      entityType: "issue",
      entityId: issueId,
    });

    await ctx.metrics.write("trello_sync.card.created", 1, { direction: "pc_to_trello" });
  } catch (err) {
    ctx.logger.error("trello-sync: failed to create Trello card", { issueId, err: String(err) });
    await deps.pendingQueue.enqueue("create-card", issueId, {
      issueId,
      listId,
      name: issue.title,
      desc,
      idLabels,
    });
    await ctx.metrics.write("trello_sync.error", 1, { type: "create_card" });
  }
}

export async function handleIssueUpdated(
  event: PluginEvent,
  deps: HandlerDeps,
): Promise<void> {
  const { ctx, trello, syncStore, config } = deps;
  const { companyId } = event;
  const issue = event.payload as Issue;
  const issueId = issue.id ?? event.entityId;

  if (!issueId) return;

  const mapping = await syncStore.getByIssueId(issueId);
  if (!mapping) return; // Not synced

  // Debounce: if this update originated from Trello, skip
  if (syncStore.isDebounced(mapping, DEBOUNCE_MS, "trello")) {
    await ctx.metrics.write("trello_sync.debounce.skipped", 1);
    return;
  }

  const cardId = mapping.trelloCardId;
  const patch: Record<string, unknown> = {};

  if (config.syncTitleToTrello ?? true) {
    patch.name = issue.title;
  }

  if (config.syncStatusToTrello ?? true) {
    const status = issue.status as string;
    const listId = config.listIds?.[status as keyof typeof config.listIds];
    if (listId) patch.idList = listId;
  }

  if (config.syncDescToTrello ?? true) {
    patch.desc = appendSyncTag(issue.description ?? "", issueId);
  }

  if (config.syncPriorityToTrello ?? true) {
    const labelId = getLabelIdForPriority(issue.priority, config.labelIds ?? {});
    // Replace our priority labels while keeping any user-added labels
    patch.idLabels = labelId ? [labelId] : [];
  }

  if (Object.keys(patch).length === 0) return;

  try {
    await trello.updateCard(cardId, patch as Parameters<typeof trello.updateCard>[1]);
    await syncStore.touchMapping(issueId, "paperclip");
    await ctx.metrics.write("trello_sync.card.updated", 1, { direction: "pc_to_trello" });
  } catch (err) {
    if (err instanceof TrelloNotFoundError) {
      ctx.logger.warn("trello-sync: card not found during update, removing mapping", { cardId, issueId });
      await syncStore.deleteMapping(issueId);
      await ctx.metrics.write("trello_sync.error", 1, { type: "card_not_found" });
      return;
    }
    ctx.logger.error("trello-sync: failed to update Trello card", { cardId, issueId, err: String(err) });
    await deps.pendingQueue.enqueue("update-card", cardId, { issueId, patch });
    await ctx.metrics.write("trello_sync.error", 1, { type: "update_card" });
  }
}

/** Appends a sync tag to a Trello card description. The tag is stripped before
 *  writing back to Paperclip to avoid contaminating the issue description. */
export function appendSyncTag(desc: string, issueId: string): string {
  const tag = `\n\n<!-- paperclip-trello-sync: {"issueId":"${issueId}"} -->`;
  // Remove any existing tag first
  const cleaned = desc.replace(/\n\n<!-- paperclip-trello-sync:.*?-->/s, "");
  return cleaned + tag;
}

/** Strips the sync tag from a Trello card description before storing in Paperclip. */
export function stripSyncTag(desc: string): string {
  return desc.replace(/\n\n<!-- paperclip-trello-sync:.*?-->/s, "").trimEnd();
}
