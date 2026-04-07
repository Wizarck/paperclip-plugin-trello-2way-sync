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
    "http.outbound",
    "jobs.schedule",
    "webhooks.receive",
    "metrics.write",
    "companies.read",
    "agents.read",
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
        title: "Trello API Key",
        description:
          "Your Trello API Key. Go to trello.com/power-ups/admin → your Power-Up → tab 'API Key'. If you don't have a Power-Up, create one (name only, no need to publish it).",
      },
      apiSecretRef: {
        type: "string",
        title: "Trello API Secret",
        description:
          "Your Trello API Secret (used to verify webhook signatures). On the same page as the API Key, click 'Generate a new secret'.",
      },
      tokenRef: {
        type: "string",
        title: "Trello Token",
        description:
          "Your Trello Token. Open this URL in your browser replacing YOUR_KEY with your API Key: https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_KEY — Trello will display the token directly.",
      },
      boardId: {
        type: "string",
        title: "Trello Board ID",
        description:
          "The ID of the Trello board to sync with. Open your board in Trello and add '.json' to the URL — the 'id' field at the top is your Board ID. On first activation, the plugin will automatically create 7 lists on this board (Pendiente, Por Hacer, En Progreso, En Revisión, Bloqueado, Completado, Cancelado) and 4 priority labels (Crítica, Alta, Media, Baja). These lists will be used for all sync operations — do not delete or rename them.",
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Public URL",
        description:
          "Public HTTPS URL of this Paperclip instance. Required only for Trello→Paperclip sync (card moves, renames, archives updating Paperclip issues). When set, the plugin automatically registers a webhook in Trello — no manual setup needed. The registered URL will be: {this_url}/api/plugins/trello-sync/webhooks/trello-events. Leave empty if you only need Paperclip→Trello sync. Example: https://paperclip.yourdomain.com",
      },

      defaultAssigneeAgentId: {
        type: "string",
        title: "Default Assignee Agent ID",
        description:
          "Agent ID to auto-assign to issues created from Trello cards, and used as fallback when moving issues to 'In Progress' (which requires an assignee). If left empty, the plugin auto-selects the first available agent. You can find agent IDs in Paperclip → Settings → Agents.",
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
