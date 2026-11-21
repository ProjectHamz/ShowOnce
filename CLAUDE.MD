Show Once — Claude Code brief
Read this whole file before writing code. We are at the Gemini 4 NYC Hackathon (Sat Nov 21 2026). Submission is due at 5:00 PM ET; aim to submit at 4:45; feature freeze at 4:00. One developer (Hamza). Speed and a working live demo beat polish.
What we're building
Show it a hands-on procedure once on camera. It watches the next person live and calls out loud the moment they skip a step, swap two steps, or add an extra step.
Track: Problem Statement Two ("Element 119"): video is the core input; push the real-time loop; show where it breaks; use the Decisions API.
Demo procedure: "pack the kit" (bag, gloves, glasses, tape, charger, water), 5 steps.
Judging: Live Demo 35%, Proof It Works 25%, Creativity 20%, Gemini 4 + Decisions API use 20%.
Hackathon rules (breaking any = disqualification)
All code written today. The repo must be public.
Must use at least two Gemini 4 models, each with one clear job (we use Neon + Carbon, plus Decision 1).
Eval cannot be only our own runs: runs come from people outside the team.
No Streamlit. No dashboard as the main feature. Not an image analyzer, sports/health coach, or personality tool: it checks steps against a procedure, never judges people.
Current code (starter, already written today)
```
server.js        Express server, 4 routes
public/index.html  Webcam page: teach, run, save; live step list; alerts; browser TTS
eval.js          Scores saved runs vs secret error card; one-call Neon baseline
README.md        Public README (fill Results + Where it breaks at the end)
runs/            Saved runs: run-<ts>.json (steps, events, card) + run-<ts>.webm
```
Routes:
`POST /api/plan` {video, mimeType} → Neon → `{steps:[{id,name,done_when}]}`
`POST /api/check` {clip, mimeType, steps, allSteps} → Decision 1 → `{answers, ms}`
`POST /api/alert` {kind, step, missed, steps} → Carbon → `{line}` (client falls back to a template after 2.5 s)
`POST /api/log` {player, card, steps, events, video} → writes to `runs/`
Client loop: a fresh MediaRecorder per 4-second clip (so each clip is a standalone webm), sent to `/api/check` without awaiting, so the next clip records while the last one is checked. A step is "done" when its yes-probability is ≥ 0.7. If step N is done while an earlier step isn't, raise `skip_or_order`. `extra` is raised at ≥ 0.8, at most once per 10 s. At stop, any step never done is raised as skipped.
Models
Model	Job	Env var
`gemini-4-neon`	Teaching video → JSON step list	`NEON_MODEL`
`gemini-decision-1`	Per-clip yes/no step checks with probabilities	(fixed)
`gemini-4-carbon`	One spoken alert sentence	`CARBON_MODEL`
`gemini-4-hydrogen`	Fallback if Neon can't take video	—
Decisions API facts (from the official guide; trust these)
SDK 3.2+. JS client: `new GoogleGenAI({ apiVersion: "v1beta" })`. Method: `ai.decisions.create({...})`.
REST: `POST https://generativelanguage.googleapis.com/v1beta/decisions`, header `x-goog-api-key`.
Body: `model: "gemini-decision-1"`, `input` (string, content block, or array of blocks), `questions` (map of key → question).
Question types: yes/no = `type: "noul"` (optional `criteria: {true_description, false_description}`); `choice` (criteria = map of option id → description); `score` (criteria = array of levels, low → high).
Response: `result.answers[key]`. Yes/no answers have `noul` (probability 0.01–0.99) and `confidence`. Choice answers have `choice`, `probabilities`, `confidence`.
Media: inline base64 in `data` (≤ 100 MB per request) or `uri`. Always set the real MIME type (`video/webm`, `video/mp4`…); octet-stream is rejected. Optional `resolution`: `low|medium|high`.
Limits: 1–1,000 questions per call; keys match `[A-Za-z0-9_-]{1,64}`; 262,144-token context shared by input + questions. Errors return HTTP 400 with `error.code` / `error.message`.
UNVERIFIED: the exact content-block field names for video. `server.js` uses `{type: "video", data, mime_type, resolution: "low"}` (marked `// VERIFY`). If the call 400s, check the Quickstart in the Decisions API guide (https://aistudio.google.com/docs/decisions-api) or the Builder Guide, and fix that one object.
Tasks, in order (do not skip ahead)
Decision 1 smoke test (by 1:15). Write `smoke.js`: send one short webm/mp4 clip to `ai.decisions.create` with one `noul` question; print the answer and latency. Fix the content-block shape until it works. Nothing else matters until this works.
Live loop (by 2:00). `npm start`, paste a hand-written 5-step "pack the kit" list into the steps JSON box, run it on webcam. Steps turn green; a skip triggers a spoken alert. Log Decision 1 latency; if it's > 4 s, raise `CLIP_MS`.
Teach (by 2:30). Teaching video → Neon → step list. If Neon rejects video, set `NEON_MODEL` to the model the Builder Guide's video recipe uses.
Carbon alerts. Confirm `/api/alert` returns one short sentence within 2.5 s; otherwise the template line is fine.
Eval (2:30–3:45). Outside players draw a secret card (none / skip / swap / extra), perform, then we set the card and Save. Target 15–20 runs. Run `npm run eval`. First 10 runs = holdout.
Fix the biggest failure type (3:45–4:00), rerun the eval, note before/after.
Freeze at 4:00. Fill README Results + Where it breaks from the eval output.
Coding rules for this session
Keep it one Node server + one HTML file. No frameworks, no build step, no database.
Make the smallest change that works; don't refactor working code.
Never hardcode the API key; read `GEMINI_API_KEY`.
Don't add features beyond the task list unless tasks 1–5 are done.
After each change, tell me the exact command to test it.
Cut list if behind
End report → messy-case tags → `extra` card → Carbon (use template alerts). Never cut: the live catch, the baseline comparison, outside players.
Stretch (only if task 5 is done by 3:00)
"Pack the kit" add-on: missing items go into a shop.dev cart (Shopify prize). Cut at 3:15 if not working.