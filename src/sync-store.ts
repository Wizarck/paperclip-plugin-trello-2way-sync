import type { PluginStateClient } from "@paperclipai/plugin-sdk";
import type { CardMapping } from "./types.js";
import { STATE_KEYS } from "./constants.js";

/**
 * Manages the bidirectional mapping between Paperclip issue IDs and Trello card IDs.
 *
 * Two state entries are maintained per mapping (for fast lookup in both directions):
 *   map:pc:{issueId}  → CardMapping
 *   map:tr:{cardId}   → issueId (string)
 */
export class SyncStore {
  constructor(
    private readonly state: PluginStateClient,
    private readonly companyId: string,
  ) {}

  private scope() {
    return { scopeKind: "company" as const, scopeId: this.companyId };
  }

  async getByIssueId(issueId: string): Promise<CardMapping | null> {
    const raw = await this.state.get({
      ...this.scope(),
      stateKey: STATE_KEYS.mapByIssue(issueId),
    });
    if (!raw) return null;
    return raw as CardMapping;
  }

  async getByCardId(cardId: string): Promise<string | null> {
    const raw = await this.state.get({
      ...this.scope(),
      stateKey: STATE_KEYS.mapByCard(cardId),
    });
    if (!raw) return null;
    return raw as string;
  }

  async setMapping(
    issueId: string,
    cardId: string,
    syncedBy: CardMapping["lastSyncedBy"],
    cardUrl?: string,
  ): Promise<void> {
    const mapping: CardMapping = {
      trelloCardId: cardId,
      trelloCardUrl: cardUrl,
      lastSyncedAt: Date.now(),
      lastSyncedBy: syncedBy,
    };
    await Promise.all([
      this.state.set(
        { ...this.scope(), stateKey: STATE_KEYS.mapByIssue(issueId) },
        mapping,
      ),
      this.state.set(
        { ...this.scope(), stateKey: STATE_KEYS.mapByCard(cardId) },
        issueId,
      ),
    ]);
  }

  async touchMapping(issueId: string, syncedBy: CardMapping["lastSyncedBy"]): Promise<void> {
    const existing = await this.getByIssueId(issueId);
    if (!existing) return;
    const updated: CardMapping = {
      ...existing,
      lastSyncedAt: Date.now(),
      lastSyncedBy: syncedBy,
    };
    await this.state.set(
      { ...this.scope(), stateKey: STATE_KEYS.mapByIssue(issueId) },
      updated,
    );
  }

  async deleteMapping(issueId: string): Promise<void> {
    const mapping = await this.getByIssueId(issueId);
    if (!mapping) return;
    await Promise.all([
      this.state.delete({
        ...this.scope(),
        stateKey: STATE_KEYS.mapByIssue(issueId),
      }),
      this.state.delete({
        ...this.scope(),
        stateKey: STATE_KEYS.mapByCard(mapping.trelloCardId),
      }),
    ]);
  }

  async deleteMappingByCardId(cardId: string): Promise<void> {
    const issueId = await this.getByCardId(cardId);
    if (!issueId) return;
    await this.deleteMapping(issueId);
  }

  /**
   * Clears all mappings for this company (used when boardId changes).
   * NOTE: The plugin-sdk PluginStateClient does not expose a list/scan API,
   * so this method removes mappings that are passed in explicitly (used during
   * reconcile cleanup). For a full clear, call clearAllMappings with the list
   * obtained from listAllMappings().
   */
  async clearAllMappings(issueIds: string[]): Promise<void> {
    await Promise.all(issueIds.map((id) => this.deleteMapping(id)));
  }

  // Convenience: check if a mapping is recent enough to debounce
  isDebounced(mapping: CardMapping, debounceMs: number, origin: CardMapping["lastSyncedBy"]): boolean {
    if (mapping.lastSyncedBy !== origin) return false;
    return Date.now() - mapping.lastSyncedAt < debounceMs;
  }
}
