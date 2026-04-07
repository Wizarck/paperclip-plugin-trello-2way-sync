import type { PluginStateClient } from "@paperclipai/plugin-sdk";
import type { PendingOperation } from "./types.js";
import { STATE_KEYS, MAX_PENDING_ATTEMPTS } from "./constants.js";

export class PendingQueue {
  constructor(
    private readonly state: PluginStateClient,
    private readonly companyId: string,
  ) {}

  private scope() {
    return { scopeKind: "company" as const, scopeId: this.companyId };
  }

  async enqueue(
    op: PendingOperation["op"],
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const key = STATE_KEYS.pending(op, id);
    const existing = (await this.state.get({
      ...this.scope(),
      stateKey: key,
    })) as PendingOperation | null;

    const attempts = existing?.attempts ?? 0;
    if (attempts >= MAX_PENDING_ATTEMPTS) {
      // Dead letter — do not enqueue again
      return;
    }

    const entry: PendingOperation = {
      op,
      id,
      data,
      attempts,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await this.state.set({ ...this.scope(), stateKey: key }, entry);
  }

  async ack(op: PendingOperation["op"], id: string): Promise<void> {
    await this.state.delete({
      ...this.scope(),
      stateKey: STATE_KEYS.pending(op, id),
    });
  }

  async incrementAttempts(op: PendingOperation["op"], id: string): Promise<void> {
    const key = STATE_KEYS.pending(op, id);
    const existing = (await this.state.get({
      ...this.scope(),
      stateKey: key,
    })) as PendingOperation | null;
    if (!existing) return;
    await this.state.set(
      { ...this.scope(), stateKey: key },
      { ...existing, attempts: existing.attempts + 1 },
    );
  }
}
