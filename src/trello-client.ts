import type {
  TrelloCard,
  TrelloList,
  TrelloLabel,
  TrelloBoard,
  TrelloWebhook,
  TrelloTokenPermissions,
} from "./types.js";
import { MAX_RETRY_ATTEMPTS } from "./constants.js";

export class TrelloAuthError extends Error {
  constructor() {
    super("Trello authentication failed (401). Check your API Key and Token.");
    this.name = "TrelloAuthError";
  }
}

export class TrelloNotFoundError extends Error {
  constructor(path: string) {
    super(`Trello resource not found: ${path}`);
    this.name = "TrelloNotFoundError";
  }
}

export class TrelloApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Trello API error ${status}: ${message}`);
    this.name = "TrelloApiError";
  }
}

export class TrelloNetworkError extends Error {
  constructor(message: string) {
    super(`Trello network error: ${message}`);
    this.name = "TrelloNetworkError";
  }
}

export class TrelloClient {
  private readonly apiKey: string;
  private readonly token: string;
  private readonly baseUrl = "https://api.trello.com/1";

  constructor(apiKey: string, token: string) {
    this.apiKey = apiKey;
    this.token = token;
  }

  private authParams(): string {
    return `key=${encodeURIComponent(this.apiKey)}&token=${encodeURIComponent(this.token)}`;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}?${this.authParams()}`;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          body: body != null ? JSON.stringify(body) : undefined,
          headers:
            body != null
              ? { "Content-Type": "application/json" }
              : undefined,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new TrelloNetworkError(String(err));
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? 30);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      if (res.status === 401) throw new TrelloAuthError();
      if (res.status === 404) throw new TrelloNotFoundError(path);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status >= 500 && attempt < MAX_RETRY_ATTEMPTS - 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new TrelloApiError(res.status, text);
      }

      return res.json() as Promise<T>;
    }

    throw new TrelloNetworkError("Max retries exceeded");
  }

  // ─── Cards ────────────────────────────────────────────────────────────────

  async createCard(input: {
    idList: string;
    name: string;
    desc?: string;
    idLabels?: string[];
  }): Promise<TrelloCard> {
    return this.request<TrelloCard>("POST", "/cards", {
      idList: input.idList,
      name: input.name,
      desc: input.desc ?? "",
      idLabels: input.idLabels ?? [],
    });
  }

  async updateCard(
    cardId: string,
    patch: {
      name?: string;
      desc?: string;
      idList?: string;
      idLabels?: string[];
      closed?: boolean;
    },
  ): Promise<TrelloCard> {
    return this.request<TrelloCard>("PUT", `/cards/${cardId}`, patch);
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>("GET", `/cards/${cardId}`);
  }

  // ─── Lists ────────────────────────────────────────────────────────────────

  async getList(listId: string): Promise<TrelloList> {
    return this.request<TrelloList>("GET", `/lists/${listId}`);
  }

  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return this.request<TrelloList[]>("GET", `/boards/${boardId}/lists`, {
      filter: "open",
    } as Record<string, unknown>);
  }

  async createList(boardId: string, name: string, pos?: string): Promise<TrelloList> {
    return this.request<TrelloList>("POST", "/lists", {
      idBoard: boardId,
      name,
      pos: pos ?? "bottom",
    });
  }

  // ─── Labels ───────────────────────────────────────────────────────────────

  async getBoardLabels(boardId: string): Promise<TrelloLabel[]> {
    return this.request<TrelloLabel[]>("GET", `/boards/${boardId}/labels`);
  }

  async createLabel(boardId: string, name: string, color: string): Promise<TrelloLabel> {
    return this.request<TrelloLabel>("POST", "/labels", {
      idBoard: boardId,
      name,
      color,
    });
  }

  async updateLabel(labelId: string, patch: { name?: string; color?: string }): Promise<TrelloLabel> {
    return this.request<TrelloLabel>("PUT", `/labels/${labelId}`, patch);
  }

  // ─── Boards ───────────────────────────────────────────────────────────────

  async getMyBoards(): Promise<TrelloBoard[]> {
    return this.request<TrelloBoard[]>("GET", "/members/me/boards", {
      filter: "open",
      fields: "id,name,url,shortUrl,closed",
    } as Record<string, unknown>);
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  async registerWebhook(
    callbackUrl: string,
    boardId: string,
    description?: string,
  ): Promise<TrelloWebhook> {
    return this.request<TrelloWebhook>("POST", "/webhooks", {
      callbackURL: callbackUrl,
      idModel: boardId,
      description: description ?? "Paperclip Trello Sync",
      active: true,
    });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/webhooks/${webhookId}`);
  }

  async getWebhooksForToken(): Promise<TrelloWebhook[]> {
    return this.request<TrelloWebhook[]>("GET", `/tokens/${this.token}/webhooks`);
  }

  async getWebhook(webhookId: string): Promise<TrelloWebhook | null> {
    try {
      return await this.request<TrelloWebhook>("GET", `/webhooks/${webhookId}`);
    } catch (err) {
      if (err instanceof TrelloNotFoundError) return null;
      throw err;
    }
  }

  // ─── Validation ───────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/members/me", {
        fields: "id",
      } as Record<string, unknown>);
      return true;
    } catch {
      return false;
    }
  }

  async getTokenPermissions(): Promise<TrelloTokenPermissions> {
    return this.request<TrelloTokenPermissions>(
      "GET",
      `/tokens/${this.token}`,
      { fields: "permissions,dateExpires" } as Record<string, unknown>,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
