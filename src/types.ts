import type { StatusKey, PriorityKey } from "./constants.js";

export interface TrelloSyncConfig {
  // Credentials
  apiKeyRef: string;
  apiSecretRef: string;
  tokenRef: string;
  boardId: string;
  paperclipBaseUrl?: string;
  defaultAssigneeAgentId?: string;

  // List names (used for auto-create)
  listNames?: Partial<Record<StatusKey, string>>;

  // IDs auto-filled by bridge action "createDefaultLists"
  listIds?: Partial<Record<StatusKey, string>>;
  labelIds?: Partial<Record<PriorityKey, string>>;

  // Feature toggles — Paperclip → Trello
  createCardOnNewIssue?: boolean;
  syncStatusToTrello?: boolean;
  syncTitleToTrello?: boolean;
  syncDescToTrello?: boolean;
  syncPriorityToTrello?: boolean;

  // Feature toggles — Trello → Paperclip (require paperclipBaseUrl)
  createIssueOnNewCard?: boolean;
  syncStatusToPaperclip?: boolean;
  syncTitleToPaperclip?: boolean;
  syncDescToPaperclip?: boolean;
  syncPriorityToPaperclip?: boolean;
  cancelOnCardArchive?: boolean;
}

export interface CardMapping {
  trelloCardId: string;
  trelloCardUrl?: string;
  lastSyncedAt: number;
  lastSyncedBy: "paperclip" | "trello";
}

// Trello API types
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idBoard: string;
  idLabels: string[];
  url: string;
  shortUrl: string;
  closed: boolean;
}

export interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
  closed: boolean;
  pos: number;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
  idBoard: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  shortUrl: string;
  closed: boolean;
}

export interface TrelloWebhook {
  id: string;
  description: string;
  idModel: string;
  callbackURL: string;
  active: boolean;
}

export interface TrelloTokenPermissions {
  idMember: string;
  dateCreated: string;
  dateExpires: string | null;
  permissions: Array<{
    idModel: string;
    modelType: string;
    read: boolean;
    write: boolean;
  }>;
}

export interface TrelloAction {
  id: string;
  type: string;
  date: string;
  memberCreator?: {
    id: string;
    username: string;
    fullName: string;
  };
  data: {
    card?: {
      id: string;
      name: string;
      desc?: string;
      idList?: string;
      closed?: boolean;
      idLabels?: string[];
    };
    listAfter?: {
      id: string;
      name: string;
    };
    listBefore?: {
      id: string;
      name: string;
    };
    list?: {
      id: string;
      name: string;
    };
    board?: {
      id: string;
      name: string;
    };
    old?: {
      name?: string;
      desc?: string;
      idList?: string;
      closed?: boolean;
      idLabels?: string[];
    };
  };
}

export interface PendingOperation {
  op: "create-card" | "update-card" | "create-issue" | "update-issue";
  id: string;
  data: Record<string, unknown>;
  attempts: number;
  createdAt: number;
}
