// ---------------------------------------------------------------------------
// store.js — Phase 1 persistent knowledge layer (Supabase Postgres + pgvector)
//
// Everything here is NON-BLOCKING and OPTIONAL: if DATABASE_URL or
// VOYAGE_API_KEY is missing, or the DB is unreachable, every function degrades
// to a safe no-op so Hermes keeps answering exactly as before.
//
// Env vars (set in Render):
//   DATABASE_URL     Supabase POOLED connection string (Transaction mode, :6543)
//   VOYAGE_API_KEY   Voyage AI key for embeddings (voyage-3.5-lite, 1024 dims)
// ---------------------------------------------------------------------------

import pg from "pg";

const DATABASE_URL   = process.env.DATABASE_URL;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const EMBED_MODEL    = "voyage-3.5-lite";
const EMBED_DIM      = 1024;

let pool = null;
let STORE_READY = false;

export function storeEnabled() {
  return STORE_READY;
}

// --- Connection + schema ----------------------------------------------------
export async function initStore() {
  if (!DATABASE_URL) {
    console.log("Knowledge store: DATABASE_URL not set — persistence disabled (Hermes still answers).");
    return false;
  }
  if (!VOYAGE_API_KEY) {
    console.log("Knowledge store: VOYAGE_API_KEY not set — persistence disabled (Hermes still answers).");
    return false;
  }
  try {
    // Supabase pooled connections need SSL; the pooler accepts this setting.
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,                       // keep small; free tier has limited connections
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000
    });

    // Enable pgvector and create the table if they don't exist.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id          BIGSERIAL PRIMARY KEY,
        fact        TEXT NOT NULL,
        embedding   vector(${EMBED_DIM}),
        source_type TEXT,                       -- 'slack' | 'intercom' | 'feedback' | 'manual'
        source_ref  TEXT,                       -- channel id, article id, conversation id, etc.
        author      TEXT,
        confidence  REAL DEFAULT 0.5,           -- 0..1, adjusted by feedback later
        content_hash TEXT UNIQUE,               -- dedup guard (Phase 3 uses this more)
        created_at  TIMESTAMPTZ DEFAULT now(),
        updated_at  TIMESTAMPTZ DEFAULT now()
      );
    `);
    // Vector index for fast similarity search (cosine).
    await pool.query(`
      CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
      ON knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    `);

    STORE_READY = true;
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM knowledge;`);
    console.log(`Knowledge store ready (Supabase). ${rows[0].n} fact(s) stored.`);
    return true;
  } catch (e) {
    console.error("Knowledge store init failed — persistence disabled:", e.message);
    STORE_READY = false;
    return false;
  }
}

// --- Embeddings (Voyage AI) -------------------------------------------------
async function embed(text, inputType = "document") {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, input_type: inputType, output_dimension: EMBED_DIM })
  });
  if (!res.ok) throw new Error(`Voyage embeddings: ${res.status}`);
  const j = await res.json();
  const vec = j.data && j.data[0] && j.data[0].embedding;
  if (!vec || vec.length !== EMBED_DIM) throw new Error("Voyage: unexpected embedding shape");
  return vec;
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
  if (clean.length < 8) return false;                 // ignore trivially short text
  try {
    const ch = hash(clean.toLowerCase());
    const vec = await embed(clean, "document");
    // pgvector accepts the vector as a bracketed string literal.
    const vecLiteral = `[${vec.join(",")}]`;
    await pool.query(
      `INSERT INTO knowledge (fact, embedding, source_type, source_ref, author, confidence, content_hash)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7)
       ON CONFLICT (content_hash) DO NOTHING;`,
      [clean, vecLiteral, meta.sourceType || "manual", meta.sourceRef || null,
       meta.author || null, meta.confidence ?? 0.5, ch]
    );
    return true;
  } catch (e) {
    console.error("storeFact failed:", e.message);
    return false;
  }
}

// --- Retrieve relevant facts for a question --------------------------------
// Returns an array of { fact, source_type, source_ref, confidence, similarity }.
// Never throws — returns [] on any problem.
export async function retrieveRelevant(query, k = 5, minSimilarity = 0.35) {
  if (!STORE_READY) return [];
  const q = (query || "").trim();
  if (!q) return [];
  try {
    const vec = await embed(q, "query");
    const vecLiteral = `[${vec.join(",")}]`;
    // cosine distance operator <=> ; similarity = 1 - distance
    const { rows } = await pool.query(
      `SELECT fact, source_type, source_ref, confidence,
              1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge
       ORDER BY embedding <=> $1::vector
       LIMIT $2;`,
      [vecLiteral, k]
    );
    return rows.filter(r => r.similarity >= minSimilarity);
  } catch (e) {
    console.error("retrieveRelevant failed:", e.message);
    return [];
  }
}
