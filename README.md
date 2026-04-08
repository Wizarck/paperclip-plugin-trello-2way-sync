# paperclip-plugin-trello-sync

Two-way sync between [Paperclip](https://paperclipai.com) issues and Trello cards.

## Features

- Creates a Trello card automatically when a Paperclip issue is created
- Moves the card between lists when the issue status changes
- Syncs title, description, and priority (as colored labels)
- Optionally syncs changes back from Trello to Paperclip (requires a public URL)
- Automatic webhook registration — no manual Trello setup needed
- Auto-assigns new unassigned issues to a configurable Dispatcher agent

## Setup

### 1. Get your Trello credentials

You need three values from Trello:

**API Key**
Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin) → your Power-Up → tab **"API Key"**.
If you don't have a Power-Up yet, create one (only a name is required — no need to publish it).

**API Secret**
On the same page as the API Key, click **"Generate a new secret"**.
This is used to verify webhook signatures — keep it private.

**Token**
Open this URL in your browser, replacing `YOUR_KEY` with your API Key:
```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_KEY
```
Trello will display the token directly on the page. Copy the full string.

### 2. Get your Board ID

Open your Trello board and add `.json` to the URL:
```
https://trello.com/b/XXXXXXXX/board-name.json
```
The `"id"` field at the top of the JSON is your Board ID.

### 3. Configure the plugin

In Paperclip → Settings → Plugins → Trello Sync, fill in:

| Field | Value |
|---|---|
| Trello API Key | From step 1 |
| Trello API Secret | From step 1 |
| Trello Token | From step 1 |
| Trello Board ID | From step 2 |
| Paperclip Public URL | Only needed for Trello→Paperclip sync (see below) |

### 4. Automatic list and label creation

On first activation, the plugin automatically creates **7 lists** and **4 priority labels** on your board:

| Paperclip status | Trello list |
|---|---|
| Backlog | Pendiente |
| To Do | Por Hacer |
| In Progress | En Progreso |
| In Review | En Revisión |
| Blocked | Bloqueado |
| Done | Completado |
| Cancelled | Cancelado |

| Paperclip priority | Trello label | Color |
|---|---|---|
| Critical | Crítica | 🔴 Red |
| High | Alta | 🟠 Orange |
| Medium | Media | 🟡 Yellow |
| Low | Baja | 🟢 Green |

> **Do not rename or delete these lists.** The plugin uses them for all sync operations.

## Dispatcher agent (auto-assign)

Paperclip requires issues to have an assignee before they can be moved to **In Progress**. To handle issues created without an assignee, the plugin supports a Dispatcher agent:

1. Create an agent in Paperclip with **"Dispatcher"** in its name (e.g. "Dispatcher", "Task Dispatcher")
2. Restart the plugin — it will automatically detect the agent by name and store its ID

From that point on, any new issue created without an assignee is automatically assigned to the Dispatcher. This ensures issues can always be moved to In Progress without errors.

The Dispatcher agent is re-detected on every plugin restart, so if you rename or recreate it, just restart the plugin to pick up the change.

> If no Dispatcher agent is found, unassigned issues are left as-is.

## Trello→Paperclip sync (optional)

To receive updates from Trello back into Paperclip, the plugin needs a public HTTPS URL so Trello can send webhook events.

Set **"Paperclip Public URL"** to your instance's public address (e.g. `https://paperclip.yourdomain.com`).

The plugin will automatically register a webhook in Trello. The registered callback URL is:
```
https://paperclip.yourdomain.com/api/plugins/trello-sync/webhooks/trello-events
```

No manual setup is required in Trello. The plugin also runs a health check every 6 hours and re-registers the webhook if it was removed.

Once configured, enable any of the Trello→Paperclip toggles:
- Update issue status when card is moved between lists
- Update issue title when card is renamed
- Sync description from Trello to Paperclip
- Update issue priority when label changes
- Cancel issue when card is archived

> When a card is moved to **En Progreso** from Trello and the issue has no assignee, the plugin automatically assigns the Dispatcher and retries the status update.

## Scheduled jobs

| Job | Schedule | Description |
|---|---|---|
| Daily reconciliation | 06:00 daily | Detects and fixes drift between Paperclip and Trello |
| Webhook health check | Every 6 hours | Re-registers webhook if missing |
| Process pending syncs | Every 5 minutes | Retries failed operations |

## Exposing Paperclip publicly (Cloudflare Tunnel)

If your Paperclip instance runs locally or on a private network, use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose it:

```bash
# Install
winget install Cloudflare.cloudflared   # Windows
brew install cloudflared                # macOS

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create paperclip

# Route your domain
cloudflared tunnel route dns paperclip paperclip.yourdomain.com

# Run
cloudflared tunnel run paperclip
```

Then set `paperclipBaseUrl` to `https://paperclip.yourdomain.com`.
