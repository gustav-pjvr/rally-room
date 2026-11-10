# Rally Room v2 | progress

Re-read this after any context compaction, before continuing. Update it at
every milestone.

## Standing rules (short form; the brief has the full list)
- Branch `v2` only. Never touch `main`. Never force-push. Push `v2` after each milestone.
- No deploys, no secrets, no organisation names or email addresses, no em or en dashes.
- Detection files are ported unchanged.
- Before any test run, check CPU and memory load (the laptop is shared). If
  busy, do other work and retry later. Subagents get the same rule.
- Port 5280 is ours (a Vite dev server for this folder was already running at
  the start, PID 15364 then). Never touch 5173.
- **Model routing, changed by Gustav on 2026-11-10 during the run:** limit
  agents on other models; prefer Fable over Opus and Sonnet; Haiku is fine for
  read-only legwork. So: do the work in the main Fable session, or in one
  Fable subagent at a time (`model: "fable"`). No Sonnet agents. The Opus
  relay build that was already running is allowed to finish; after it, Gustav
  said Fable may do security work on this project too, so the relay audit and
  re-check go to a fresh Fable subagent. No new Opus agents.
- Subagents: `model` set, tagged description, files named, "Do not spawn any
  subagents. Do all of this work yourself, directly." Background agents go
  through `delegate_task`; foreground ones through `Agent`.

## PAUSED (2026-11-10, at Gustav's request)
Gustav said: "allow everything to finish and then pause work". No new work is
started. The two background jobs that were running finish on their own; their
output is then checked, committed and pushed, and the run stops there.
**To resume:** re-read this file, then continue from "Next steps" below.

## Next steps when work resumes
1. Relay (M3): if not yet done, verify the Opus agent's result (`npx vitest run tests/relay*`, `npm run test:worker`, typecheck, scan), commit it, then have one fresh Fable subagent audit it (room isolation, limits, malformed input, host resume) and re-check the fixes.
2. Add `scripts` and `vitest.sim.config.ts` to tsconfig `include`, and `"sim": "vitest run --config vitest.sim.config.ts"` to package.json (held back while the relay agent owned those files).
3. Design (M4): run directions B (club scoreboard) and C (broadcast '75) one at a time on a Fable subagent with the same brief as A (the brief is in this session's history; its content is DESIGN-V2.md sections 3 to 7 plus the file list and checks that `docs/v2/mockups/a-poster/` shows), compare the three contact sheets, pick one, record why in DECISIONS (and move D10 below D9 there: entries are meant to be newest last).
4. Independent review of M1 and M2 (engine and simulator) by a fresh Fable subagent; fix findings with a failing test first; one re-check.
5. Host pure modules still to write: seats for four players on two sides (rewrite of `src/host/phones.ts`), per-phone messages for any seat, frame-time recorder and quality governor. Then the client side of protocol v2 in `src/host/net.ts` and `src/phone/net.ts` (new URL scheme, room key, host-away and host-back, `hb` keepalive, `trace`).
6. Then M5 (scene), M6 (host app), M7 (phone app), M8 (e2e and chain in every mode), M9 (tuning, see notes), M10, M11.

## State

| Milestone | State | Notes |
|---|---|---|
| M0 Foundations | done except the e2e baseline | verify baseline green (198 tests). Fixture split written; detection reference: fixed rule 73% overall, 69% held-out; calibrated 81% overall, 85% held-out. Scan and strict flags in verify. Engine moved to `src/engine/`. The v1 e2e baseline was never run: the CPU was pegged by another project's browser tests for the whole first hours. |
| M1 Engine v2 | built, tests green, review pending | Seats on both sides (versus 1v1 and 2v2), CPU characters (`personalities.ts`), per-player windows and stats, richer events, drills (`drill.ts`: practice zones, tutorial). 227 unit tests pass (relay tests excluded: in progress). |
| M2 Simulator | built, validated, review pending | `src/sim/` runner, synthetic swings (templates from teach and tuning, checked against held-out: detection 98%, peak offset median 5 ms, KS to held-out 0.13 against 0.13 for the real tuning swings, spin accuracy 73%), player models, analysis, `scripts/sim/report.sim.ts`. First report (12 matches per cell) in `docs/v2/sim/REPORT.md`. |
| M3 Relay | built and committed, audit pending | Opus build finished. `server/core.ts` (pure core), `server/relay.ts` (Node `ws`; new paths `/ws/host` and `/ws/room/<CODE>`, v1 `/ws` kept until the clients move), `worker/` (one Durable Object per room, hibernation, assets binding), `docs/v2/PROTOCOL.md`. Checked in this session: typecheck, scan, 60 relay tests (39 core, 14 conformance on Node, 4 Durable Object, 3 legacy). The Worker suite (`npm run test:worker`, 14 tests under local `wrangler dev`, no login) was run by the agent only, not re-run here. Nothing deployed. Audit and re-check by a fresh Fable subagent still to do. |
| M4 Design direction | direction A done, B and C not started | `docs/v2/DESIGN-V2.md` written. Direction A (tournament poster) is in `docs/v2/mockups/a-poster/`: five host screens, the phone page, NOTES.md, fonts Big Shoulders Display 900 and Barlow 500 to 700 (bundled, OFL). Its contact sheet is `docs/v2/mockups/a-poster/shots/sheet.png` (ignored by git; regenerate with the scripts in `shots/`). My first look: strong and on-brief (flat dusk bands, sun disc, dotted crowd, huge condensed type, teams told apart by plain and hooped shirts, timing strip plus contact word, split screen reads well). Weak points: the lobby is dense and reads like a schedule; the flat court sets a look the 3D scene has to match. No direction is chosen yet: B and C still have to be made and compared. |
| M5 Scene | not started | Pure pieces ready: `src/shared/trace.ts` (phone recorder, validation, racket path; on the real swings topspin rises and slice falls) and `src/host/replay.ts` (clip of the deciding shot at 0.4 speed, trace attached). |
| M6 Host app | not started | |
| M7 Phone app | not started | |
| M8 End to end | not started | |
| M9 Tuning | not started | See "Tuning notes" below. |
| M10 Ready to ship | not started | |
| M11 Close out | not started | |

## Tuning notes from the first simulator report (for M9)
- The CPU ladder is too hard for simulated phone players: a Regular wins 17% against The Regular at Club, nobody beats Pro, a Beginner wins nothing at Rookie on Normal timing.
- The Wall is overtuned: it beats even a Sharp player at Rookie.
- Real swings give modest power (median 0.46), so the human's balls are slow and the CPU is never under pressure; human winners are rare. Candidate: map power relative to each player's own swing range.
- Candidate: an "Auto" timing window per player (the engine already has per-seat windows).
- Versus is healthy: 3.5 shots per point for beginners, 6 for casual players, 10 to 12 for skilled ones; a first-to-3-games match takes 4 to 10 minutes.
- Lag up to 300 ms costs nothing measurable (lag compensation works).
- The tutorial takes 1.3 to 1.6 minutes and every simulated skill finishes it.
- Two bots with bounded, uniform timing error never miss and rally for ever: use normal (Gaussian) error in tests.

## Environment notes
- Shell heredocs fail when the body has an odd number of apostrophes: write files with the Write tool and run scripts from the scratchpad.
- The CPU is often above 90% from another project's Playwright runs (not ours). Check before every test run; single test files are light, the full suite takes 8 s on a free machine.
- `npx vitest run --exclude "tests/relay*" --exclude "tests/relay/**"` runs everything but the relay agent's work in progress.

## Log
- 2026-11-10: branch `v2` created; first commit holds the brief and the
  handover note. Read HANDOVER, DESIGN and the v1 core. PLAN and DECISIONS written.
- 2026-11-10: Gustav changed the routing during the run (Fable first, no more Opus or Sonnet agents; the running Opus relay build finishes; Fable may do security work here). Three Opus design agents cancelled.
- 2026-11-10: M0 done apart from the e2e baseline; M1 and M2 built and tested.
- 2026-11-10: trace and replay modules written and tested. Gustav asked to let the running jobs finish and then pause.
- 2026-11-10: relay build finished, checked and committed.
- 2026-11-10: direction A mock-ups finished and committed. All background jobs are done; the run is paused.

## Relay: what the audit should look at first (from the builder's own report)
- Room codes can be guessed across many connections on the Worker: per-address limits only cover one isolate and one room object. A deployment needs a Cloudflare rate-limiting rule on `/ws/host` and `/ws/room/*`.
- Neither adapter checks the Origin header.
- `trace` and `profile` are only checked structurally by the relay; the host must validate them (`isTrace` in `src/shared/trace.ts` does this for traces).
- The right key replaces a live host socket on purpose (takeover).
- Idle detection on the Worker depends on clients sending `{"t":"hb"}` every 10 s.
- Client changes the relay needs (not made yet): `src/host/net.ts` opens `relayPath({create:true})`, stores `key` from every `room` message, resumes with `{t:'host', resume:{code,key}}` on `relayPath({room})`, sends the heartbeat frame, handles `replaced`; `src/phone/net.ts` opens `relayPath({room})`, shows a waiting state on `host-away` until `host-back`, sends the heartbeat frame, treats close code 4001 like `host-gone`.

## Broken or open
- v1 e2e baseline not run (see M0). The v1 host and phone pages still run on the moved engine; they are replaced in M6 and M7.
- `scripts/` and `vitest.sim.config.ts` are not in tsconfig `include` yet (tsconfig is in the relay agent's hands until it finishes).
- `npm run sim` script entry not added to package.json yet (same reason): run `npx vitest run --config vitest.sim.config.ts`.
