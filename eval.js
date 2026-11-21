// eval.js — score saved runs against the secret error card, plus a one-call Neon baseline.
// Usage: npm run eval            (with baseline, cached in runs/baseline-cache.json)
//        node eval.js --no-baseline
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, "runs");
const CACHE = path.join(RUNS, "baseline-cache.json");
const OUT_MD = path.join(RUNS, "eval-results.md");
const HOLDOUT_N = 10;
const CONCURRENCY = 3;
const NO_BASELINE = process.argv.includes("--no-baseline");
const NEON_MODEL = process.env.NEON_MODEL || "gemini-4-neon";
const TYPES = ["none", "skip", "swap", "extra"];

// ---------- load runs ----------
if (!fs.existsSync(RUNS)) fs.mkdirSync(RUNS, { recursive: true });
const files = fs.readdirSync(RUNS).filter((f) => /^run-.*\.json$/.test(f)).sort();
if (files.length === 0) {
  console.log("No runs found in runs/. Do some runs in the web app (Run -> set the card -> Save), then rerun `npm run eval`.");
  process.exit(0);
}
const runs = [];
for (const [i, file] of files.entries()) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(RUNS, file), "utf8"));
    r.file = file;
    r.split = i < HOLDOUT_N ? "holdout" : "rest";
    r.card = r.card || { type: "none" };
    r.events = Array.isArray(r.events) ? r.events : [];
    r.steps = Array.isArray(r.steps) ? r.steps : [];
    runs.push(r);
  } catch (e) {
    console.warn(`Skipping ${file}: ${e.message}`);
  }
}

// ---------- system prediction from events ----------
function systemPredict(run) {
  const ev = [...run.events].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const doneAt = {}; // step id -> list of times it became done
  for (const e of ev) if (e.kind === "done" && e.step) (doneAt[e.step] ||= []).push(e.t ?? 0);
  const labeled = []; // [{t, type}]
  const flagged = new Set();
  for (const e of ev) {
    if (e.kind === "extra") labeled.push({ t: e.t ?? 0, type: "extra" });
    else if (e.kind === "skipped") {
      labeled.push({ t: e.t ?? 0, type: "skip" });
      if (e.step) flagged.add(e.step);
      (e.missed || []).forEach((m) => flagged.add(m));
    } else if (e.kind === "skip_or_order") {
      const missed = e.missed && e.missed.length ? e.missed : e.step ? [e.step] : [];
      missed.forEach((m) => flagged.add(m));
      const laterDone = missed.length > 0 && missed.every((m) => (doneAt[m] || []).some((t) => t > (e.t ?? 0)));
      labeled.push({ t: e.t ?? 0, type: laterDone ? "swap" : "skip" });
      if (laterDone && e.step) flagged.add(e.step); // the step done out of order
    }
  }
  const set = [...new Set(labeled.map((l) => l.type))];
  const primary = labeled.length ? labeled[0].type : "none"; // earliest anomaly
  return { set: set.length ? set : ["none"], primary, flagged: [...flagged] };
}

// ---------- baseline: one Neon call on the full video ----------
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
async function baselineFor(run, ai) {
  const video = run.video || run.file.replace(/\.json$/, ".webm");
  const vpath = path.join(RUNS, video);
  if (!fs.existsSync(vpath)) return { error: null, step: null, note: "no video" };
  const data = fs.readFileSync(vpath).toString("base64");
  const stepList = run.steps.map((s, i) => `${i + 1}. [${s.id}] ${s.name} — done when: ${s.done_when}`).join("\n");
  const prompt =
    `Here is a procedure, in order:\n${stepList}\n\n` +
    `Watch the whole video of a person performing it. Did they make exactly one of these errors?\n` +
    `- "none": all steps done in order, nothing extra\n- "skip": a step was never done\n` +
    `- "swap": two steps were done in the wrong order\n- "extra": an extra hands-on action not in the list\n` +
    `Return JSON only: {"error":"none|skip|swap|extra","step":<step id involved or null>}`;
  const t0 = Date.now();
  const res = await ai.models.generateContent({
    model: NEON_MODEL,
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/webm", data } }, { text: prompt }] }],
    config: { responseMimeType: "application/json" },
  });
  const text = typeof res.text === "function" ? res.text() : res.text;
  const m = String(text || "").match(/\{[\s\S]*\}/);
  const j = m ? JSON.parse(m[0]) : {};
  const err = TYPES.includes(j.error) ? j.error : null;
  return { error: err, step: j.step ?? null, ms: Date.now() - t0 };
}
async function runBaseline() {
  const cache = loadCache();
  if (NO_BASELINE) return cache;
  const todo = runs.filter((r) => !cache[r.file]);
  if (todo.length === 0) return cache;
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set; skipping baseline for uncached runs.");
    return cache;
  }
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  console.log(`Baseline: ${todo.length} uncached run(s) via ${NEON_MODEL}...`);
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const r = todo[idx++];
      try {
        cache[r.file] = await baselineFor(r, ai);
        console.log(`  ${r.file}: ${cache[r.file].error} (${cache[r.file].ms ?? "-"} ms)`);
      } catch (e) {
        console.warn(`  ${r.file}: baseline failed: ${e.message}`); // not cached, retried next run
      }
      fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return cache;
}

// ---------- scoring ----------
function score(rows, key) {
  const conf = Object.fromEntries(TYPES.map((t) => [t, Object.fromEntries([...TYPES, "?"].map((p) => [p, 0]))]));
  let n = 0, ok = 0;
  for (const r of rows) {
    const pred = r[key];
    if (pred === undefined) continue; // no baseline for this run
    const card = TYPES.includes(r.card.type) ? r.card.type : "none";
    conf[card][TYPES.includes(pred) ? pred : "?"]++;
    n++;
    if (pred === card) ok++;
  }
  return { conf, n, ok, acc: n ? ok / n : null };
}
const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const mark = (b) => (b == null ? "-" : b ? "✓" : "✗");

const cache = await runBaseline();
const rows = runs.map((r) => {
  const sys = systemPredict(r);
  const b = cache[r.file];
  const card = r.card.type;
  let stepOk = null;
  if ((card === "skip" || card === "swap") && r.card.step) {
    stepOk = sys.flagged.includes(r.card.step) || (r.card.step2 ? sys.flagged.includes(r.card.step2) : false);
  }
  const ms = r.events.map((e) => e.ms).filter((x) => typeof x === "number");
  return {
    file: r.file, player: r.player || "?", split: r.split, card: r.card,
    sysSet: sys.set, sys: sys.primary, sysInSet: sys.set.includes(card), sysOk: sys.primary === card,
    flagged: sys.flagged, stepOk,
    base: b && b.error ? b.error : b ? "?" : undefined, baseOk: b ? b.error === card : null,
    ms,
  };
});

function block(label, rs) {
  const s = score(rs, "sys"), b = score(rs, "base");
  const inSet = rs.filter((r) => r.sysInSet).length;
  const stepRows = rs.filter((r) => r.stepOk !== null);
  const allMs = rs.flatMap((r) => r.ms);
  const meanMs = allMs.length ? Math.round(allMs.reduce((a, c) => a + c, 0) / allMs.length) : null;
  const lines = [];
  lines.push(`### ${label} (${rs.length} runs)`);
  lines.push("");
  lines.push(`| | System (Decision 1 loop) | Baseline (one ${NEON_MODEL} call) |`);
  lines.push("|---|---|---|");
  lines.push(`| Exact accuracy | ${s.ok}/${s.n} = ${pct(s.acc)} | ${b.ok}/${b.n} = ${pct(b.acc)} |`);
  lines.push(`| Card type in predicted set | ${inSet}/${rs.length} = ${pct(rs.length ? inSet / rs.length : null)} | - |`);
  lines.push(`| Right step (skip/swap cards) | ${stepRows.filter((r) => r.stepOk).length}/${stepRows.length} | - |`);
  lines.push(`| Mean Decision 1 latency | ${meanMs == null ? "n/a" : meanMs + " ms"} (${allMs.length} calls) | - |`);
  lines.push("");
  for (const [name, sc] of [["System", s], ["Baseline", b]]) {
    if (!sc.n) continue;
    lines.push(`${name} confusion (rows = card, cols = predicted):`);
    lines.push("");
    lines.push(`| card \\ pred | ${[...TYPES, "?"].join(" | ")} |`);
    lines.push(`|---|${[...TYPES, "?"].map(() => "---").join("|")}|`);
    for (const t of TYPES) lines.push(`| ${t} | ${[...TYPES, "?"].map((p) => sc.conf[t][p]).join(" | ")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

const table = [
  "| # | File | Split | Player | Card | System (set) | Sys | Step | Baseline | Base |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r, i) => {
    const card = r.card.type + (r.card.step ? `:${r.card.step}` : "") + (r.card.step2 ? `/${r.card.step2}` : "");
    return `| ${i + 1} | ${r.file} | ${r.split} | ${r.player} | ${card} | ${r.sys} (${r.sysSet.join(",")}) | ${mark(r.sysOk)} | ${mark(r.stepOk)} | ${r.base ?? "-"} | ${mark(r.baseOk)} |`;
  }),
].join("\n");

const holdout = rows.filter((r) => r.split === "holdout");
const rest = rows.filter((r) => r.split === "rest");
const md = [
  `## Eval results (${new Date().toISOString()})`,
  "",
  `Runs: ${rows.length} (first ${Math.min(HOLDOUT_N, rows.length)} = holdout). Sys = earliest flagged error vs secret card; Step = flagged the card's step.`,
  "",
  table,
  "",
  block("Holdout (first 10)", holdout),
  rest.length ? block("Rest", rest) : "",
  block("Combined", rows),
].join("\n");

console.log(md);
fs.writeFileSync(OUT_MD, md + "\n");
console.log(`\nWrote ${path.relative(ROOT, OUT_MD)}`);
