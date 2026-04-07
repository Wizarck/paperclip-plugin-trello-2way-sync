import type { PluginStateClient, PluginLogger } from "@paperclipai/plugin-sdk";
import type { TrelloClient } from "./trello-client.js";
import { STATE_KEYS } from "./constants.js";

export class WebhookRegistration {
  constructor(
    private readonly state: PluginStateClient,
    private readonly logger: PluginLogger,
    private readonly companyId: string,
  ) {}

  private scope() {
    return { scopeKind: "company" as const, scopeId: this.companyId };
  }

  async ensureRegistered(
    trello: TrelloClient,
    boardId: string,
    callbackUrl: string,
  ): Promise<string | null> {
    // Check stored webhook ID
    const storedId = (await this.state.get({
      ...this.scope(),
      stateKey: STATE_KEYS.webhookId,
    })) as string | null;

    if (storedId) {
      const existing = await trello.getWebhook(storedId);
      if (existing && existing.active && existing.callbackURL === callbackUrl) {
        return storedId;
      }
      // Stale — deregister and re-register
      if (existing) {
        try {
          await trello.deleteWebhook(storedId);
        } catch {
          // Ignore delete errors
        }
      }
    }

    // Register fresh webhook
    try {
      const webhook = await trello.registerWebhook(
        callbackUrl,
        boardId,
        "Paperclip Trello Sync",
      );
      await this.state.set(
        { ...this.scope(), stateKey: STATE_KEYS.webhookId },
        webhook.id,
      );
      this.logger.info("trello-sync: webhook registered", { webhookId: webhook.id, callbackUrl });
      return webhook.id;
    } catch (err) {
      this.logger.error("trello-sync: failed to register webhook", { err: String(err) });
      return null;
    }
  }

  async deregister(trello: TrelloClient): Promise<void> {
    const storedId = (await this.state.get({
      ...this.scope(),
      stateKey: STATE_KEYS.webhookId,
    })) as string | null;

    if (!storedId) return;

    try {
      await trello.deleteWebhook(storedId);
    } catch {
      // Ignore — webhook may already be gone
    }

    await this.state.delete({
      ...this.scope(),
      stateKey: STATE_KEYS.webhookId,
    });
    this.logger.info("trello-sync: webhook deregistered", { webhookId: storedId });
  }

  async checkExists(trello: TrelloClient, callbackUrl: string): Promise<boolean> {
    const storedId = (await this.state.get({
      ...this.scope(),
      stateKey: STATE_KEYS.webhookId,
    })) as string | null;

    if (!storedId) return false;
    const webhook = await trello.getWebhook(storedId);
    return webhook != null && webhook.active && webhook.callbackURL === callbackUrl;
  }
}
