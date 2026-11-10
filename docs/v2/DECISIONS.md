# Rally Room v2 | decisions

Each entry: the decision, the reason, and what would change it. Newest last.

## D1. Keep the stack (2026-11-10)
Vite, TypeScript, three.js, Vitest and playwright-core stay.
**Why:** the stack is not what holds v1 back, and the tests and browser checks
already run on it. **Would change it:** a measured frame-time problem that
three.js cannot meet.

## D2. Evolve the rules engine, rebuild the presentation (2026-11-10)
The v1 engine moves to `src/engine/` and is generalised; the renderer, UI,
audio and phone page are rebuilt.
**Why:** the engine is analytic, seeded, covered by 198 tests and tuned on
measurements (contact model, playability table). Its core is already
side-agnostic, so versus is a seat list, not a rewrite. The presentation is
where v1 falls short of the brief (lighting, figures, crowd, replay, end
screen). **Would change it:** a rule that cannot be expressed in the seat model.

## D3. Detection is ported unchanged (2026-11-10)
`swing.ts`, `profile.ts` and `calibration.ts` are not edited. The replay
trace (D6) is recorded by a separate module beside the detector.
**Why:** hard limit 8, and no new recordings can be made. **Would change it:**
a variant that beats both the fixed rule and the calibration on the held-out set.

## D4. Fixture split by time, later swings held out (2026-11-10)
Within each recording and label, in time order: the first three swings are
the teaching swings (the calibration's own protocol), then the first half of
the rest is the tuning set and the second half is the held-out set.
**Why:** a player's "flat" drifts within a session, so later swings are the
honest test of anything fitted on earlier ones; an alternating split would
leak the drift. The exact lists are in `docs/v2/FIXTURE-SPLIT.md`.

## D5. Split screen is side by side (2026-11-10)
Versus draws two views with a vertical divider, each from behind its own
player's baseline.
**Why:** a court seen from behind a baseline is tall and narrow, so two
8 by 9 views on a 16 by 9 TV keep the whole court, the ball and the far
player in each half. A top and bottom split would give two wide, short views
that crop the court's depth. In 2 against 2, teammates share their side's view.

## D6. The replay's swing path comes from a short sensor trace (2026-11-10)
After each swing the phone sends a second small message with the rotation
rates around the peak (about 40 samples). The host integrates it into the
racket path for the replay.
**Why:** the brief asks for the path "from the phone's own sensor data"; a
separate message keeps the swing message as fast and small as in v1.

## D7. Build the player simulator (2026-11-10)
**Why:** it is the only way to tune feel and difficulty without a person
holding a phone, and the engine is fast enough for thousands of matches per
run. It is trusted only if its synthetic swings pass through the real
detector with statistics close to the held-out recordings (PLAN M2).

## D8. No linter, stricter compiler flags and a scan instead (2026-11-10)
`noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch` are
turned on, and `scripts/scan.mjs` (dashes, organisation names, email
addresses) runs inside `npm run verify`.
**Why:** for a codebase this size the compiler flags catch the same slips a
linter would, without a new dependency and configuration to maintain.

## D10. Fable does the work; other models are the exception (2026-11-10)
Gustav's instruction during the run: limit agents on other models, prefer
Fable over Opus and Sonnet, Haiku may continue. The brief's delegation plan
(Sonnet for scoped coding, Opus for reviews and design direction) is replaced:
the main Fable session builds, one Fable subagent at a time takes a bounded
piece or an independent review, Haiku does read-only surveys.
**Kept on Opus:** only the relay build that was already running. Gustav then
said Fable may do security work on this project, so the relay's audit and
re-check are done by a fresh Fable subagent (this overrides the brief's
"security-sensitive pieces stay off Fable" for this project).
**Cost of the change:** independent reviews are by a fresh Fable context
rather than a different model, so they share Fable's blind spots; the tests,
the simulator and the browser checks carry more of the proof.

## D9. Fonts are bundled, never fetched (2026-11-10)
Any typeface is an open-licence font shipped in the build.
**Why:** the game runs on a home network, possibly with no internet, and a
public repo must not depend on a third-party font host.
