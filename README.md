# Showunce

Show it a hands-on procedure **once** on camera. It watches the next person live and calls out loud the moment they **skip** a step, **swap** two steps, or add an **extra** step.

It checks steps against a procedure. It never judges people.

- Track: **Problem Statement Two ("Element 119")**: video is the core input, the real-time loop is pushed as hard as it goes, and we show where it breaks.
- Demo procedure: "pack the kit" (bag, gloves, glasses, tape, charger, water), 5 steps.
- All code was written at the Gemini 4 NYC Hackathon on Nov 21 2026.

## Models (one job each)

| Model | Job |
|---|---|
| `gemini-4-neon` | Teaching video -> JSON step list `{id, name, done_when}`. Also the one-call eval baseline. |
| `gemini-decision-1` (Decisions API) | Per 4-second clip: one yes/no (`noul`) question per pending step, plus "extra action?", with probabilities |
| `gemini-4-carbon` | One short, neutral spoken alert sentence (the client falls back to a template after 2.5 s) |

## How it works

```
TEACH:  teaching video --> /api/plan (Neon) --> steps s1..sN

RUN (webcam, loops until Stop):
  [record clip 4s] --> /api/check (Decision 1, not awaited) --> answers {s1: p, ..., extra: p}
  [record next clip 4s]   ...runs while the previous clip is being checked...
        |
        v
  p >= 0.7            -> step done (turns green)
  step N done while an earlier step isn't  -> "skip_or_order" alert
  extra p >= 0.8 (at most once per 10 s)   -> "extra" alert
  Stop: any step never done                -> "skipped" alert
        |
        v
  /api/alert (Carbon) -> one sentence -> browser text-to-speech

SAVE:   /api/log -> runs/run-<ts>.json (steps, events, secret card) + run-<ts>.webm
```

Each clip comes from its own MediaRecorder, so every clip is a standalone webm.

## Setup

```bash
npm install
export GEMINI_API_KEY=...        # PowerShell: $env:GEMINI_API_KEY="..."
npm start
# open http://localhost:3000
```

Optional env vars: `NEON_MODEL` (default `gemini-4-neon`), `CARBON_MODEL` (default `gemini-4-carbon`), `PORT` (default 3000).

### Smoke test (Decision 1)

```bash
node smoke.js path/to/clip.webm
```

It prints the yes/no answer and the latency.

## Eval method

- Players from **outside the team** draw a secret card: `none`, `skip`, `swap`, or `extra`. They perform the procedure. Then we set the card in the UI and click Save.
- The **first 10 runs are a holdout**. We report them separately from the rest and from the combined total.
- **System prediction** comes from the live event log. `skip` = a step was flagged and never done. `swap` = a step was flagged and done later. `extra` = an extra-action alert fired. `none` = no alerts fired.
- **Baseline** = one `gemini-4-neon` call on the full run video, asked to classify `none|skip|swap|extra`. Results are cached in `runs/baseline-cache.json`.
- Run it:

```bash
npm run eval                 # system + baseline
node eval.js --no-baseline   # system only
```

This writes `runs/eval-results.md`.

## Results

TODO: paste `runs/eval-results.md` here.

## Where it breaks

- TODO: failure type the system misses most often (from the confusion table)
- TODO: Decision 1 latency vs. 4 s clip length (when the loop falls behind)
- TODO: steps that span a clip boundary
- TODO: fixes made at 3:45 and before/after numbers
