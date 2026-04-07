export const PLUGIN_ID = "trello-sync";
export const WEBHOOK_KEY = "trello-events";
export const DEBOUNCE_MS = 10_000;

// State key builders
export const STATE_KEYS = {
  mapByIssue: (issueId: string) => `map:pc:${issueId}`,
  mapByCard: (cardId: string) => `map:tr:${cardId}`,
  seenAction: (actionId: string) => `seen:${actionId}`,
  configuredBoardId: "configured:boardId",
  webhookId: "webhook:id",
  initialSyncState: "initialSyncState",
  lastReconcileAt: "lastReconcileAt",
  lastError: "lastError",
  autoListIds: "auto:listIds",
  autoLabelIds: "auto:labelIds",
  pending: (op: string, id: string) => `pending:${op}:${id}`,
} as const;

export const STATUS_KEYS = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;

export type StatusKey = (typeof STATUS_KEYS)[number];

// Map from Paperclip status → Trello list config key
export const STATUS_MAP: Record<string, StatusKey> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in_progress",
  in_review: "in_review",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

// Reverse map: list config key → Paperclip status
export const REVERSE_STATUS_MAP: Record<StatusKey, string> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in_progress",
  in_review: "in_review",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

export const DEFAULT_LIST_NAMES: Record<StatusKey, string> = {
  backlog: "Pendiente",
  todo: "Por Hacer",
  in_progress: "En Progreso",
  in_review: "En Revisión",
  blocked: "Bloqueado",
  done: "Completado",
  cancelled: "Cancelado",
};

export const PRIORITY_COLORS: Record<string, string> = {
  urgent: "red",
  high: "orange",
  medium: "yellow",
  low: "green",
};

export const PRIORITY_LABEL_NAMES: Record<string, string> = {
  urgent: "Urgente",
  high: "Alta",
  medium: "Media",
  low: "Baja",
};

export const PRIORITY_KEYS = ["urgent", "high", "medium", "low"] as const;
export type PriorityKey = (typeof PRIORITY_KEYS)[number];

export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_PENDING_ATTEMPTS = 5;
export const ACTION_SEEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
