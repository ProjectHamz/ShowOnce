// Task 1: Decision 1 smoke test.
// Usage: node smoke.js <clip.webm|mp4>     (SMOKE_SHAPE=a|b|c to try alternate content blocks)
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.GEMINI_API_KEY;
const file = process.argv[2];
if (!KEY) { console.error("Set GEMINI_API_KEY first."); process.exit(1); }
if (!file) { console.error("Usage: node smoke.js <clip.webm|mp4>"); process.exit(1); }

const MIMES = { ".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska" };
const mime = MIMES[path.extname(file).toLowerCase()];
if (!mime) { console.error("Unknown extension; use .webm or .mp4"); process.exit(1); }
const data = fs.readFileSync(file).toString("base64");

const SHAPE = process.env.SMOKE_SHAPE || "a";

// ===== VERIFY content-block shape (see CLAUDE.md) — this is the one object to fix =====
const VIDEO_BLOCK = {
  a: { type: "video", data, mime_type: mime, resolution: "low" },
  b: { inline_data: { mime_type: mime, data } },
  c: { type: "video", source: { type: "base64", media_type: mime, data } },
}[SHAPE];
// ======================================================================================
if (!VIDEO_BLOCK) { console.error("SMOKE_SHAPE must be a, b or c"); process.exit(1); }

const body = {
  model: "gemini-decision-1",
  input: [VIDEO_BLOCK],
  questions: {
    person: {
      type: "noul",
      instructions: "Is there a person visible in this clip?",
      criteria: { true_description: "A person or part of a person (e.g. hands) is visible.", false_description: "No person is visible." },
    },
  },
};

console.log(`shape=${SHAPE} mime=${mime} bytes=${fs.statSync(file).size}`);
const t0 = Date.now();
const res = await fetch("https://generativelanguage.googleapis.com/v1beta/decisions", {
  method: "POST",
  headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const ms = Date.now() - t0;
const text = await res.text();

if (!res.ok) {
  console.error(`\nHTTP ${res.status} after ${ms} ms`);
  console.error(text);
  console.error("\nHint: if this is a 400 about input/content, fix VIDEO_BLOCK in smoke.js (try SMOKE_SHAPE=b or c),");
  console.error("check the Decisions API Quickstart, then copy the working shape into videoBlock() in server.js.");
  process.exit(1);
}

const json = JSON.parse(text);
console.log("\nFull response:\n" + JSON.stringify(json, null, 2));
const ans = (json.answers || json.result?.answers || {}).person;
console.log(`\nAnswer: noul=${ans?.noul} confidence=${ans?.confidence}`);
console.log(`Latency: ${ms} ms`);
