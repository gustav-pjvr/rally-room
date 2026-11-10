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
- Subagents: foreground `Agent` calls, `model` set, tagged description, files
  named, "Do not spawn any subagents. Do all of this work yourself, directly."

## State

| Milestone | State | Notes |
|---|---|---|
| M0 Foundations | in progress | verify baseline green (198 tests). e2e baseline pending: CPU was above 90% (another project's headless Chrome). |
| M1 Engine v2 | not started | |
| M2 Simulator | not started | |
| M3 Relay | not started | |
| M4 Design direction | not started | |
| M5 Scene | not started | |
| M6 Host app | not started | |
| M7 Phone app | not started | |
| M8 End to end | not started | |
| M9 Tuning | not started | |
| M10 Ready to ship | not started | |
| M11 Close out | not started | |

## Log
- 2026-11-10: branch `v2` created; first commit holds the brief and the
  handover note. Read HANDOVER, DESIGN and the v1 core. PLAN and DECISIONS written.

## Broken or open
- Nothing broken.
