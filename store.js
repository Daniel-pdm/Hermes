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
    // Enable pgvector (safe if already enabled). Used for semantic search.
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    } catch (e) {
      console.error("pgvector extension not available (semantic search will be disabled):", e.message);
    }

    // Create the table if it doesn't exist. NOTE: we do NOT drop an existing
    // table — that would wipe learned knowledge. The embedding column is added
    // non-destructively below.
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

    // Add the embedding column if it's missing (non-destructive — keeps all rows).
    try {
      await pool.query(`ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(384);`);
      // ivfflat index for fast cosine similarity. Only helps once rows have embeddings.
      await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_embedding_idx ON knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`);
    } catch (e) {
      console.error("embedding column/index setup skipped (semantic disabled):", e.message);
    }

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

// Blended retrieval: guarantees BOTH article knowledge and Slack-learned
// knowledge are represented, so long keyword-rich articles can't crowd out the
// short Slack facts. Runs two scoped queries and returns them tagged.
// Returns { articles: [...], slack: [...] } — each row has fact, source_type,
// source_ref, confidence, created_at, rank.
// --- Semantic (vector) support -------------------------------------------
// Store an embedding vector for a fact row (by id). Never throws.
export async function setEmbedding(id, vector) {
  if (!STORE_READY || !Array.isArray(vector)) return false;
  try {
    await pool.query(`UPDATE knowledge SET embedding = $1::vector, updated_at = now() WHERE id = $2;`,
      [`[${vector.join(",")}]`, id]);
    return true;
  } catch (e) {
    console.error("setEmbedding failed:", e.message);
    return false;
  }
}

// Store a fact AND its embedding together (used for new facts once embeddings
// are enabled). Falls back to text-only storeFact if vector is null.
export async function storeFactWithEmbedding(fact, vector, meta = {}) {
  const ok = await storeFact(fact, meta);
  if (ok && Array.isArray(vector)) {
    // Look up the row we just inserted by content_hash to attach the vector.
    try {
      const clean = (fact || "").trim();
      const ch = hash(clean.toLowerCase());
      const { rows } = await pool.query(`SELECT id FROM knowledge WHERE content_hash = $1;`, [ch]);
      if (rows.length) await setEmbedding(rows[0].id, vector);
    } catch (e) { console.error("storeFactWithEmbedding attach failed:", e.message); }
  }
  return ok;
}

// Fetch a batch of rows that don't yet have an embedding (for the chunked
// resumable re-embed). Returns [{id, fact}].
export async function fetchUnembedded(limit = 20) {
  if (!STORE_READY) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, fact FROM knowledge WHERE embedding IS NULL ORDER BY id LIMIT $1;`, [limit]);
    return rows;
  } catch (e) {
    console.error("fetchUnembedded failed:", e.message);
    return [];
  }
}

export async function countEmbedded() {
  if (!STORE_READY) return { embedded: 0, total: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded, count(*) AS total FROM knowledge;`);
    return { embedded: Number(rows[0].embedded), total: Number(rows[0].total) };
  } catch (e) {
    console.error("countEmbedded failed:", e.message);
    return { embedded: 0, total: 0 };
  }
}

// Semantic retrieval: nearest rows by cosine similarity to a query vector,
// scoped to articles or slack like the keyword version. Never throws.
export async function retrieveSemantic(queryVector, whereClause, limit) {
  if (!STORE_READY || !Array.isArray(queryVector)) return [];
  try {
    const vec = `[${queryVector.join(",")}]`;
    const { rows } = await pool.query(
      `SELECT fact, source_type, source_ref, confidence, created_at,
              1 - (embedding <=> $1::vector) AS rank
       FROM knowledge
       WHERE embedding IS NOT NULL AND ${whereClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $2;`,
      [vec, limit]);
    return rows;
  } catch (e) {
    console.error("retrieveSemantic failed:", e.message);
    return [];
  }
}

export async function retrieveBlended(query, nArticles = 4, nSlack = 4) {
  if (!STORE_READY) return { articles: [], slack: [] };
  const q = (query || "").trim();
  if (!q) return { articles: [], slack: [] };

  // Build an OR-based tsquery from the meaningful words in the question, so a
  // row matches if it contains ANY of the key terms (ranked by how many match).
  // This fixes the keyword-search gap where a phrase like "how is X connected
  // to Y" failed because the stored fact didn't contain the literal word
  // "connected". Stopwords and very short tokens are dropped.
  const STOP = new Set(["the","a","an","is","are","was","were","be","to","of","in","on","for","and","or","with","how","what","why","when","where","does","do","did","can","i","you","it","this","that","from","into","about","as","at","by","we","our","us","me","my","if","so","not"]);
  const terms = q.toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
  // Fallback: if the question was all stopwords/short, use the raw phrase.
  const orQuery = terms.length ? terms.join(" | ") : q;

  const runScoped = async (whereClause, limit) => {
    try {
      // Use to_tsquery with OR terms. ts_rank still scores by how many/how
      // strongly the terms match, so multi-term matches rank highest.
      const { rows } = await pool.query(
        `SELECT fact, source_type, source_ref, confidence, created_at,
                ts_rank(fact_tsv, to_tsquery('english', $1)) AS rank
         FROM knowledge
         WHERE fact_tsv @@ to_tsquery('english', $1)
           AND ${whereClause}
         ORDER BY rank DESC, confidence DESC, created_at DESC
         LIMIT $2;`,
        [orQuery, limit]
      );
      return rows;
    } catch (e) {
      console.error("retrieveBlended scoped query failed:", e.message);
      return [];
    }
  };
  const [articles, slack] = await Promise.all([
    runScoped(`source_type = 'article'`, nArticles),
    runScoped(`source_type <> 'article'`, nSlack)
  ]);
  console.log(`retrieveBlended "${q.slice(0, 40)}" [terms: ${terms.join(",")}] -> ${articles.length} article(s) + ${slack.length} slack fact(s)`);
  return { articles, slack };
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
