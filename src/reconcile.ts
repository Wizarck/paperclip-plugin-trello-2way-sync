import type { PluginContext, Issue } from "@paperclipai/plugin-sdk";
import type { TrelloSyncConfig } from "./types.js";
import type { TrelloClient } from "./trello-client.js";
import type { SyncStore } from "./sync-store.js";
import { appendSyncTag } from "./event-handlers.js";
import { getLabelIdForPriority } from "./labels.js";
import { STATE_KEYS } from "./constants.js";
import { TrelloNotFoundError } from "./trello-client.js";

export async function reconcileAllIssues(
  ctx: PluginContext,
  trello: TrelloClient,
  syncStore: SyncStore,
  config: TrelloSyncConfig,
  companyId: string,
): Promise<void> {
  const limit = 100;
  let offset = 0;
  let driftCount = 0;

  while (true) {
    const issues = await ctx.issues.list({ companyId, limit, offset });
    if (issues.length === 0) break;

    for (const issue of issues) {
      const hadDrift = await reconcileIssue(ctx, trello, syncStore, config, companyId, issue);
      if (hadDrift) driftCount++;
    }

    if (issues.length < limit) break;
    offset += limit;
  }

  // Record last reconcile timestamp
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.lastReconcileAt },
    new Date().toISOString(),
  );

  await ctx.metrics.write("trello_sync.reconcile.drift", driftCount);
  ctx.logger.info("trello-sync: reconcile complete", { driftCount, offset });
}

async function reconcileIssue(
  ctx: PluginContext,
  trello: TrelloClient,
  syncStore: SyncStore,
  config: TrelloSyncConfig,
  companyId: string,
  issue: Issue,
): Promise<boolean> {
  const issueId = issue.id;
  const mapping = await syncStore.getByIssueId(issueId);

  if (!mapping) {
    // No mapping → create card if toggle enabled
    if (!(config.createCardOnNewIssue ?? true)) return false;
    if (!config.listIds) return false;

    const status = (issue.status as string) ?? "todo";
    const listId =
      config.listIds[status as keyof typeof config.listIds] ??
      config.listIds["todo"] ??
      config.listIds["backlog"];
    if (!listId) return false;

    const idLabels: string[] = [];
    if (config.syncPriorityToTrello ?? true) {
      const labelId = getLabelIdForPriority(issue.priority, config.labelIds ?? {});
      if (labelId) idLabels.push(labelId);
    }

    try {
      const card = await trello.createCard({
        idList: listId,
        name: issue.title,
        desc: appendSyncTag(issue.description ?? "", issueId),
        idLabels,
      });
      await syncStore.setMapping(issueId, card.id, "paperclip", card.shortUrl);
      await ctx.activity.log({
        companyId,
        message: `🔗 Sincronizado con Trello (reconcile): ${card.shortUrl}`,
        entityType: "issue",
        entityId: issueId,
      });
      return true;
    } catch (err) {
      ctx.logger.warn("trello-sync: reconcile failed to create card", { issueId, err: String(err) });
      return false;
    }
  }

  // Mapping exists — verify card still exists
  const cardId = mapping.trelloCardId;
  try {
    const card = await trello.getCard(cardId);

    // Verify card is in the right list
    if (config.syncStatusToTrello ?? true) {
      const status = (issue.status as string) ?? "todo";
      const expectedListId = config.listIds?.[status as keyof typeof config.listIds];
      if (expectedListId && card.idList !== expectedListId) {
        await trello.updateCard(cardId, { idList: expectedListId });
        await syncStore.touchMapping(issueId, "paperclip");
        return true;
      }
    }
    return false;
  } catch (err) {
    if (err instanceof TrelloNotFoundError) {
      ctx.logger.warn("trello-sync: reconcile found stale mapping, removing", { issueId, cardId });
      await syncStore.deleteMapping(issueId);
      return true;
    }
    throw err;
  }
}
