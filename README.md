# Hermes — nova / omega / signal Slack support assistant

Hermes is an internal Slack assistant for Power Digital. Team members **DM it**
questions about **nova, omega, and signal**, and it answers from a knowledge base
built out of the Intercom help center **and** learned from Slack feedback channels.
It cites its sources on every answer.

> **Golden rule:** Hermes only ever *replies* in **direct messages**. In channels
> it is a silent listener that learns — it never posts, replies, or reacts there.

---

## What it does

- **Answers DMs** about nova / omega / signal, grounded in retrieved knowledge.
- **Two knowledge sources, blended on every answer:**
  1. **Help-center articles** — all published Intercom articles, ingested into the store.
  2. **Slack team knowledge** — learned automatically from three feedback channels.
- **Hybrid retrieval** — semantic (meaning-based) search + keyword search, merged.
  Semantic falls back to keyword automatically if the embedding model can't load.
- **Cites sources** — every knowledge answer ends with `Source:` link(s): the help
  article, the Slack thread, or both.
- **Prefers newer info** — when a Slack note conflicts with an older article, it leads
  with the Slack note and flags the article as possibly outdated.
- **Learns continuously:**
  - Automatically extracts durable facts from new messages in the feedback channels.
  - Weights solutions from designated **experts** higher.
  - Thread-aware: captures the *problem + solution* from a whole thread, not just one line.
  - A once-per-day incremental refresh picks up new articles and new channel messages.
- **Smarter behavior:** asks a clarifying question when a query is ambiguous, hedges
  when retrieval is weak instead of bluffing, and remembers a user's recent question
  topics across DMs for continuity.
- **Reads images** sent in DMs (screenshots) and answers about them.
- **Reacts with eyes** to acknowledge each DM it receives.
- **Manual teach:** `!remember <fact>` in a DM stores a fact directly.
- **Security guardrails:** resists prompt-injection and credential-extraction, and
  alerts a designated person on an attempt.

---

## Architecture (files)

| File            | Purpose |
|-----------------|---------|
| `server.js`     | Slack event handling, answering, learning, background jobs, security. |
| `store.js`      | Supabase (Postgres) persistence: facts, embeddings, retrieval, bookkeeping. |
| `embeddings.js` | Local sentence-embedding model (all-MiniLM-L6-v2) for semantic search. |
| `package.json`  | Dependencies. |

Knowledge lives in a Supabase `knowledge` table (text + optional `pgvector`
embedding + source metadata). A `kv_meta` table holds resumable cursors and
per-user memory. Nothing critical is kept only in memory — it survives restarts.

---

## Environment variables (set in Render → Environment)

**Required:**

| Variable               | What it is |
|------------------------|------------|
| `SLACK_BOT_TOKEN`      | Bot token (xoxb-...) — post replies, read files/threads/channels, react. |
| `SLACK_SIGNING_SECRET` | Verifies incoming Slack events. |
| `INTERCOM_TOKEN`       | Intercom token with Help Center read access (articles). |
| `ANTHROPIC_API_KEY`    | Anthropic API key — composes answers + extracts learned facts. |

**Database (required for learning/memory — Hermes still answers without it):**

Use **either** the pooled connection string **or** the separate PG fields
(PG fields are preferred; they avoid URL-encoding pitfalls):

| Variable      | Example |
|---------------|---------|
| `PGHOST`      | aws-0-us-west-2.pooler.supabase.com |
| `PGPORT`      | 6543 (Supabase transaction pooler) |
| `PGUSER`      | postgres.<project-ref> (the full pooled username) |
| `PGPASSWORD`  | your database password (raw — no URL-encoding needed) |
| `PGDATABASE`  | postgres |
| `DATABASE_URL`| (fallback) full pooled connection string, if not using PG fields |

**Optional overrides (sensible defaults built in):**

| Variable                 | Default / meaning |
|--------------------------|-------------------|
| `LEARN_CHANNELS`         | Comma-separated channel IDs Hermes learns from (silent). |
| `EXPERT_USER_IDS`        | Comma-separated Slack user IDs whose solutions are weighted higher. |
| `SECURITY_ALERT_USER_ID` | Slack user DM'd when an injection/secret attempt is detected. |
| `SLACK_WORKSPACE_URL`    | For building Slack thread permalinks (default power-digital). |

> VOYAGE_API_KEY is **no longer used** — embeddings are local now. Safe to remove.

---

## Slack app setup

1. **OAuth & Permissions -> Bot Token Scopes:**
   chat:write, app_mentions:read, im:history, im:read,
   channels:history, files:read, reactions:write
   (add assistant:write if using the Assistant UI).
2. Install to the workspace; copy the **Bot User OAuth Token** -> SLACK_BOT_TOKEN.
3. **Basic Information -> Signing Secret** -> SLACK_SIGNING_SECRET.
4. **Event Subscriptions -> Request URL:** https://<service>.onrender.com/slack/events
   Subscribe to bot events: message.im, app_mention, message.channels
   (message.channels is needed for channel learning).
5. **Invite Hermes to each learn-channel** (/invite @Hermes) — it can't read a
   channel it isn't in. It learns silently and never posts there.
6. Reinstall the app whenever scopes change.

---

## Deploy (Render)

1. Push all files to the repo. **Include embeddings.js** (it's a separate file).
2. Render Web Service -> Build: npm install, Start: npm start, Node runtime.
3. Set the environment variables above.
4. Deploy and watch **Logs** for:
   - Knowledge store ready (Supabase, full-text). N fact(s) stored.
   - embeddings: model ready ... (semantic on) OR embeddings: ... falling back to keyword (still works).
   - mem: RSS ...MB — memory usage (the free instance limit is ~512 MB).

---

## How learning works (operational notes)

- **Backfill** (one-time per channel): reads full channel history in resumable
  batches; state in kv_meta (backfill_done:<channel>, backfill_cursor:<channel>).
- **Article ingest** (one-time): pages the whole Intercom help center into the store.
- **Daily refresh:** at most once per 24h (triggered by the first activity that wakes
  the service), pulls new channel messages + re-checks articles, and embeds new facts.
- **Re-embed:** a chunked background job embeds any facts lacking a vector, a few at
  a time to stay within memory. Resumes across restarts.

To force a fresh backfill / re-ingest, clear the relevant kv_meta keys and restart
(see the SQL cheatsheet at the bottom).

---

## Known limitations (honest)

- **Free-tier hosting:** Render free instance is 512 MB RAM / 0.1 CPU and **spins down
  after ~15 min idle** (first request after idle takes ~50s). Disk is ephemeral, so the
  embedding model re-downloads (~23 MB) on each cold start.
- **Semantic search may not fit / may be slow:** the local model runs in-process. If it
  can't load (memory/download), Hermes falls back to keyword search automatically. On
  0.1 CPU, embedding is slow; the re-embed of existing facts takes many wake cycles.
- **Keyword search is literal-ish:** even with OR-matching, a question sharing no words
  with the stored knowledge can miss. Semantic search mitigates this when it's loaded.
- **Channel images/video are NOT learned:** only text from channels is extracted.
  Knowledge that lives only in screenshots/videos posted to channels is not captured.
  (DM images ARE read live.)
- **Supabase free tier:** pauses after ~1 week idle, no backups. Fine for internal use;
  not production-grade durability.
- **No exact cost metering:** per-question cost isn't logged (memory is). Check the
  Anthropic Console -> Usage for real spend.

---

## Cost shape

- **Answering a question:** one Claude call (input = retrieved knowledge + question).
- **Learning:** one Claude extraction call per new channel message/thread.
- **Article ingest & embeddings:** no Claude calls (articles stored as text; embeddings
  are local/free).
- Backfills are the main one-time spend; steady-state is cheap. Verify in the Anthropic Console.

---

## Supabase SQL cheatsheet

```sql
-- What's stored, by type
SELECT source_type, count(*) FROM knowledge GROUP BY source_type;

-- How many facts have embeddings yet
SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded, count(*) AS total FROM knowledge;

-- How many facts have a source link
SELECT source_type, count(*) FILTER (WHERE source_ref LIKE 'http%') AS with_link, count(*) AS total
FROM knowledge GROUP BY source_type;

-- Force a fresh article re-ingest
DELETE FROM kv_meta WHERE k LIKE 'articles_ingest%' OR k = 'articles_seen_any';

-- Force a fresh channel backfill (re-processes history — costs Claude tokens)
DELETE FROM kv_meta WHERE k LIKE 'backfill_done:%' OR k LIKE 'backfill_cursor:%';

-- Force the daily refresh to run on next activity
DELETE FROM kv_meta WHERE k = 'last_daily_refresh';
```
