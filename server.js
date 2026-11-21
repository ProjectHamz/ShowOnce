// Showunce: one Express server, 4 routes. See CLAUDE.md.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

// Load KEY=VALUE lines from secrets.env (hackathon only; delete the file after the event).
// A variable already set in the shell wins over the file.
const SECRETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "secrets.env");
if (fs.existsSync(SECRETS)) {
  for (const line of fs.readFileSync(SECRETS, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("Set GEMINI_API_KEY first (or put it in secrets.env)."); process.exit(1); }
const NEON_MODEL = process.env.NEON_MODEL || "gemini-4-neon";
const CARBON_MODEL = process.env.CARBON_MODEL || "gemini-4-carbon";
const DECISION_MODEL = "gemini-decision-1";
const PORT = process.env.PORT || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, "runs");
fs.mkdirSync(RUNS, { recursive: true });

const ai = new GoogleGenAI({ apiKey: KEY });
const app = express();
app.use(express.json({ limit: "120mb" }));
app.use(express.static(path.join(ROOT, "public")));

// ---------- helpers ----------
// VERIFY content-block shape (see CLAUDE.md). Must match the shape that works in smoke.js (default "a").
function videoBlock(data, mime) {
  return { type: "video", data, mime_type: mime, resolution: "low" };
}

async function decide(input, questions) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/decisions", {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: DECISION_MODEL, input, questions }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`Decisions HTTP ${res.status} ${e.code ?? ""}: ${e.message ?? text.slice(0, 300)}`);
  }
  return json.answers || json.result?.answers || {};
}

function parseJSON(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error("Model did not return JSON: " + s.slice(0, 200));
}

const stripPrefix = (b64) => String(b64 || "").replace(/^data:[^,]*,/, "");

function route(name, fn) {
  return async (req, res) => {
    const t0 = Date.now();
    try {
      const out = await fn(req.body || {});
      console.log(`[${name}] ok ${Date.now() - t0} ms`);
      res.json(out);
    } catch (err) {
      console.error(`[${name}] error ${Date.now() - t0} ms:`, err.message);
      res.status(500).json({ error: err.message });
    }
  };
}

// ---------- POST /api/plan : teaching video -> Neon -> steps ----------
const PLAN_PROMPT = `You are watching a teaching video of a hands-on procedure performed once.
Extract the procedure as 3 to 8 ordered hands-on steps.
Return JSON only, exactly: {"steps":[{"id":"s1","name":"short imperative, e.g. Put gloves in bag","done_when":"the visible end state that proves this step is done"}]}
Use ids s1..sN in order. Describe objects and actions only; never describe or judge the person.`;

app.post("/api/plan", route("plan", async ({ video, mimeType }) => {
  if (!video) throw new Error("missing video");
  let resp;
  try {
    resp = await ai.models.generateContent({
      model: NEON_MODEL,
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType: mimeType || "video/webm", data: stripPrefix(video) } },
        { text: PLAN_PROMPT },
      ] }],
      config: { responseMimeType: "application/json" },
    });
  } catch (err) {
    throw new Error(`Neon (${NEON_MODEL}) failed: ${err.message}. If it rejects video, set NEON_MODEL to the model the Builder Guide's video recipe uses (e.g. gemini-4-hydrogen).`);
  }
  const parsed = parseJSON(resp.text);
  const raw = Array.isArray(parsed) ? parsed : parsed.steps || [];
  const steps = raw.slice(0, 8).map((s, i) => ({
    id: `s${i + 1}`,
    name: String(s.name || s.step || `Step ${i + 1}`),
    done_when: String(s.done_when || s.doneWhen || ""),
  }));
  if (!steps.length) throw new Error("Neon returned no steps");
  return { steps };
}));

// ---------- POST /api/check : window of 1-2 clips -> Decision 1 -> probabilities ----------
// The client sends the newest clip plus the one before it, so a step that crosses a clip
// boundary is seen whole. If the API refuses multi-block input, fall back to fewer blocks.
const INPUT_MODES = ["text+prev+clip", "prev+clip", "clip"];
let inputMode = 0;
function buildInput(mode, clip, prevClip, mime, n) {
  const blocks = [];
  if (mode === "text+prev+clip") blocks.push({ type: "text", text: prevClip
    ? `Two consecutive ${n}-second clips from one fixed camera, oldest first. Judge what happens across both clips together.`
    : `One ${n}-second clip from a fixed camera.` });
  if (prevClip && mode !== "clip") blocks.push(videoBlock(stripPrefix(prevClip), mime));
  blocks.push(videoBlock(stripPrefix(clip), mime));
  return blocks;
}
const isInputError = (e) => /HTTP 400/.test(e.message) && /input|content|block|type|text|video/i.test(e.message);

function checkQuestions(steps, doneSteps, allSteps) {
  const questions = {};
  for (const s of steps) {
    questions[s.id] = {
      type: "noul",
      instructions: `Does the video show the step "${s.name}" being finished? It counts as finished when: ${s.done_when}. Only the visible end state counts: reaching for, holding, or moving toward the object is not enough.`,
      criteria: {
        true_description: `"${s.name}" is completed in the video: ${s.done_when}`,
        false_description: `"${s.name}" is not completed in the video (not started, only started, or not visible).`,
      },
    };
  }
  for (const s of doneSteps) {
    questions["undo_" + s.id] = {
      type: "noul",
      instructions: `Earlier, the step "${s.name}" was finished (${s.done_when}). Does the video show that result being clearly reversed, for example the item taken back out or put back where it was?`,
      criteria: {
        true_description: `The result of "${s.name}" is clearly reversed in the video.`,
        false_description: `The result of "${s.name}" stays as it was, or it is not visible.`,
      },
    };
  }
  const known = allSteps.map((s, i) => `${i + 1}. ${s.name}`).join("; ");
  questions.extra = {
    type: "noul",
    instructions: `The procedure is: ${known}. Does the person do a deliberate hands-on action with an object that is not part of any of these steps? Do not count: reaching for or handling the objects these steps use, adjusting grip, moving between steps, repeating a listed step, gestures, talking, or idle movement.`,
    criteria: {
      true_description: "A deliberate action with an object that belongs to none of the listed steps (for example adding an item that is not in the procedure).",
      false_description: "Only listed steps, preparation for them, idle movement, or nothing happens.",
    },
  };
  questions.present = {
    type: "noul",
    instructions: "Are a person's hands or body visible in the video for most of its length?",
    criteria: { true_description: "Hands or a person are visible most of the time.", false_description: "No person or hands are visible for most of the video." },
  };
  return questions;
}

app.post("/api/check", route("check", async ({ clip, prevClip, mimeType, clipSeconds = 4, steps = [], doneSteps = [], allSteps = [] }) => {
  if (!clip) throw new Error("missing clip");
  const mime = mimeType || "video/webm";
  const questions = checkQuestions(steps, doneSteps, allSteps.length ? allSteps : steps);
  const t0 = Date.now();
  let answers;
  for (;;) {
    try {
      answers = await decide(buildInput(INPUT_MODES[inputMode], clip, prevClip, mime, clipSeconds), questions);
      break;
    } catch (e) {
      if (isInputError(e) && inputMode < INPUT_MODES.length - 1) {
        inputMode++;
        console.warn(`[check] input refused, falling back to "${INPUT_MODES[inputMode]}": ${e.message.slice(0, 160)}`);
        continue;
      }
      throw e;
    }
  }
  const ms = Date.now() - t0;
  const out = {};
  for (const k of Object.keys(questions)) {
    const a = answers[k] || {};
    out[k] = { p: typeof a.noul === "number" ? a.noul : null, confidence: a.confidence ?? null };
  }
  console.log(`[check] decision ${ms} ms, ${Object.keys(questions).length} questions, input=${INPUT_MODES[inputMode]}`);
  return { answers: out, ms, input: INPUT_MODES[inputMode] };
}));

// ---------- POST /api/describe : name the extra action (Neon, after the alert fired) ----------
app.post("/api/describe", route("describe", async ({ clip, prevClip, mimeType, steps = [] }) => {
  if (!clip) throw new Error("missing clip");
  const mime = mimeType || "video/webm";
  const parts = [];
  if (prevClip) parts.push({ inlineData: { mimeType: mime, data: stripPrefix(prevClip) } });
  parts.push({ inlineData: { mimeType: mime, data: stripPrefix(clip) } });
  parts.push({ text: `These are consecutive clips of someone doing this procedure: ${steps.map((s, i) => `${i + 1}. ${s.name}`).join("; ")}.
They did one hands-on action that is not part of the procedure. Name that action in at most 8 words, starting with a verb (for example "put a phone in the bag"). Describe the object and action only, never the person. If you can't see one, answer "unclear".` });
  const resp = await ai.models.generateContent({ model: NEON_MODEL, contents: [{ role: "user", parts }] });
  const what = String(resp.text || "").trim().split("\n")[0].replace(/^["']|["'.]$/g, "");
  return { what: /^unclear$/i.test(what) ? "" : what };
}));

// ---------- POST /api/speak : text -> natural voice (Gemini TTS), cached by text ----------
const TTS_MODEL = process.env.TTS_MODEL || "gemini-3.8-flash-lite-tts";
const TTS_VOICE = process.env.TTS_VOICE || "Kore";
const ttsCache = new Map();
app.post("/api/speak", route("speak", async ({ text }) => {
  const line = String(text || "").trim().slice(0, 300);
  if (!line) throw new Error("missing text");
  if (!ttsCache.has(line)) {
    ttsCache.set(line, (async () => {
      // Plain REST: this SDK version mis-serializes speechConfig for the TTS models.
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Say calmly and clearly: ${line}` }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } },
        }),
      });
      const resp = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${resp.error?.message || ""}`);
      const part = resp.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
      if (!part) throw new Error("TTS returned no audio");
      return { audio: part.inlineData.data, mime: part.inlineData.mimeType || "audio/wav" };
    })().catch((e) => { ttsCache.delete(line); throw e; }));
  }
  return await ttsCache.get(line);
}));

// ---------- POST /api/alert : Carbon -> one spoken sentence ----------
app.post("/api/alert", route("alert", async ({ kind, step, missed = [], steps = [] }) => {
  const order = steps.map((s, i) => `${i + 1}. ${s.name}`).join("\n");
  const missedNames = missed.map((s) => s.name).join(", ") || "none";
  const prompt = `You voice short alerts for a procedure checker. Procedure:\n${order}\n
Event: ${kind}. Step just seen: ${step ? step.name : "none"}. Steps not done yet: ${missedNames}.
(skip_or_order = a later step was done before an earlier one; extra = an action not in the procedure; undone = a finished step was reversed; skipped = steps never done by the end.)
Write ONE short spoken sentence (max 15 words) about the procedure only. Neutral and helpful; never judge or describe the person. Plain text, no quotes.`;
  const resp = await ai.models.generateContent({ model: CARBON_MODEL, contents: [{ role: "user", parts: [{ text: prompt }] }] });
  const line = String(resp.text || "").trim().split("\n")[0].replace(/^["']|["']$/g, "");
  if (!line) throw new Error("Carbon returned empty line");
  return { line };
}));

// ---------- POST /api/log : save a run ----------
app.post("/api/log", route("log", async ({ player = "", card = { type: "none" }, steps = [], events = [], video }) => {
  const ts = Date.now();
  const base = `run-${ts}`;
  const record = { player, card, steps, events, savedAt: new Date(ts).toISOString() };
  if (video) {
    fs.writeFileSync(path.join(RUNS, `${base}.webm`), Buffer.from(stripPrefix(video), "base64"));
    record.video = `${base}.webm`;
  }
  fs.writeFileSync(path.join(RUNS, `${base}.json`), JSON.stringify(record, null, 2));
  return { ok: true, file: `${base}.json` };
}));

app.listen(PORT, () => console.log(`Showunce on http://localhost:${PORT}  (neon=${NEON_MODEL}, carbon=${CARBON_MODEL}, voice=${TTS_MODEL}/${TTS_VOICE})`));
