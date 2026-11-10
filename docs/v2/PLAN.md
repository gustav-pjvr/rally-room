# Rally Room v2 | plan

Written 2026-11-10 before any v2 code. The brief is `docs/v2/BRIEF.md`; this
file turns it into milestones, each with the check that means done.
`docs/v2/PROGRESS.md` says where the work stands; `docs/v2/DECISIONS.md`
records every decision and its reason.

## 1. What v1 gives us, and what v2 does with it

Read on `main`: the rules engine (`src/host/game/match.ts` and friends) is
analytic, seeded and side-agnostic in its core (every rule uses `sideSign`),
with 198 tests and a contact model tuned on measurements. The presentation
(renderer, UI, audio, phone page) is a first pass. Detection is tuned on real
recordings and frozen by the brief.

| Part | v2 treatment |
|---|---|
| Swing and spin detection (`src/shared/swing.ts`, `profile.ts`, `calibration.ts`) | Ported unchanged (hard limit 8). Held-out numbers reported. |
| Rules engine (match, contact, physics, solver, scoring, ai) | Kept as the core and moved to `src/engine/`. Generalised: any seat human or CPU on either side, CPU personalities, practice, tutorial, match record for replays. Its tests stay as the regression net. |
| Seats, timeline, clock sync | Kept, extended to four seats on two sides. |
| Renderer, UI, audio | Rebuilt from an approved design direction. |
| Phone page | Rebuilt from the same direction; the racket face stays the signature. |
| Relay | Rebuilt by an Opus subagent as one pure core with two adapters (Node `ws`, Cloudflare Worker with a Durable Object) and one conformance suite. |
| e2e | Kept and extended: `chain.mjs` in every mode at 0, 50 and 120 ms. |

## 2. Target layout

```
src/shared/    detection (unchanged), protocol v2, clock
src/engine/    pure rules: match, contact, physics, solver, scoring, cpu,
               personalities, practice, tutorial, record (replay data), stats
src/sim/       player simulator (pure): swing synthesis, human models, runner
src/host/      app shell: net, seats, timeline, screens, scene (three.js), audio
src/phone/     phone page
src/lab/       sensor lab (developer page, kept)
server/        relay core, Node adapter
worker/        Cloudflare Worker and Durable Object adapter
tests/         unit tests and fixture replays
e2e/           browser checks through the real pages
scripts/       scan (dashes, names, emails), simulator reports, perf report
docs/v2/       brief, plan, progress, decisions, design, mock-ups, report
```

## 3. Milestones

Each milestone ends with: its check green, `npm run verify` green, a scan for
dashes, organisation names and email addresses, a commit on `v2`, a push, and
a PROGRESS update. Major milestones (marked R) also get an independent Opus
review, fixes with a failing test first, and one fresh re-check.

### M0. Foundations
- Baseline: `npm run verify` (198 tests) and `npm run e2e` green on the untouched code.
- Fixture split: tuning and held-out sets written down in `docs/v2/FIXTURE-SPLIT.md`
  and in `tests/fixtures/split.ts`; a test prints the fixed-rule and calibrated
  accuracy on both sets.
- `scripts/scan.mjs` and stricter `tsc` flags wired into `npm run verify`.
- Engine moved to `src/engine/` with no behaviour change.
- **Done when:** verify is green with the scan, all v1 tests pass after the
  move, and the four detection numbers are in PROGRESS.

### M1. Engine v2 (R, review at high)
- Seats: `MatchConfig.seats` lists every player (side, half, human or CPU,
  personality, level). Co-op and versus are both just seat lists.
- Versus: humans on both sides, 1 against 1 and 2 against 2, CPUs fill empty seats.
- CPU personalities: a small cast with distinct play (retriever, hitter,
  angle player, serve specialist), each at three levels.
- Practice: a ball feeder, court targets, a target score, no match scoring.
- Tutorial: scripted lessons that teach serve, "timing is aim" (early goes
  cross-court, late goes down the line) and spin, each passed by doing.
- Match record: every point's ball paths, hits and swings, for the replay and
  the end screen (score line, best rally, fastest swing).
- **Done when:** unit tests cover each item; seeded matches finish in every
  mode; the v1 playability table is reproduced within tolerance.

### M2. Player simulator (R, review at high)
- Swing synthesis fitted on the tuning set only. Validation: synthetic swings
  through the real `SwingDetector` must match the held-out recordings
  (detection rate, peak rate spread, direction, spin word by label) within
  thresholds written in the test. If validation fails, the simulator is not
  used for tuning and DECISIONS says so.
- Human models: timing error and reaction distributions by skill, spin habits,
  a backhand that drifts, network jitter.
- Runner: thousands of seeded matches per configuration through the engine,
  reporting rally length, error types, outcome spread and how often a
  well-timed swing does what the player meant.
- **Done when:** validation passes, and `npm run sim` writes a report to `docs/v2/sim/`.

### M3. Relay (R, built and audited by Opus at high, never by Fable)
- Protocol v2: validated message shapes, a size cap per message type, a rate
  limit per socket, a cap on rooms and on join attempts, room isolation.
- One pure core; adapters for Node `ws` (dev server) and for a Cloudflare
  Worker with a Durable Object; one conformance suite that both must pass.
- Local proof with `wrangler dev` or miniflare. Nothing deployed.
- **Done when:** the conformance and safety tests pass against both adapters.

### M4. Design direction
- Typography, colour, motion and background decided one at a time and written
  in `docs/v2/DESIGN-V2.md` before any markup.
- Three clearly different direction mock-ups (static HTML in
  `docs/v2/mockups/`) for title, lobby, match, phone racket and split screen.
  I pick one and record why.
- **Done when:** mock-ups are screenshotted at 390 px, desktop and 1920 x 1080,
  and the choice is in DECISIONS.

### M5. Scene (R, review at medium)
- The dusk hard court with real lighting and shadow maps, floodlights that
  warm up, long shadows, animated figures (run, swing, serve, celebrate), a
  crowd that reacts to rally length, ball trail and landing marker.
- Views: one camera per view; split screen draws two views with a vertical
  divider. Replay camera with the swing path drawn from the phone's sensor trace.
- A quality governor that lowers resolution or shadow cost when frame times
  exceed the budget.
- **Done when:** `e2e/perf.mjs` meets the frame budget over full rallies in
  single and split view, and the screenshots pass my own look.

### M6. Host app (R, review at medium)
- Screens: title, mode and setup, lobby with QR and first-session help
  (certificate warning, motion permission, firewall), match HUD, split HUD,
  pause, replay, match end, practice HUD, tutorial overlays.
- Audio v2 (Web Audio synthesis, original sounds). Loading feedback on every
  action that waits. Keyboard fallback and takeover for every human seat.
- **Done when:** `e2e/qa-host.mjs` passes (axe, keyboard flow, states, edge cases).

### M7. Phone app (R, review at medium)
- Join, allow motion, lobby with swing test and spin teaching, racket face,
  per-mode prompts, tutorial hints, sensor trace for the replay, haptics,
  reconnect and rejoin.
- **Done when:** `e2e/qa-phone.mjs`, `calib.mjs` and `rejoin.mjs` pass.

### M8. End to end
- `chain.mjs <mode> <jitter>`: whole matches by simulated phones through the
  real pages, in every mode (co-op singles, co-op doubles, versus, versus
  doubles, practice, tutorial), at 0, 50 and 120 ms.
- `identity.mjs` and `rejoin.mjs` extended to versus seats; keyboard takeover.
- **Done when:** `npm run e2e` is green against `npm run dev`.

### M9. Feel and difficulty tuning
- Tune windows, flight, sounds, camera and haptics against the simulator and
  the perf numbers; tune the CPU ladder so each level has a target win rate
  for each simulated skill. Numbers recorded in `docs/v2/TUNING.md`.
- **Done when:** the targets in TUNING are met and chain still passes.

### M10. Ready to ship
- Production build with the bundle split and reasoned about; frame-time
  numbers recorded; relay proven locally on both adapters.
- **Done when:** `npm run build` passes with no unexplained warning.

### M11. Close out
- `/web-design-guidelines`, site-qa checks and the `ui-reviewer` agent on
  every screen at 390 px, desktop and 1920 x 1080.
- Final scan of the diff from `main`; REPORT, HANDOVER, memory, vault sync;
  commit and push.

## 4. Order and parallel work

M0 first. Then M1 in the main thread while two independent jobs run as
subagents: M3 (relay, Opus) and M4 (mock-ups, Opus at high). M2 follows M1.
M5 to M7 follow the chosen design. M8 to M11 close the loop.

## 5. Delegation rules for this run

- As first written: Haiku for read-only surveys, Sonnet for scoped coding,
  Opus for the relay, reviews and design direction.
- **Changed by Gustav during the run (2026-11-10):** limit agents on other
  models and prefer Fable over Opus and Sonnet; Haiku may continue. From then
  on: the main Fable session does the work, with at most one Fable subagent
  at a time for a bounded piece or an independent review, and Haiku for
  read-only surveys. The Opus relay build already running finishes; Gustav
  then allowed Fable to do security work on this project, so the relay audit
  and its re-check are done by a fresh Fable subagent. The three Opus design
  agents were cancelled a few minutes after launch; the mock-ups are made on
  Fable. `ui-reviewer` still checks every screen before it is called done.
- Every launch names its model, its files and its check, and tells the agent
  to do the work itself.
- The laptop is shared: before any test run, check CPU and memory load; if it
  is busy, do other work and try later. Subagents get the same rule, and
  test-heavy agents do not run side by side.

## 6. Risks

| Risk | Answer |
|---|---|
| No real phone in the loop | Fixture replays for detection, the validated simulator for play, and a list of what only a real phone can confirm in the REPORT. |
| Headless Chrome renders in software | Frame times are measured in headed Chrome on the real GPU; headless is used for logic checks only. |
| Split screen doubles the draw cost | One shared scene, two cameras, shadows rendered once per frame; the governor covers weak machines. |
| The dev server reloads pages on file edits | e2e runs happen between edits, never during a subagent's writes. |
| A long run loses context | PROGRESS is updated at every milestone and re-read after a compaction. |
