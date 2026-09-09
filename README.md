# Hermes — nova / omega / signal Slack support assistant

Hermes is an internal Slack assistant for Power Digital. Team members **DM it**
questions about **nova, omega, and signal**, and it answers from a knowledge base
built from the Intercom help center **and** learned from Slack feedback channels.
It cites its sources on every answer.

> **Golden rule:** Hermes only ever *replies* in **direct messages**. In channels
> it is a silent listener that learns — it never posts, replies, or reacts there.

---

## What it does

- **Answers DMs** about nova / omega / signal, grounded in retrieved knowledge.
- **Two knowledge sources, blended on every answer:**
  1. **Help-center articles** — all published Intercom articles, ingested (full text) into the store.
  2. **Slack team knowledge** — learned automatically from the feedback channels.
- **Hybrid retrieval** — semantic (meaning-based) search + keyword (OR-term) search, merged.
  Semantic falls back to keyword automatically if the embedding model can't load.
- **Cites sources** — every knowledge answer ends with `Source:` link(s): the help
  article, the Slack thread, or both.
- **Prefers newer info** — when a Slack note conflicts with an older article, it leads
  with the Slack note and flags the article as possibly outdated. Among learned notes,
  the more recent one wins.
- **Image questions** — for a screenshot ("what is this?"), it identifies the feature in
  the image, retrieves knowledge about it, answers, and cites the source.
- **Learns continuously:**
  - Automatically extracts durable facts from new messages in the feedback channels.
  - Weights solutions from designated **experts** higher.
  - Thread-aware: captures the *problem + solution* from a whole thread, not just one line.
  - A once-per-day incremental refresh picks up new articles and new channel messages.
- **Full article lifecycle sync:** new articles are added, **edited articles are updated
  in place** (new/changed sections included), and **deleted/unpublished articles are
  removed** — with a safety guard that refuses to delete on an incomplete ingest.
- **Smarter behavior:** asks a clarifying question when a query is ambiguous, hedges when
  retrieval is weak instead of bluffing, and remembers a user's recent question topics
  across DMs for continuity.
- **Reads images** sent in DMs (screenshots) and answers about them.
- **Reacts with eyes** to acknowledge each DM it receives.
- **Manual teach:** `!remember <fact>` in a DM stores a fact directly.
- **Security guardrails:** resists prompt-injection and credential-extraction, alerts a
  designated person on an attempt, and redacts any secret-shaped text from replies.
- **Memory logging:** prints RSS memory every 60s to the logs (free-tier friendly).

---

## Architecture (files)

| File            | Purpose |
|-----------------|---------|
| `server.js`     | Slack event handling, answering, learning, background jobs, security. |
| `store.js`      | Supabase (Postgres) persistence: facts, embeddings, retrieval, article sync, bookkeeping. |
| `embeddings.js` | Local sentence-embedding model (all-MiniLM-L6-v2) for semantic search. |
| `package.json`  | Dependencies. |

Knowledge lives in a Supabase `knowledge` table (fact text + optional `pgvector`
embedding + source metadata + `article_id` for articles). A `kv_meta` table holds
resumable cursors, per-user memory, and ingest bookkeeping. Nothing critical is kept
only in memory — it survives restarts.

---

## Environment variables (Render → Environment)

**Required:**

| Variable               | What it is |
|------------------------|------------|
| `SLACK_BOT_TOKEN`      | Bot token (xoxb-...) — post replies, read files/threads/channels, react. |
| `SLACK_SIGNING_SECRET` | Verifies incoming Slack events. |
| `INTERCOM_TOKEN`       | Intercom token with Help Center read access (articles). |
| `ANTHROPIC_API_KEY`    | Anthropic API key — composes answers + extracts learned facts. |

**Database (required for learning/memory — Hermes still answers without it).**
Use **either** the PG fields (preferred — avoids URL-encoding pitfalls) **or** `DATABASE_URL`:

| Variable      | Example |
|---------------|---------|
| `PGHOST`      | aws-0-us-west-2.pooler.supabase.com |
| `PGPORT`      | 6543 (Supabase transaction pooler) |
| `PGUSER`      | postgres.<project-ref> (the full pooled username) |
| `PGPASSWORD`  | your database password (raw — no URL-encoding needed) |
| `PGDATABASE`  | postgres |
| `DATABASE_URL`| (fallback) full pooled connection string |

**Optional (sensible defaults built in):**

| Variable                 | Default / meaning |
|--------------------------|-------------------|
| `LEARN_CHANNELS`         | Comma-separated channel IDs Hermes learns from (silent). |
| `BACKFILL_MAX_AGE_DAYS`  | Only backfill channel history newer than this many days (default 180; 0 = no limit). Applies to channels not yet backfilled and not in `FULL_HISTORY_CHANNELS`; already-done channels keep their full history. |
| `FULL_HISTORY_CHANNELS`  | Comma-separated channel IDs to scan from the beginning (exempt from `BACKFILL_MAX_AGE_DAYS`). |
| `EXPERT_USER_IDS`        | Comma-separated Slack user IDs whose solutions are weighted higher. |
| `SECURITY_ALERT_USER_ID` | Slack user DM'd when an injection/secret attempt is detected. |
| `SLACK_WORKSPACE_URL`    | For building Slack thread permalinks (default power-digital). |

> `VOYAGE_API_KEY` is **no longer used** — embeddings are local now. Safe to remove.

---

## Slack app setup

1. **OAuth & Permissions -> Bot Token Scopes:**
   chat:write, app_mentions:read, im:history, im:read,
   channels:history, files:read, reactions:write
   (add assistant:write if using the Assistant UI).
2. Install to the workspace; copy the **Bot User OAuth Token** -> SLACK_BOT_TOKEN.
3. **Basic Information -> Signing Secret** -> SLACK_SIGNING_SECRET.
4. **Event Subscriptions -> Request URL:** https://<service>.onrender.com/slack/events
   Subscribe to bot events: message.im, app_mention, message.channels.
5. **Invite Hermes to each learn-channel** (/invite @Hermes) — it can't read a
   channel it isn't in. It learns silently and never posts there.
6. Reinstall the app whenever scopes change.

---

## Deploy (Render)

1. Push all files. **Include `embeddings.js`** (separate file).
2. Web Service -> Build: npm install, Start: npm start, Node runtime.
3. Set the environment variables above.
4. Deploy and watch **Logs** for:
   - `Knowledge store ready (Supabase, full-text). N fact(s) stored.`
   - `embeddings: model ready ...` (semantic on) OR `... falling back to keyword` (still works).
   - `mem: RSS ...MB` — memory usage (free instance limit ~512 MB).
   - `article ingest: ... COMPLETE` and `reconcileArticles: ...` after a full article pass.

---

## How learning & article sync work

- **Channel backfill** (one-time per channel): reads history in resumable batches.
  New channels honor `BACKFILL_MAX_AGE_DAYS` (default 180 days), except those listed
  in `FULL_HISTORY_CHANNELS`, which are scanned from the beginning. Already-done
  channels are skipped.
  State: kv_meta `backfill_done:<ch>`, `backfill_cursor:<ch>`, `newest_ts:<ch>`.
- **Article ingest** (cursor-paged, resumable): pages the whole Intercom help center.
  - Articles are keyed by `article_id` (from the article URL).
  - New -> inserted. Edited -> **updated in place** (embedding cleared, re-embedded).
    Unchanged -> skipped. On a **complete** pass, deleted/unpublished articles are
    **removed** (guarded: refuses if the seen-set looks incomplete).
- **Daily refresh:** at most once per 24h (triggered by the first activity that wakes
  the service): new channel messages + article re-check + embed new facts.
- **Re-embed:** chunked background job embeds any facts lacking a vector, a few at a
  time (bounded memory). Resumes across restarts.

---

## Known limitations (honest)

- **Free-tier hosting:** Render free instance is 512 MB RAM / 0.1 CPU and **spins down
  after ~15 min idle** (first request after idle ~50s). Disk is ephemeral, so the
  embedding model re-downloads (~23 MB) on each cold start.
- **Semantic search fit is tight:** the local model loads in-process; measured RSS with
  it loaded is ~350 MB of 512 MB. Watch the `mem:` line under heavy jobs (backfills,
  re-embed). If it nears ~500 MB or you see restarts, a paid instance (more RAM, no cold
  starts) is the fix. If the model can't load, Hermes falls back to keyword search.
- **0.1 CPU makes embedding slow:** re-embedding many facts takes multiple wake cycles.
- **Channel images/video are NOT learned:** only text from channels is extracted.
  (DM images ARE read live and used to drive retrieval.)
- **Updates are daily, not instant:** article/channel changes land on the next daily
  refresh, which only fires when someone uses Hermes that day.
- **Supabase free tier:** pauses after ~1 week idle, no backups. Fine for internal use.
- **No exact cost metering:** memory is logged; per-question $ is not. Check Anthropic Console -> Usage.

---

## Supabase SQL cheatsheet

```sql
-- What's stored, by type
SELECT source_type, count(*) FROM knowledge GROUP BY source_type;

-- Article coverage (total / embedded / linked / with id)
SELECT count(*) AS total_articles,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
       count(*) FILTER (WHERE source_ref LIKE 'http%') AS with_link,
       count(*) FILTER (WHERE article_id IS NOT NULL) AS with_article_id
FROM knowledge WHERE source_type = 'article';

-- Did the article ingest complete?
SELECT k, v FROM kv_meta WHERE k IN ('articles_ingest_done','articles_ingest_next');

-- Any duplicate articles? (should be zero rows)
SELECT article_id, count(*) FROM knowledge
WHERE source_type='article' AND article_id IS NOT NULL
GROUP BY article_id HAVING count(*) > 1;

-- Confirm a specific article is current (example: 8793018)
SELECT article_id, left(fact,150) AS starts_with, length(fact) AS chars, updated_at
FROM knowledge WHERE source_type='article' AND source_ref LIKE '%8793018%';

-- How many facts have embeddings yet
SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded, count(*) AS total FROM knowledge;

-- Force a fresh, clean article re-ingest (adds/updates/removes on next run)
DELETE FROM knowledge WHERE source_type='article';
DELETE FROM kv_meta WHERE k LIKE 'articles_ingest%' OR k IN ('articles_seen_any','articles_seen_ids');

-- Force a fresh channel backfill (re-processes history — costs Claude tokens)
DELETE FROM kv_meta WHERE k LIKE 'backfill_done:%' OR k LIKE 'backfill_cursor:%';

-- Force the daily refresh to run on next activity
DELETE FROM kv_meta WHERE k = 'last_daily_refresh';
```

---

## Not built (deferred)

- **Feedback loop (thumbs up/down)** — react to answers to log/learn what's useful.
- **Channel image/video learning** — extracting knowledge from images posted in channels.
