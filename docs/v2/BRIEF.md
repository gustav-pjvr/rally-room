# Rally Room v2 | rebuild brief

Written 2026-11-10 by the Opus session with Gustav, for an autonomous Fable 5.2
session. Gustav agreed every point below. Read all of it before you start.

## 1. Your mission

Rebuild Rally Room as **the best phone-as-racket tennis game a browser can
run.** A household that has never seen it scans a QR code and is in a rally
that feels right within a minute, and it looks good enough that they show it
to friends.

The current build (branch `main`) is your reference for the idea, not a
codebase you must keep. Read it, learn what was measured and why, then build
v2 the best way you can. Reuse what earns its place, rewrite or replace the
rest.

## 2. Your authority

- **You own every decision.** Gustav gives no input until you finish. Do not
  ask him anything and do not wait for him. When something is ambiguous,
  decide, and record the decision and its reason in `docs/v2/DECISIONS.md`.
- You have every tool and permission in this session. Use subagents as set out
  in section 7.
- Run until the acceptance list in section 9 is met, then write the final
  report (section 10). There is no time or token ceiling, but spend with sense:
  every subagent needs a reason.

## 3. Hard limits (these override anything else in this brief)

1. **Branch `v2` only.** First action: `git switch -c v2` (or switch to it if it
   exists). Commit freely there at every milestone and push to `origin v2`.
   Never commit to, merge into, rebase or force-push `main`. Never force-push
   `v2` either.
2. **No deploys and nothing public** beyond pushing `v2` to the existing repo.
   No Cloudflare deploy, no tunnels, no posting anywhere. Build the deployable
   relay, prove it locally, stop there.
3. **No secrets.** You do not need tokens or accounts. Never ask for or store one.
4. **Public repo hygiene.** The repo is public. Never put organisation names or
   email addresses in it (code, docs, fixtures, commit messages). Do not infer
   project facts from the account's email domain or org. Commits use the
   repo-local GitHub noreply address that is already configured; do not change
   git config. `.gitattributes` pins LF; keep it (the CSV fixtures break with CRLF).
5. **No em dashes or en dashes** (U+2014, U+2013) in anything you author: code,
   comments, docs, UI copy, commit messages. Rewrite the sentence instead.
   Scan before every commit.
6. **Originality.** Original world, characters, sounds and look. Do not
   recreate any existing tennis or motion-control game (its look, characters,
   courts or sounds), even renamed.
7. **The machine is shared.** Port 5280 is this project's dev server; another
   project owns 5173; do not touch it. Only stop a process you started, or the
   node process listening on 5280 that serves this folder. Do not change
   Windows settings, firewall rules, DNS, browser policies or anything outside
   this folder, except the per-project memory and the vault (section 10).
8. **Swing and spin detection** (`src/shared/swing.ts`, `profile.ts`,
   `calibration.ts`) were tuned on Gustav's real phone recordings, and you
   cannot record new ones. Port them as they are. You may change detection only
   if the new version beats the current results on recordings it was not tuned
   on: the fixed spin rule scores 73% on his labelled swings, calibration 81%.
   Split the fixtures into tuning and held-out sets before you start, write the
   split down, and report both numbers. A change that does not beat both on
   the held-out set is reverted.

## 4. What to read first

- `docs/HANDOVER.md`: state, decisions, how work was run.
- `docs/DESIGN.md`: the full design with measured numbers. Sections 1 (brief
  and look), 4 and 4a (detection and phone setup), 5 (game, contact model),
  6 (screens) matter most.
- `src/` (host, phone, lab, shared), `server/relay.ts`, `vite.config.ts`.
- `tests/` and `tests/fixtures/` (real A32 recordings, labelled CSVs, replay helpers).
- `e2e/` (browser checks; `chain.mjs <jitter ms>` plays a whole match with a
  simulated phone through the real pages).

Run `npm run verify` (198 tests) and `npm run e2e` (needs `npm run dev`) on
the untouched branch first so you know the baseline is green.

What stays true from v1 unless you find strong evidence against it (record it
in DECISIONS if you change one):
- The phone is the racket; no app install; join by QR over the same Wi-Fi.
- Timing is aim; where the ball meets the strings sets power and direction.
- Announced outcomes are final; nothing is hit before the first bounce or
  after the second.
- Players are bound to a stable phone id, not to a relay slot.
- The phone screen is the racket face with the contact ripple and haptics.
- iPhone is untested (no iPhone in the house); the axis calibrator is the
  safety net. Keep the iOS permission path correct by the spec.

## 5. What to build: the five pillars

1. **Feel.** Contact, timing windows, ball flight, hit sounds, camera and
   haptics tuned so a good swing feels good and a bad one tells you why.
   Tune against measurements (section 6), not taste alone, and write the
   numbers down.
2. **Look.** The dusk hard court made properly (DESIGN.md section 1: 1970s
   tennis-poster palette, floodlights warming up, long shadows): real
   lighting and shadows, animated player figures, a crowd that reacts to
   long rallies, the point replay with the swing path drawn from the phone's
   own sensor data, and a proper match-end screen (score line, best rally,
   fastest swing). Readable from across a room on a TV.
3. **Depth.** Computer opponents with distinct personalities and levels, a
   practice mode with targets, and a short tutorial that teaches "timing is
   aim" by doing. Co-op singles and doubles against the computer stay.
4. **Split-screen versus (Gustav authorised it for v2).** Two phones play
   against each other, each player with their own view of the court on one
   screen (split vertically or horizontally, your call, readable on a TV).
   Then 2 against 2 if it fits. The co-op modes must keep working.
5. **Robustness and ready to ship.** A steady 60 fps on a mid-range laptop
   (measure frame times, set a budget, meet it), clean recovery when a phone
   drops or reloads, a production build without size warnings you have not
   reasoned about (three.js is large: split or justify), and a relay that runs
   as a Cloudflare Worker with a Durable Object as well as on the local dev
   server, proven locally (for example with `wrangler dev` if available
   without an account, otherwise with a faithful local harness), not deployed.

Scope is yours beyond this list: add what makes the game better, cut what
does not, and say why in DECISIONS.

## 6. Testing without a human

You cannot hold a phone, so build the evidence another way:
- Pure modules get unit tests. Anything that drives the game gets a browser
  check in `e2e/` that runs through the real pages, and `npm run e2e` runs
  them all.
- Keep and extend `chain.mjs`: full matches with a simulated phone at several
  jitter levels (at least 0, 50 and 120 ms), in every mode including split screen.
- Real recordings in `tests/fixtures/` are the ground truth for swings.
- Measure performance in a real browser (frame times over a full rally, not
  one frame).

**Optional, if you judge it feasible: a player simulator.** Gustav suggests a
system that simulates real players, so you can test what you build the way a
person would play it. For example: synthetic phone sensor streams generated
from models fitted to the real recordings (swing shapes, peak rates, spin
habits, a backhand that drifts within a session), human timing error and
reaction-time distributions, players of different skill, plus network jitter;
bots that drive whole matches through the real pages and report rally length,
error types, outcome spread and how often a well-timed swing does what the
player meant. Validate it first: its synthetic swings must pass through the
real detector with statistics close to the real fixtures, or do not trust it.
If you build it, use it to tune feel and difficulty, and report what it
showed. If you decide it is not worth it, say why in DECISIONS.

## 7. How to work

- **Plan first.** Write `docs/v2/PLAN.md`: milestones, each with the check that
  means done. Keep `docs/v2/PROGRESS.md` current after every milestone (what is
  done, what is next, anything broken) so the work survives context
  compaction. Re-read PROGRESS after a compaction before continuing.
- **Commit per milestone** on `v2`, with a clear message, and push. Never leave
  the branch red for long; if a milestone breaks something, fix it before the next.
- **Design before markup.** Decide typography, colour, motion and background one
  at a time and write each choice down. For the key screens (title, lobby,
  match, phone racket, split screen), make two or three clearly different
  direction mock-ups as static HTML, pick one yourself, and record why in
  DECISIONS. Use the `scroll-craft` skill's brief, originality and
  verification rules (drop its scroll choreography: this is an app). Take UX
  rules (touch targets, navigation, accessibility, forms) from `ui-ux-pro-max`,
  never its looks.
- **UI verification.** Screenshot every screen at 390 px wide and at desktop
  width (and the TV view at 1920 x 1080). Look for text over imagery, cut-off
  content, overlap, dead space and small tap targets. Run
  `/web-design-guidelines` and the `site-qa` checks (axe, states, edge cases)
  before calling any UI done. Two failed fixes of the same visual defect: stop
  guessing, measure (computed styles, bounding boxes), then fix.
- **Loading feedback.** No tap or click may look as if it did nothing: pending
  states on buttons that wait, a skeleton for anything that waits on data over
  about 300 ms, reduced motion respected.
- **Delegation.** Keep your own context lean. Hand reading and searching to
  Haiku subagents, and well-scoped coding with a runnable check (tests,
  mechanical ports, docs) to Sonnet subagents at medium (high if it falls
  short). Never use Haiku for UI; UI built from an approved design goes to
  Sonnet at high. Every subagent launch sets `model` explicitly, starts its
  description with a task tag (for example `[tests] Port the solver tests`),
  names the files it needs, and its prompt contains: "Do not spawn any
  subagents. Do all of this work yourself, directly." Verify every subagent's
  output yourself before trusting it.
- **Security-sensitive pieces stay off Fable.** The relay (it takes messages
  from any phone, and later from the internet) and anything that writes or
  deletes files, builds paths from outside data or kills processes: have an
  Opus subagent at high build or harden it, with tests that prove the safety
  property (room isolation, message size and rate limits, malformed input).
- **Independent review.** At the end of each major milestone, an Opus
  subagent (effort high for the relay and game logic, medium otherwise) that
  did not write the code reviews it. Fix what it finds with a failing test
  first, then have one fresh Opus subagent re-check the fixes. Before any
  screen is called done, the `ui-reviewer` agent screenshots it and reports
  defects. A reviewer never reviews its own work.
- **The dev server reloads open pages on file changes.** That is fine now (nobody
  is playing), but keep `npm run dev` on port 5280 and HTTPS so phones still work.

## 8. Things Gustav will test himself

He plays on a Samsung A32 (Android, Chrome), sometimes with a second phone for
doubles. Make his first session easy: the QR join, the certificate warning
(tap through once), allowing motion, and "Allow Node.js through the Windows
firewall on private networks" if the phone cannot load the page, all
explained on screen where needed.

## 9. Acceptance list (done means all of these)

- [ ] `npm run verify` green (typecheck, lint if you add it, unit tests).
- [ ] `npm run e2e` green against `npm run dev`, covering every mode: co-op
      singles and doubles, practice, tutorial, split-screen versus, rejoin and
      reload, keyboard takeover.
- [ ] `chain.mjs` full matches pass at 0, 50 and 120 ms jitter in every mode.
- [ ] Detection: held-out results reported; unchanged, or better than 73%
      (fixed rule) and 81% (calibrated) on the held-out set.
- [ ] Frame-time budget written down and met over full rallies, with numbers.
- [ ] Production build passes; bundle size reasoned about.
- [ ] Cloudflare relay runs locally and passes the same relay tests as the
      dev-server relay. Nothing deployed.
- [ ] Every screen screenshotted at 390 px, desktop and 1920 x 1080;
      `/web-design-guidelines`, site-qa checks and `ui-reviewer` passed.
- [ ] Every major milestone independently reviewed, fixes re-checked.
- [ ] No em or en dashes, organisation names or email addresses in the diff
      from `main` (scan it).
- [ ] All work committed and pushed to `origin v2`; `main` untouched.

## 10. When you finish

1. Write `docs/v2/REPORT.md`: what you built, every major decision and why,
   the numbers (detection, frame times, simulator results if built), what you
   cut, known gaps, and what you could not verify without a real phone.
2. Write a section "What Gustav should test first": a short ordered list for
   his first real-phone session, and the labelled lab recordings you would
   like from him next (which swings, how many, which hand).
3. Rewrite `docs/HANDOVER.md` on `v2` for the next session.
4. Update the project memory pointer if anything in it is now wrong, and run
   `/vault-sync` (the Stop hook will ask for it; comply).
5. Optional: send two or three screenshots and a short gameplay capture to
   Gustav's phone with the `relay-native:send-to-phone` skill. Only claim
   they arrived if it printed "Sent to the phone".
6. Commit, push `v2`, and end with a short summary: what is done, how to run
   it, and what he should test first.
