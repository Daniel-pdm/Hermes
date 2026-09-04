// ---------------------------------------------------------------------------
// store.js — persistent knowledge layer (Supabase Postgres, full-text search)
//
// NO external embeddings service. Retrieval uses Postgres full-text search
// (tsvector + websearch_to_tsquery), so there is no API key, no rate limit,
// and no cost beyond the database itself. Just Supabase + Claude.
//
// Everything here is NON-BLOCKING and OPTIONAL: if the DB isn't configured or
// is unreachable, every function degrades to a safe no-op so Hermes keeps
// answering exactly as before.
//
// Env vars (set in Render). Either the PG* fields (preferred) or DATABASE_URL:
//   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE   (preferred)
//   DATABASE_URL                                          (fallback)
// VOYAGE_API_KEY is no longer used and can be removed.
// ---------------------------------------------------------------------------

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const PGHOST     = process.env.PGHOST;
const PGUSER     = process.env.PGUSER;
const PGPASSWORD = process.env.PGPASSWORD;
const PGPORT     = process.env.PGPORT || "6543";
const PGDATABASE = process.env.PGDATABASE || "postgres";

const haveFields = !!(PGHOST && PGUSER && PGPASSWORD);
const haveUrl    = !!DATABASE_URL;

let pool = null;
let STORE_READY = false;

export function storeEnabled() {
  return STORE_READY;
}

// --- Connection + schema ----------------------------------------------------
export async function initStore() {
  if (!haveFields && !haveUrl) {
    console.log("Knowledge store: no DB config (set PGHOST/PGUSER/PGPASSWORD or DATABASE_URL) — persistence disabled (Hermes still answers).");
    return false;
  }
  try {
    const poolConfig = haveFields
      ? {
          host: PGHOST, port: Number(PGPORT), user: PGUSER,
          password: PGPASSWORD, database: PGDATABASE,
          ssl: { rejectUnauthorized: false },
          max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000
        }
      : {
          connectionString: DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000
        };
    console.log(`Knowledge store: connecting via ${haveFields ? "PG* fields" : "DATABASE_URL"} …`);
    pool = new pg.Pool(poolConfig);

    // Migrate: the previous version used a pgvector 'embedding' column. Moving to
    // full-text search, so drop the old table if it has that shape, then recreate.
    const col = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'knowledge' AND column_name = 'embedding';
    `);
    if (col.rows.length) {
      console.log("Knowledge store: migrating table from vector to full-text (dropping old 'knowledge').");
      await pool.query(`DROP TABLE IF EXISTS knowledge;`);
    }

    // New table: a generated tsvector column drives full-text search.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id           BIGSERIAL PRIMARY KEY,
        fact         TEXT NOT NULL,
        source_type  TEXT,
        source_ref   TEXT,
        author       TEXT,
        confidence   REAL DEFAULT 0.5,
        content_hash TEXT UNIQUE,
        fact_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', fact)) STORED,
        created_at   TIMESTAMPTZ DEFAULT now(),
        updated_at   TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_tsv_idx ON knowledge USING GIN (fact_tsv);`);

    // Small key-value table for bookkeeping (e.g. the resumable backfill cursor).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv_meta (
        k          TEXT PRIMARY KEY,
        v          TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    STORE_READY = true;
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM knowledge;`);
    console.log(`Knowledge store ready (Supabase, full-text). ${rows[0].n} fact(s) stored.`);
    return true;
  } catch (e) {
    console.error("Knowledge store init failed — persistence disabled:", e.message);
    STORE_READY = false;
    return false;
  }
}

// Simple content hash for dedup (djb2 — stable, dependency-free).
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// --- Store one fact ---------------------------------------------------------
// Returns true if stored, false if skipped/failed. Never throws.
export async function storeFact(fact, meta = {}) {
  if (!STORE_READY) return false;
  const clean = (fact || "").trim();
  if (clean.length < 8) return false;
  try {
    const ch = hash(clean.toLowerCase());
    await pool.query(
      `INSERT INTO knowledge (fact, source_type, source_ref, author, confidence, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (content_hash) DO UPDATE SET
         -- fill in the source link if the existing row is missing one (append, don't overwrite a good link)
         source_ref = COALESCE(NULLIF(knowledge.source_ref, ''), EXCLUDED.source_ref, knowledge.source_ref),
         -- keep whichever confidence is higher (e.g. an expert-confirmed re-capture)
         confidence = GREATEST(knowledge.confidence, EXCLUDED.confidence),
         -- prefer a more specific source_type (slack-expert) if it arrives
         source_type = CASE WHEN EXCLUDED.source_type = 'slack-expert' THEN 'slack-expert' ELSE knowledge.source_type END,
         updated_at = now()
       WHERE knowledge.source_ref IS NULL
          OR knowledge.source_ref = ''
          OR knowledge.source_ref NOT LIKE 'http%'
          OR EXCLUDED.confidence > knowledge.confidence;`,
      [clean, meta.sourceType || "manual", meta.sourceRef || null,
       meta.author || null, meta.confidence ?? 0.5, ch]
    );
    return true;
  } catch (e) {
    console.error("storeFact failed:", e.message);
    return false;
  }
}

// --- Key-value bookkeeping (backfill cursor, etc.) -------------------------
export async function getMeta(key) {
  if (!STORE_READY) return null;
  try {
    const { rows } = await pool.query(`SELECT v FROM kv_meta WHERE k = $1;`, [key]);
    return rows.length ? rows[0].v : null;
  } catch (e) {
    console.error("getMeta failed:", e.message);
    return null;
  }
}

export async function setMeta(key, value) {
  if (!STORE_READY) return false;
  try {
    await pool.query(
      `INSERT INTO kv_meta (k, v, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now();`,
      [key, String(value)]
    );
    return true;
  } catch (e) {
    console.error("setMeta failed:", e.message);
    return false;
  }
}

// Uses Postgres full-text search. Returns [{fact, source_type, source_ref,
// confidence, rank}]. Never throws — returns [] on any problem.
export async function retrieveRelevant(query, k = 5) {
  if (!STORE_READY) return [];
  const q = (query || "").trim();
  if (!q) return [];
  try {
    const { rows } = await pool.query(
      `SELECT fact, source_type, source_ref, confidence, created_at,
              ts_rank(fact_tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM knowledge
       WHERE fact_tsv @@ websearch_to_tsquery('english', $1)
       ORDER BY rank DESC, confidence DESC, created_at DESC
       LIMIT $2;`,
      [q, k]
    );
    if (rows.length) {
      const preview = rows.map(r => `${Number(r.rank).toFixed(3)} "${r.fact.slice(0, 60)}"`).join(" | ");
      console.log(`retrieve "${q.slice(0, 50)}" -> ${rows.length} match(es): ${preview}`);
    } else {
      console.log(`retrieve "${q.slice(0, 50)}" -> no keyword match`);
    }
    return rows;
  } catch (e) {
    console.error("retrieveRelevant failed:", e.message);
    return [];
  }
}
