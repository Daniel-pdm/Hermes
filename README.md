# nova Creative Affinity — Slack Agent

A Slack app that answers **Creative Affinity / Intelligence** questions, grounded only in a
fixed set of nova help-center articles (pulled from Intercom on startup and cached).

It does **not** search live or make things up: if an answer isn't in the 12 bundled articles,
it says so.

---

## How it works

```
Slack message  ->  POST /slack/events
                   verify signature, ack in <3s
                   (async) Claude answers using cached articles
                   post reply into the Slack thread
```

- Articles are fetched from Intercom **once on startup** by fixed ID and cached in memory.
- Answers are composed by Claude (`claude-sonnet-4-6`), constrained to those articles.
- Because the reply needs an Intercom-backed prompt + a Claude call, the answer arrives a few
  seconds after you send — the app acks Slack instantly, then posts the answer.

## Fixed article scope (12)

nova Intelligence Creative Affinity · Affinity Score · Creative Fatigue · Fatigue Monitor ·
TikTok Integration · YouTube Integration · Saved Filters · Talk Track & FAQs · Client View ·
Creative Reports · Creative Reports (Internal Guide) · Creative Reports FAQ (Internal).

To change the scope, edit `ARTICLE_IDS` in `server.js` and redeploy.

## Collection scope (dynamic)

On top of the fixed articles above, Hermes also loads **all published articles** in
these two Intercom collections, discovered fresh on each startup:

- `5773840` — nova Intelligence (Internal)
- `13211929` — nova Intelligence

Because this is dynamic, any article added to (or removed from) those collections in
Intercom changes Hermes's knowledge on the next restart/redeploy. Drafts are skipped,
and articles already in the fixed list are de-duplicated (fetched once). Only these two
collections are included — other collections in the same help center (including internal
finance/HR content) are not. To change which collections are included, edit
`COLLECTION_IDS` in `server.js`.

Note: a larger knowledge base means more text is sent to the model on every question,
which increases per-question cost and latency.

---

## Environment variables (set in Render → Environment)

| Variable               | What it is                                                             |
|------------------------|------------------------------------------------------------------------|
| `SLACK_BOT_TOKEN`      | Bot token (`xoxb-…`) — used to post replies                            |
| `SLACK_SIGNING_SECRET` | Signing secret — used to verify incoming events                        |
| `INTERCOM_TOKEN`       | Intercom access token with Articles read access                        |
| `ANTHROPIC_API_KEY`    | Anthropic API key (console.anthropic.com) — used to compose answers    |
| `DATABASE_URL`         | (optional) Supabase POOLED connection string (Transaction mode, :6543) — enables the persistent learned-knowledge store. If unset, Hermes runs exactly as before with no persistence. |
| `VOYAGE_API_KEY`       | (optional) Voyage AI key for embeddings (voyage-3.5-lite). Required only if `DATABASE_URL` is set. |

---

## Slack app setup

1. In your Slack app (api.slack.com/apps → your app):
   - **OAuth & Permissions** → Bot Token Scopes: add `chat:write`, `app_mentions:read`,
     `im:history`, `im:read`, `channels:history`, `files:read`, `reactions:write` (add `assistant:write` if using the Assistant UI).
     `files:read` is required for Hermes to download and understand image attachments; without it,
     image fetches return 403 and screenshots are ignored.
     `reactions:write` lets Hermes add an 👀 reaction to acknowledge each message it receives;
     without it, the reaction is skipped but Hermes still answers normally.
   - **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
   - **Basic Information** → copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.
2. Deploy this app to Render first (below) so you have a public URL.
3. **Event Subscriptions** → toggle on → **Request URL**:
   `https://<your-render-service>.onrender.com/slack/events`
   Slack will call it once to verify; it should show **Verified**.
4. Under **Subscribe to bot events**, add: `message.im` (DMs) and `app_mention` (mentions).
   If you're using the Assistant/Agent feature, also add `assistant_thread_started` and
   `message.im`. Save.
5. Reinstall the app if Slack prompts you (scope changes require it).

## Deploy to Render

1. Push this folder to a new GitHub repo.
2. Render → **New → Web Service** → connect the repo.
   - Runtime: **Node**, Build: `npm install`, Start: `npm start`.
3. Add the four environment variables above.
4. Deploy. Check the **Logs**: you should see
   `Knowledge ready: N articles ...` and `nova CA Slack agent on :10000`.
5. Put the service URL + `/slack/events` into Slack's Request URL (step 3 above).

## Notes & limitations

- **Free tier spins down**: the first message after idle can take ~50s while the service wakes,
  then it's fast. Use a paid instance for real use.
- **Fixed snapshot of scope**: only the 12 listed articles. It re-reads them on each restart, so
  edits to those articles are picked up on redeploy/restart — but new articles won't be included
  unless you add their IDs.
- **Grounded answers only**: the system prompt forbids inventing features; out-of-scope questions
  get an "I don't have that in the help center" response.
- **Security**: tokens live only in Render's environment settings. Incoming Slack requests are
  verified by signing secret with replay protection.
