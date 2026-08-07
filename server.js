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

async function loadKnowledge() {
  console.log("Loading help-center articles…");
  const out = [];
  for (const id of ARTICLE_IDS) {
    try {
      const art = await fetchArticle(id);
      out.push(art);
      console.log(`  ✓ ${art.title} (${art.text.length} chars)`);
    } catch (e) {
      console.error(`  ✗ ${id}: ${e.message}`);
    }
  }
  KNOWLEDGE = out;
  KNOWLEDGE_READY = out.length > 0;
  console.log(`Knowledge ready: ${out.length}/${ARTICLE_IDS.length} articles.`);
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
async function answerQuestion(question) {
  if (!KNOWLEDGE_READY) {
    return "I'm still loading the help-center articles — give me a few seconds and try again.";
  }
  const system =
    "You are the nova Creative Affinity support assistant for Power Digital's internal team. " +
    "Answer questions about nova Intelligence and Creative Affinity using ONLY the help-center " +
    "articles provided below. If the answer isn't in the articles, say you don't have that in the " +
    "help center and suggest where they might look — do not invent features or steps. " +
    "Be concise and practical. When relevant, link the article URL you used.\n\n" +
    "=== HELP CENTER ARTICLES ===\n" + knowledgeBlock();

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: question }]
  });
  return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim()
    || "Sorry, I couldn't generate an answer.";
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

  // ignore the bot's own messages / non-user messages
  if (ev.bot_id || ev.subtype) return;

  // respond to DMs to the app and to messages in assistant threads
  const isUserMessage = ev.type === "message" || ev.type === "app_mention";
  if (!isUserMessage) return;
  const text = (ev.text || "").replace(/<@[^>]+>/g, "").trim();
  if (!text) return;

  const channel = ev.channel;
  const thread_ts = ev.thread_ts || ev.ts;

  (async () => {
    try {
      const answer = await answerQuestion(text);
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
});
