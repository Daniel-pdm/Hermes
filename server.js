// ---------------------------------------------------------------------------
// nova Creative Affinity — Slack Agent
//
// Answers Creative Affinity / Intelligence questions in Slack, grounded ONLY in
// a fixed set of nova help-center articles (fetched from Intercom on startup).
//
// Flow:
//   Slack sends an event  ->  /slack/events
//   verify signature      ->  ack within 3s
//   (async) build prompt from cached articles + question  ->  Claude
//   post the answer back to the Slack thread
// ---------------------------------------------------------------------------

import express from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { initStore, storeEnabled, storeFact, retrieveRelevant } from "./store.js";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Credentials (set in Render → Environment) -----------------------------
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const INTERCOM_TOKEN       = process.env.INTERCOM_TOKEN;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Fixed knowledge scope: Creative Affinity / Intelligence articles (Intercom IDs).
const ARTICLE_IDS = [
  "8793018",   // nova Intelligence Creative Affinity
  "10118855",  // Affinity Score
  "12641367",  // Creative Fatigue
  "12464336",  // Creative Fatigue Monitor
  "10046383",  // TikTok Integration
  "12141468",  // YouTube Integration
  "11321301",  // Saved Filters
  "9261243",   // Talk Track & FAQs
  "11511627",  // Client View
  "16206561",  // Creative Reports
  "16204293",  // Creative Reports (Internal Guide)
  "16221811",  // Creative Reports FAQ (Internal)
];

// Intercom collections whose published articles are ALSO included, on top of
// the fixed ARTICLE_IDS above. All published articles whose parent_ids contain
// one of these collection IDs are loaded on startup.
//   5773840  = nova Intelligence (Internal)
//   13211929 = nova Intelligence
// NOTE: whatever is in these collections at boot time is what Hermes serves —
// adding/removing articles in Intercom changes Hermes on the next restart.
const COLLECTION_IDS = [5773840, 13211929];

// In-memory cache of fetched article text, built on startup.
let KNOWLEDGE = [];       // [{id, title, url, text}]
let KNOWLEDGE_READY = false;

// --- Helpers ---------------------------------------------------------------
// Strip HTML to readable plain text for the prompt.
function htmlToText(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<\/(p|div|h1|h2|h3|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchArticle(id) {
  const res = await fetch(`https://api.intercom.io/articles/${id}`, {
    headers: {
      "Authorization": `Bearer ${INTERCOM_TOKEN}`,
      "Accept": "application/json",
      "Intercom-Version": "2.11"
    }
  });
  if (!res.ok) throw new Error(`Intercom article ${id}: ${res.status}`);
  const a = await res.json();
  return {
    id,
    title: a.title || `Article ${id}`,
    url: a.url || "",
    text: htmlToText(a.body || "")
  };
}

// Discover published article IDs that belong to any of COLLECTION_IDS by
// paging through the Articles list and matching parent_ids. Returns a Set.
async function fetchCollectionArticleIds() {
  const ids = new Set();
  let page = 1;
  const wanted = new Set(COLLECTION_IDS);
  // Safety bound so a huge help center can't loop forever.
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    const res = await fetch(`https://api.intercom.io/articles?per_page=150&page=${page}`, {
      headers: {
        "Authorization": `Bearer ${INTERCOM_TOKEN}`,
        "Accept": "application/json",
        "Intercom-Version": "2.11"
      }
    });
    if (!res.ok) throw new Error(`Intercom list page ${page}: ${res.status}`);
    const data = await res.json();
    for (const a of (data.articles || [])) {
      if (a.state !== "published") continue;              // skip drafts
      const parents = a.parent_ids || (a.parent_id ? [a.parent_id] : []);
      if (parents.some(p => wanted.has(p))) ids.add(String(a.id));
    }
    const totalPages = data.pages && data.pages.total_pages ? data.pages.total_pages : 1;
    if (page >= totalPages) break;
    page++;
  }
  return ids;
}

async function loadKnowledge() {
  console.log("Loading help-center articles…");

  // Start with the fixed curated list, then add collection articles.
  const idSet = new Set(ARTICLE_IDS.map(String));
  try {
    const collIds = await fetchCollectionArticleIds();
    for (const id of collIds) idSet.add(id);
    console.log(`  collections contributed ${collIds.size} article(s); ${idSet.size} unique total.`);
  } catch (e) {
    // If collection discovery fails, fall back to the fixed list rather than crash.
    console.error(`  collection discovery failed (${e.message}); using fixed list only.`);
  }

  const out = [];
  for (const id of idSet) {
    try {
      const art = await fetchArticle(id);
      // Skip empties (e.g. an article whose body didn't come through)
      if (!art.text) { console.error(`  ✗ ${id}: empty body, skipped`); continue; }
      out.push(art);
      console.log(`  ✓ ${art.title} (${art.text.length} chars)`);
    } catch (e) {
      console.error(`  ✗ ${id}: ${e.message}`);
    }
  }
  KNOWLEDGE = out;
  KNOWLEDGE_READY = out.length > 0;
  console.log(`Knowledge ready: ${out.length} articles (${ARTICLE_IDS.length} fixed + collections, de-duplicated).`);
}

function knowledgeBlock() {
  return KNOWLEDGE.map(a =>
    `### ${a.title}\nURL: ${a.url}\n${a.text}`
  ).join("\n\n---\n\n");
}

// --- Slack signature verification ------------------------------------------
// Requires the RAW body, so we capture it with express.raw for this route.
function verifySlack(req) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) return false;
  // reject if older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const base = `v0:${ts}:${req.rawBody}`;
  const mine = "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
  } catch { return false; }
}

// --- Ask Claude, grounded in the articles ----------------------------------
async function answerQuestion(question, images = [], history = []) {
  if (!KNOWLEDGE_READY) {
    return "I'm still loading the help-center articles — give me a few seconds and try again.";
  }
  const hasImages = images.length > 0;

  // Pull any relevant learned facts from the persistent store (no-op if the
  // store is disabled or finds nothing). Kept clearly separate from official docs.
  let learnedBlock = "";
  try {
    const facts = await retrieveRelevant(question, 5);
    if (facts.length) {
      learnedBlock =
        "=== LEARNED KNOWLEDGE (verified team notes captured from Slack/feedback — these are " +
        "typically NEWER than the help articles below) ===\n" +
        facts.map(f => `• (${f.source_type}, confidence ${Number(f.confidence).toFixed(2)}) ${f.fact}`).join("\n") +
        "\n\nHOW TO USE THIS: When a learned note conflicts with a help article — especially when " +
        "it says a feature was removed, changed, renamed, deprecated, or newly added — the learned " +
        "note reflects a more recent product change and TAKES PRECEDENCE over the older article. " +
        "In that case, answer based on the learned note, and briefly say the article may be out of " +
        "date. Only fall back to the article if the learned note is clearly unrelated to the question. " +
        "Do NOT describe a removed/changed feature as if it still works just because an article says so.\n\n";
    }
  } catch { /* retrieval is best-effort */ }

  const system =
    "You are the nova Creative Affinity support assistant for Power Digital's internal team. " +
    "Answer questions about nova Intelligence and Creative Affinity using the help-center articles " +
    "provided below AND any LEARNED KNOWLEDGE notes provided (the learned notes are newer team " +
    "corrections and take precedence when they conflict — see that section's instructions). " +
    "If the answer isn't in either source, say you don't have that in the help center and suggest " +
    "where they might look — do not invent features or steps. Be concise and practical.\n\n" +
    (hasImages
      ? "The user attached one or more screenshots. Look at the image(s) carefully — read any " +
        "visible UI, errors, settings, or charts — and use what you see together with the help " +
        "articles to answer. If the screenshot is ambiguous or shows something not covered by the " +
        "articles, say what you can see but do not guess at product behavior that isn't documented.\n\n"
      : "") +
    "=== SLACK FORMATTING RULES (follow exactly) ===\n" +
    "Your reply is posted in Slack, which uses 'mrkdwn', NOT Markdown. Never expose raw " +
    "formatting characters. Specifically:\n" +
    "- Bold: wrap text in SINGLE asterisks like *this*. NEVER use **double asterisks**.\n" +
    "- Section titles: make them bold with single asterisks (e.g. *Eligibility Requirements*). " +
    "NEVER use #, ##, or ### headings.\n" +
    "- Links: use Slack link syntax <https://url|descriptive text>. NEVER paste a bare URL and " +
    "NEVER use [text](url) Markdown links. Embed the link in descriptive words, e.g. " +
    "<https://help.novapower.io/en/articles/123|Creative Fatigue Monitor help article>.\n" +
    "- Tables: NEVER output Markdown tables or pipe characters (|). Convert any table into simple " +
    "bullet points, e.g. '• Lifetime Spend: ≥ $500'.\n" +
    "- Separators: NEVER use ---, ___, or === lines. Separate sections with a blank line only.\n" +
    "- Lists: use simple bullets (•) or numbered lists; keep them concise, avoid deep indentation.\n" +
    "- Keep it looking like a polished Slack message: short paragraphs, bold titles, bullets, " +
    "clickable descriptive links. Do not output anything that looks like raw documentation.\n\n" +
    "=== ALWAYS CITE YOUR SOURCE ===\n" +
    "End every answer with a source line linking to the specific help-center article you drew " +
    "from, using the article's URL from the ARTICLES section below. Format it as a Slack link on " +
    "its own line, e.g.:\n" +
    "Source: <https://help.novapower.io/en/articles/12464336-...|Creative Fatigue Monitor>\n" +
    "Use the real URL of the article you actually used. If you used more than one, list each on its " +
    "own Source line. If the answer isn't found in any article, say so and do NOT invent a link.\n\n" +
    learnedBlock +
    "=== HELP CENTER ARTICLES ===\n" + knowledgeBlock();

  // Build user content: images first, then the text prompt. If there's no text
  // (image-only message), give the model a sensible default instruction.
  const promptText = question && question.trim().length
    ? question
    : "Please look at the attached screenshot and explain what it shows and anything relevant from the help center.";
  const content = hasImages
    ? [...images, { type: "text", text: promptText }]
    : promptText;

  // Prior thread turns (if any) go before the current message so Claude has
  // context for follow-ups like "how do I turn it off?". history is an array
  // of { role: "user"|"assistant", content: "..." } already trimmed/capped.
  const messages = [...history, { role: "user", content }];

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system,
    messages
  });
  const raw = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim()
    || "Sorry, I couldn't generate an answer.";
  return toSlackMrkdwn(raw);
}

// Download image files attached to a Slack message and return them as
// base64 image blocks for Claude. Requires the bot token + files:read scope.
// Private Slack URLs are used only to fetch bytes here and are never logged or
// exposed to users.
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
async function fetchSlackImages(files) {
  const blocks = [];
  for (const f of (files || [])) {
    // Slack provides a mimetype; only pass image types Claude accepts.
    let media = (f.mimetype || "").toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.includes(media)) continue;
    const url = f.url_private_download || f.url_private;
    if (!url) continue;
    try {
      const res = await fetch(url, { headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}` } });
      if (!res.ok) { console.error(`Slack image fetch failed: ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      // Guard against oversized images (Anthropic limit ~5MB/image, ~3.75MB base64 safe)
      if (buf.length > 3_500_000) { console.error("Skipping oversized image"); continue; }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: media, data: buf.toString("base64") }
      });
    } catch (e) {
      console.error("Image fetch error:", e.message);
    }
  }
  return blocks;
}

// Fetch earlier messages in a thread so Claude has context for follow-ups.
// Reads via Slack conversations.replies (needs im:history for DMs and/or
// channels:history for channels — both already in the app's scopes).
// Returns an array of { role, content } capped to the most recent MAX turns,
// EXCLUDING the current triggering message. Non-blocking: on any failure it
// returns [] so Hermes still answers without history.
async function fetchThreadHistory(channel, thread_ts, currentTs, botUserId) {
  const MAX_TURNS = 12;               // cap so long threads don't bloat the prompt
  try {
    const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(thread_ts)}&limit=30`;
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}` } });
    const j = await res.json();
    if (!j.ok) { console.error("conversations.replies failed:", j.error); return []; }
    const turns = [];
    for (const m of (j.messages || [])) {
      if (m.ts === currentTs) continue;               // skip the message we're answering
      const isBot = !!m.bot_id || (botUserId && m.user === botUserId);
      const clean = (m.text || "").replace(/<@[^>]+>/g, "").trim();
      if (!clean) continue;                            // skip empty/system rows
      turns.push({ role: isBot ? "assistant" : "user", content: clean });
    }
    // keep only the most recent MAX_TURNS
    return turns.slice(-MAX_TURNS);
  } catch (e) {
    console.error("thread history error:", e.message);
    return [];
  }
}

// Safety net: convert any Markdown the model still emits into Slack mrkdwn,
// so raw syntax never reaches the user even if the prompt is imperfectly followed.
function toSlackMrkdwn(text) {
  const lines = text.split("\n");
  const out = [];
  for (let line of lines) {
    // Drop horizontal-rule separator lines (---, ___, ===, ***)
    if (/^\s*([-_=*])\1{2,}\s*$/.test(line)) continue;
    // Drop Markdown table divider rows: | --- | --- |
    if (/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(line) && line.includes("-")) continue;
    // Convert Markdown table data rows into bullets: | a | b | -> • a — b
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.split("|").map(c => c.trim()).filter(c => c.length);
      if (cells.length) { out.push("• " + cells.join(" — ")); continue; }
    }
    // Strip heading markers (#, ##, ###) and bold the heading text instead
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { out.push("*" + h[1].replace(/\*+/g, "").trim() + "*"); continue; }
    // [text](url) -> <url|text>
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
    // **bold** or __bold__ -> *bold*   (do double BEFORE single-char cleanup)
    line = line.replace(/\*\*([^*]+)\*\*/g, "*$1*");
    line = line.replace(/__([^_]+)__/g, "*$1*");
    // Normalize list markers "- " or "* " at line start to "• "
    line = line.replace(/^(\s*)[-*]\s+/, "$1• ");
    out.push(line);
  }
  // collapse 3+ blank lines to a single blank line
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --- Post back to Slack -----------------------------------------------------
async function postSlack(channel, thread_ts, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ channel, thread_ts, text })
  });
  const j = await res.json();
  if (!j.ok) console.error("Slack postMessage failed:", j.error);
}

// Add an emoji reaction to a message to acknowledge receipt. Non-blocking:
// requires the reactions:write scope, but a failure here must never stop
// Hermes from answering. "already_reacted" is treated as success.
async function addReaction(channel, ts, name = "eyes") {
  try {
    const res = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ channel, timestamp: ts, name })
    });
    const j = await res.json();
    if (!j.ok && j.error !== "already_reacted") {
      console.error("Slack reactions.add failed:", j.error);
    }
  } catch (e) {
    console.error("reaction error:", e.message);
  }
}

// Track handled event IDs to avoid double-answering on Slack retries.
const seen = new Set();

// --- Routes -----------------------------------------------------------------
// Capture raw body for signature verification.
app.use("/slack/events", express.raw({ type: "*/*" }));

app.post("/slack/events", (req, res) => {
  req.rawBody = req.body.toString("utf8");
  let payload;
  try { payload = JSON.parse(req.rawBody); } catch { return res.status(400).send("bad json"); }

  // 1) URL verification handshake (Slack sends this once when you set the URL)
  if (payload.type === "url_verification") {
    return res.status(200).json({ challenge: payload.challenge });
  }

  // 2) verify signature for all real events
  if (!verifySlack(req)) return res.status(401).send("bad signature");

  // 3) ACK immediately (within 3s), then process async
  res.status(200).send("");

  const ev = payload.event;
  if (!ev) return;

  // de-dupe Slack retries
  const eid = payload.event_id;
  if (eid) { if (seen.has(eid)) return; seen.add(eid); if (seen.size > 500) seen.clear(); }

  // ignore the bot's own messages
  if (ev.bot_id) return;
  // ignore system message subtypes, but ALLOW file_share (image uploads)
  if (ev.subtype && ev.subtype !== "file_share") return;

  // respond to DMs to the app and to messages in assistant threads
  const isUserMessage = ev.type === "message" || ev.type === "app_mention";
  if (!isUserMessage) return;
  const text = (ev.text || "").replace(/<@[^>]+>/g, "").trim();
  const hasFiles = Array.isArray(ev.files) && ev.files.length > 0;
  // Bail only if there's neither text nor any attached files.
  if (!text && !hasFiles) return;

  const channel = ev.channel;
  const thread_ts = ev.thread_ts || ev.ts;
  // A message is a threaded reply when it carries a thread_ts different from its own ts.
  const isThreadReply = ev.thread_ts && ev.thread_ts !== ev.ts;
  // The bot's own user id, so its past thread messages are labeled as assistant turns.
  const botUserId = (payload.authorizations && payload.authorizations[0] && payload.authorizations[0].user_id) || null;

  (async () => {
    try {
      // Acknowledge receipt immediately with an 👀 reaction on the user's message.
      await addReaction(channel, ev.ts, "eyes");

      // Manual teach command: "!remember <fact>" stores a fact in the knowledge
      // store so it can be retrieved in future answers. Useful for directly
      // teaching Hermes, and a clean end-to-end test of the persistence layer.
      const rememberMatch = text.match(/^!remember\s+([\s\S]+)/i);
      if (rememberMatch) {
        const fact = rememberMatch[1].trim();
        if (!storeEnabled()) {
          await postSlack(channel, thread_ts, "I can't save that right now — my knowledge store isn't connected.");
          return;
        }
        const ok = await storeFact(fact, {
          sourceType: "manual",
          author: ev.user || null,
          confidence: 0.8            // manually taught facts start fairly trusted
        });
        await postSlack(channel, thread_ts, ok
          ? "Got it — I've saved that and will use it in future answers. :white_check_mark:"
          : "I couldn't save that one — it may be too short or a duplicate.");
        return;
      }

      const images = hasFiles ? await fetchSlackImages(ev.files) : [];
      // In a thread, pull earlier messages so follow-ups keep context.
      const history = isThreadReply
        ? await fetchThreadHistory(channel, ev.thread_ts, ev.ts, botUserId)
        : [];
      const answer = await answerQuestion(text, images, history);
      await postSlack(channel, thread_ts, answer);
    } catch (e) {
      console.error("handler error:", e.message);
      await postSlack(channel, thread_ts, "Sorry — I hit an error answering that. Please try again.");
    }
  })();
});

app.get("/healthz", (_req, res) => res.json({ ok: true, knowledge: KNOWLEDGE.length, ready: KNOWLEDGE_READY }));

app.listen(PORT, () => {
  console.log(`nova CA Slack agent on :${PORT}`);
  loadKnowledge();   // warm the cache on startup
  initStore();       // connect Supabase knowledge store (no-op if not configured)
});
