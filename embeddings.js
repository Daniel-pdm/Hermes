// ---------------------------------------------------------------------------
// embeddings.js — local sentence embeddings via @huggingface/transformers
//
// Runs the small quantized all-MiniLM-L6-v2 model (384-dim) in-process. No API,
// no key, no rate limit. Designed to be SAFE on a 512MB free instance:
//   • The model loads LAZILY (first use), inside try/catch.
//   • If it fails to load (OOM, download failure, anything), embedEnabled()
//     stays false and callers fall back to keyword search. Never crashes Hermes.
//   • Model is loaded once and reused.
// ---------------------------------------------------------------------------

let extractor = null;       // the loaded pipeline
let EMBED_READY = false;
let EMBED_TRIED = false;
let EMBED_LOADING = null;    // in-flight load promise (avoid double-load)

export const EMBED_DIM = 384;

export function embedReady() { return EMBED_READY; }

// Lazily load the model. Returns true if ready, false if unavailable.
export async function initEmbeddings() {
  if (EMBED_READY) return true;
  if (EMBED_TRIED && !EMBED_LOADING) return false;   // already failed
  if (EMBED_LOADING) return EMBED_LOADING;

  EMBED_LOADING = (async () => {
    EMBED_TRIED = true;
    try {
      console.log("embeddings: loading local model (all-MiniLM-L6-v2, quantized)…");
      const t0 = Date.now();
      // Import lazily so a failure here can't break module load.
      const { pipeline, env } = await import("@huggingface/transformers");
      // Keep memory/threads modest for the tiny free instance.
      try { env.backends.onnx.wasm.numThreads = 1; } catch { /* older/newer api */ }
      extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true
      });
      EMBED_READY = true;
      console.log(`embeddings: model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return true;
    } catch (e) {
      console.error("embeddings: model failed to load — falling back to keyword search:", e.message);
      EMBED_READY = false;
      extractor = null;
      return false;
    } finally {
      EMBED_LOADING = null;
    }
  })();
  return EMBED_LOADING;
}

// Embed one piece of text -> number[] (length EMBED_DIM), or null on failure.
// Never throws.
export async function embed(text) {
  if (!EMBED_READY) {
    // Try a lazy init once; if it fails, give up gracefully.
    const ok = await initEmbeddings();
    if (!ok) return null;
  }
  const clean = (text || "").trim();
  if (!clean) return null;
  try {
    const out = await extractor(clean, { pooling: "mean", normalize: true });
    // out.data is a Float32Array of length EMBED_DIM
    return Array.from(out.data);
  } catch (e) {
    console.error("embeddings: embed failed:", e.message);
    return null;
  }
}
