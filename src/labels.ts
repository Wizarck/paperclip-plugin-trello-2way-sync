import type { PluginStateClient } from "@paperclipai/plugin-sdk";
import type { TrelloClient } from "./trello-client.js";
import type { TrelloSyncConfig } from "./types.js";
import { PRIORITY_KEYS, PRIORITY_COLORS, PRIORITY_LABEL_NAMES } from "./constants.js";

/**
 * Ensures the 4 priority labels exist on the board and returns a map of
 * priority → labelId. Creates labels if missing, updates name/color if they
 * differ from our expected values.
 */
export async function syncPriorityLabels(
  trello: TrelloClient,
  config: TrelloSyncConfig,
  state: PluginStateClient,
  companyId: string,
): Promise<Record<string, string>> {
  const boardLabels = await trello.getBoardLabels(config.boardId);
  const labelIds: Record<string, string> = { ...config.labelIds };

  for (const priority of PRIORITY_KEYS) {
    const expectedName = PRIORITY_LABEL_NAMES[priority];
    const expectedColor = PRIORITY_COLORS[priority];
    const existingId = labelIds[priority];

    if (existingId) {
      // Verify it still exists on this board with correct name/color
      const existing = boardLabels.find((l) => l.id === existingId);
      if (existing) {
        if (existing.name !== expectedName || existing.color !== expectedColor) {
          await trello.updateLabel(existingId, {
            name: expectedName,
            color: expectedColor,
          });
        }
        continue;
      }
    }

    // Find by name+color among existing board labels
    const match = boardLabels.find(
      (l) => l.name === expectedName && l.color === expectedColor,
    );
    if (match) {
      labelIds[priority] = match.id;
      continue;
    }

    // Create new label
    const created = await trello.createLabel(
      config.boardId,
      expectedName,
      expectedColor,
    );
    labelIds[priority] = created.id;
  }

  return labelIds;
}

/**
 * Given a Paperclip priority string, returns the corresponding Trello label ID
 * from the config's labelIds map. Returns undefined if not mapped.
 */
export function getLabelIdForPriority(
  priority: string | undefined | null,
  labelIds: Partial<Record<string, string>>,
): string | undefined {
  if (!priority) return undefined;
  return labelIds[priority];
}

/**
 * Given a list of Trello label IDs on a card, returns the Paperclip priority
 * that matches one of our known priority labels. Returns undefined if none match.
 */
export function getPriorityFromLabelIds(
  cardLabelIds: string[],
  labelIds: Partial<Record<string, string>>,
): string | undefined {
  const reversed = Object.entries(labelIds).find(([, id]) =>
    cardLabelIds.includes(id!),
  );
  return reversed?.[0];
}
