# Rally Room | handover

Written 2026-11-10 at the end of the first build session. Read this first,
then `docs/DESIGN.md` (the full design, with what was measured and why).

## What it is

Living-room tennis: the laptop or TV runs the court in a browser, each
player's phone is the racket (no app). Co-op against the computer, singles or
doubles with up to two phones. Repo: https://github.com/gustav-pjvr/rally-room
(public, branch `main`).

## Where it stands

| Commit | What |
|---|---|
| `00e5e26` | Phases 1 to 3: sensor lab, relay, swing detection, automatic phone setup, full game, phones in the game |
| `51ec62d` | Racket contact model (where the ball meets the face shapes every shot), fixed spin rule |
| `a000107` | Optional per-player spin calibration |
| (next) | This handover, doc updates, browser checks moved into `e2e/` with `npm run verify` and `npm run e2e` |

All 198 unit tests pass. Every change so far went through an independent Opus
review and a re-check of the fixes.

Gustav has played it on his phone (Samsung A32, Android, Chrome) and was
beating the computer. He has **not yet played** since the contact model and the
spin calibration landed: his next real-phone session is the first test of both.

## Run and test

```bash
npm install
npm run dev        # https://127.0.0.1:5280 (port 5280: another project owns 5173 on this laptop)
npm run verify     # typecheck + unit tests (198)
npm run e2e        # every browser check, needs `npm run dev` running; Chrome at its default Windows path or CHROME_PATH
```

- Phones join over the same Wi-Fi via the QR code; they accept a self-signed
  certificate warning once. If a phone cannot load the page, allow Node.js
  through the Windows firewall on private networks.
- The dev server reloads open pages when files change. Do not edit code while
  Gustav is recording or playing: it reset his phone mid-session once.
- `e2e/chain.mjs <jitter ms>` plays a whole match with a simulated phone
  through the real pages; it is the fastest end-to-end check of any change.

## Decisions that stand (do not undo without Gustav)

- Phone as racket; co-op vs CPU only. **No player against player yet** (Gustav: "no pvp yet"). When it comes: split screen.
- Players are bound to a stable phone id (per room, in localStorage), not to a relay slot.
- Timing is aim; where the ball meets the face (sweet spot, tip, throat, edges, frame, miss) sets power and direction. Announced outcomes are final; nothing is hit before the first bounce or after the second.
- Spin: a fixed rule by default (73% on his labelled swings). The running per-player offset was removed: it erased a player's habitual spin. Optional calibration (81% overall) is per player name per phone.
- Android axis conventions are measured (A32). **iPhone is untested**: the household has no iPhone. The axis calibrator is the safety net.
- Public repo hygiene: commits use the GitHub noreply address (repo-local git config), `.gitattributes` pins LF (the CSV fixtures break with CRLF). Never put organisation names or email addresses in the repo (see the project memory note on not inferring from account context).
- No licence chosen yet (question asked, not answered: MIT or all rights reserved).

## Open items, in a sensible order

1. **Gustav plays again** with the contact model and calibration; collect his notes. Things to watch: Pro CPU may now feel harder (off-centre shots reach it slower); the calibration's real-world value (his backhand "flat" drifts within a session).
2. **Licence** answer, then add the file.
3. **Phase 4 candidates** (his call on order): point replay with the swing path, practice targets, Cloudflare deploy for play without shared Wi-Fi (outward action: ask first), split-screen versus when he wants it.
4. Small leftovers: `clampUnit` in `src/phone/logic.ts` is unused; the main bundle is about 590 kB (three.js) and Vite warns; an optional contact marker on the host screen was skipped.

## How work has been run here

- Main session on Opus. Pure-logic modules get unit tests; anything driving the game is checked with `e2e/chain.mjs`; UI changes get `/web-design-guidelines` plus the site-qa checks (`e2e/qa-*.mjs`) and screenshots at phone and desktop width.
- Real phone recordings are the ground truth for swing work: labelled CSVs from the lab (`/lab/`, "Next swings are" picker) live in `tests/fixtures/` and are replayed by tests. Ask Gustav for a labelled recording before changing detection.
- Each change: build, independent Opus review, fixes (with a failing test first), re-check, verify, then commit and push **only when Gustav says so**.
