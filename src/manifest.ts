import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, WEBHOOK_KEY } from "./constants.js";

export const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Trello Sync",
  description:
    "Two-way sync between Paperclip issues and Trello cards with configurable list mapping, priority labels, and feature toggles.",
  author: "paperclipai",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.create",
    "issues.update",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "http.outbound",
    "jobs.schedule",
    "webhooks.receive",
    "metrics.write",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["apiKeyRef", "apiSecretRef", "tokenRef", "boardId"],
    properties: {
      // Credentials
      apiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "Trello API Key",
        description:
          "Your Trello API Key from trello.com/app-key",
      },
      apiSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Trello API Secret",
        description:
          "Your Trello API Secret (for webhook HMAC verification). Generate it at trello.com/app-key → 'Generate a new secret'.",
      },
      tokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Trello Token",
        description:
          "Your Trello Token from trello.com/app-key → 'Generate a Token'.",
      },
      boardId: {
        type: "string",
        title: "Trello Board ID",
        description:
          "The ID of the Trello board to sync with. Use the 'Get my boards' bridge data to select a board.",
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Public URL",
        description:
          "Public HTTPS URL of this Paperclip instance (required for Trello→Paperclip sync via webhooks). Example: https://paperclip.yourdomain.com",
      },

      // List names used when auto-creating lists
      listNames: {
        type: "object",
        title: "Trello List Names",
        description: "Names for the Trello lists (created automatically by the 'Create default lists' action).",
        properties: {
          backlog: { type: "string", default: "Pendiente", title: "Backlog" },
          todo: { type: "string", default: "Por Hacer", title: "To Do" },
          in_progress: { type: "string", default: "En Progreso", title: "In Progress" },
          in_review: { type: "string", default: "En Revisión", title: "In Review" },
          blocked: { type: "string", default: "Bloqueado", title: "Blocked" },
          done: { type: "string", default: "Completado", title: "Done" },
          cancelled: { type: "string", default: "Cancelado", title: "Cancelled" },
        },
      },

      // Auto-filled by bridge action "createDefaultLists"
      listIds: {
        type: "object",
        title: "Trello List IDs (auto-filled)",
        description: "Filled automatically by the 'Create default lists' action. You can also set them manually.",
        properties: {
          backlog: { type: "string", title: "Backlog list ID" },
          todo: { type: "string", title: "To Do list ID" },
          in_progress: { type: "string", title: "In Progress list ID" },
          in_review: { type: "string", title: "In Review list ID" },
          blocked: { type: "string", title: "Blocked list ID" },
          done: { type: "string", title: "Done list ID" },
          cancelled: { type: "string", title: "Cancelled list ID" },
        },
      },
      labelIds: {
        type: "object",
        title: "Trello Priority Label IDs (auto-filled)",
        description: "Filled automatically by the 'Create default lists' action.",
        properties: {
          urgent: { type: "string", title: "Urgent label ID (red)" },
          high: { type: "string", title: "High label ID (orange)" },
          medium: { type: "string", title: "Medium label ID (yellow)" },
          low: { type: "string", title: "Low label ID (green)" },
        },
      },

      // Feature toggles — Paperclip → Trello
      createCardOnNewIssue: {
        type: "boolean",
        default: true,
        title: "Create Trello card when issue is created in Paperclip",
      },
      syncStatusToTrello: {
        type: "boolean",
        default: true,
        title: "Move Trello card when issue status changes in Paperclip",
      },
      syncTitleToTrello: {
        type: "boolean",
        default: true,
        title: "Update Trello card name when issue title changes in Paperclip",
      },
      syncDescToTrello: {
        type: "boolean",
        default: true,
        title: "Sync description from Paperclip → Trello",
      },
      syncPriorityToTrello: {
        type: "boolean",
        default: true,
        title: "Sync priority as a colored Trello label (4 colors)",
      },

      // Feature toggles — Trello → Paperclip (require paperclipBaseUrl)
      createIssueOnNewCard: {
        type: "boolean",
        default: false,
        title: "Create Paperclip issue when a card is created in Trello (requires public URL)",
      },
      syncStatusToPaperclip: {
        type: "boolean",
        default: false,
        title: "Update Paperclip issue status when card is moved in Trello (requires public URL)",
      },
      syncTitleToPaperclip: {
        type: "boolean",
        default: false,
        title: "Update Paperclip issue title when Trello card is renamed (requires public URL)",
      },
      syncDescToPaperclip: {
        type: "boolean",
        default: false,
        title: "Sync description from Trello → Paperclip (requires public URL)",
      },
      syncPriorityToPaperclip: {
        type: "boolean",
        default: false,
        title: "Update Paperclip priority when Trello label changes (requires public URL)",
      },
      cancelOnCardArchive: {
        type: "boolean",
        default: false,
        title: "Cancel Paperclip issue when Trello card is archived (requires public URL)",
      },
    },
  },
  jobs: [
    {
      jobKey: "reconcile",
      schedule: "0 6 * * *",
      displayName: "Daily reconciliation",
      description:
        "Detects and fixes drift between Paperclip issues and Trello cards.",
    },
    {
      jobKey: "check-webhook-health",
      schedule: "0 */6 * * *",
      displayName: "Webhook health check",
      description:
        "Verifies that the Trello webhook is registered and re-registers it if missing.",
    },
    {
      jobKey: "process-pending",
      schedule: "*/5 * * * *",
      displayName: "Process pending syncs",
      description:
        "Retries failed sync operations from the pending queue.",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEY,
      displayName: "Trello Webhook Events",
      description:
        "Receives Trello board events (card create/update/archive/delete). Register this URL in Trello or use the 'Test connection' button.",
    },
  ],
};

export default manifest;
