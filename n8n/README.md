# IntelSquad + n8n automation

Two n8n workflows that work with the IntelSquad API:

| File | What it does |
|---|---|
| `IntelSquad - Events.json` | Receives every IntelSquad event. **Team alerts** on Telegram, a **log row** in Google Sheets for every event, and an **AI summary** (Claude) of new public PDS, saved back into IntelSquad as an internal team note. |
| `IntelSquad - Reports.json` | Every day at 09:00 (India time) a **daily report** on Telegram and in Google Sheets. On Mondays the **weekly report** is sent too. |

`build_n8n.py` regenerates both JSON files if you change them in code.

## How it fits together

```
IntelSquad API ──POST event (X-IntelSquad-Token)──▶ n8n "Events" webhook
                                                     ├─▶ Telegram team alert
                                                     ├─▶ Google Sheets "Events" row
                                                     └─▶ GET /api/integrations/pds/:code ─▶ Claude ─▶ POST .../summary (team note) + Telegram

n8n "Reports" (09:00 daily) ──GET /api/integrations/report?period=daily|weekly──▶ Telegram + Google Sheets "Reports" row
```

**Events sent by IntelSquad:**

| Event | When |
|---|---|
| `pds.submitted` | A user submits a PDS. Includes the problem text. |
| `pds.status_changed` | Any status change, e.g. Under Review, Need More Info, Approved, Scheduled (with team and dates), In Development, Delivered, Closed (with rating), Rejected, Withdrawn. |
| `comment.created` | A new comment or reply. |
| `comment.reported` | A comment is reported as spam or abuse. |
| `pds.assigned` | An admin assigns a team member. |
| `pds.progress` | A progress update (logged; no alert by default). |

**Privacy:** events and the API never include email, mobile number or full name, only display names, as on the public board. The AI step skips **private** PDS unless you turn on `ai_private` in the Settings node.

## Setup (about 20 minutes)

### 1. Make three secrets

Run this three times and keep the three values:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- `WEBHOOK_SECRET`: IntelSquad sends it to n8n.
- `API_TOKEN`: n8n sends it to IntelSquad.
- The third is spare. Never reuse `JWT_SECRET`, `ENCRYPTION_KEY` or `HMAC_KEY`.

### 2. Import the workflows into n8n

n8n → **Workflows → Import from file**, once for each JSON file.

### 3. Create the credentials in n8n

| Credential (type) | Fields |
|---|---|
| **IntelSquad webhook secret** (*Header Auth*) | Name `X-IntelSquad-Token`, Value = `WEBHOOK_SECRET` |
| **IntelSquad API token** (*Header Auth*) | Name `Authorization`, Value = `Bearer ` + `API_TOKEN` |
| **Anthropic API key** (*Header Auth*) | Name `x-api-key`, Value = your key from console.anthropic.com |
| **Telegram IntelSquad bot** (*Telegram API*) | Bot token from @BotFather |
| **Google Sheets account** (*Google Sheets OAuth2*) | Sign in with Google |

Open each node that shows a warning and pick the matching credential:
- The webhook node uses the webhook secret.
- **Get PDS and comments**, **Save summary to IntelSquad** and **Get report** use the API token.
- **Claude summary** uses the Anthropic key.

### 4. Telegram

1. Create a bot with **@BotFather** and copy its token.
2. Add the bot to your team's group and send any message in the group.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`. Group IDs start with `-`.
4. Paste it as `chat_id` in the **Settings** node (Events) and the **Report settings** node (Reports).

### 5. Google Sheet

Create a Google Sheet with two tabs and these header rows in row 1:

- **Events:** `Time | Event | PDS | Title | Type | Urgency | Visibility | Status | From | Note | Owner | Assigned to | Upvotes | Comments | Link`
- **Reports:** `Date | Period | New PDS | Approved | Rejected | Delivered | Closed | Comments | New users | Overdue reviews | In development | Waiting for slot | Open reports | Teams busy | Teams free | Avg rating`

Paste the sheet URL into both Google Sheets nodes (the **Document** field).

### 6. Connect IntelSquad (Railway → backend service → Variables)

```
N8N_WEBHOOK_URL=https://<your-n8n>/webhook/intelsquad
N8N_WEBHOOK_SECRET=<WEBHOOK_SECRET>
N8N_API_TOKEN=<API_TOKEN>
```

The webhook URL is the **Production URL** shown on the n8n webhook node, which only works once the workflow is **active**. Also check that `PUBLIC_URL` on Railway is your live site address, because alert links use it. Redeploy the backend after changing variables.

### 7. Test, then activate

1. In n8n, open **Events** → **Execute workflow** (listens once) and submit a test PDS in IntelSquad. You should get a Telegram alert, a sheet row and, a few seconds later, an AI summary. The summary also appears under **Internal notes** on the admin PDS page, marked *Automation*.
2. Open **Reports** → **Execute workflow** to send a report now.
3. Switch both workflows to **Active**.

## Changing behaviour

All options are in the **Settings** node of the Events workflow:

| Option | Default | Meaning |
|---|---|---|
| `alert_events` | submitted, status, comment, report, assigned | Which events alert on Telegram (all are logged to the sheet) |
| `comment_alerts` | `owner_and_team` | `all`, `owner_and_team` or `none` |
| `ai_on_submit` | `true` | Summarise each new public PDS |
| `ai_comment_milestones` | `[3, 10, 25]` | Summarise again when the comment count reaches these numbers |
| `ai_private` | `false` | Also send **private** PDS to the AI |

Report time: change the cron in **Every day 09:00** (`0 9 * * *`). Weekly day: `weekly_on` in **Report settings** (1 = Monday).

AI model: `claude-opus-5-5` at low effort, with Anthropic's automatic fallback turned on (`fallbacks: "default"`), so a declined request is retried on another model. Change it in **Build AI prompt**.

## Troubleshooting

| Problem | Check |
|---|---|
| No events arrive | Is the Events workflow **Active**? Railway logs show `[n8n] ... not delivered: HTTP 403` when the secret is wrong, or `HTTP 404` when the URL is wrong or the workflow is inactive. |
| `401 Invalid token` in n8n | The *IntelSquad API token* value must be `Bearer <API_TOKEN>`, with the word Bearer and a space. |
| `404 Not found` from `/api/integrations` | `N8N_API_TOKEN` is not set on the backend. |
| Telegram error "can't parse entities" | Should not happen (all text is escaped). If it does, remove `parse_mode` in the Telegram node. |
| AI summary missing | The PDS is private, the Anthropic key is wrong, or the request was refused. See the n8n execution log. |
