# Fixture split | tuning and held-out sets

Written 2026-11-10, before any v2 work on detection (BRIEF hard limit 8,
DECISIONS D4). Code: `tests/fixtures/split.ts`. Test that prints the numbers:
`tests/detection-split.test.ts`.

## The recordings

Three labelled sessions on a Samsung A32 (Android, Chrome), 2026-11-09:

| Session | File | Content |
|---|---|---|
| 0 | `tests/fixtures/phone-a32-labelled-2026-11-09.csv` | eight labelled sets, both sides |
| 1 | `tests/fixtures/phone-a32-forehand-2026-11-09.csv` | forehands, swung the way he plays |
| 2 | `tests/fixtures/phone-a32-backhand-2026-11-09.csv` | backhands, swung the way he plays |

The sessions are replayed in order through one detector, as a phone keeps what
it learned between games. A labelled swing is a detected swing whose turn
direction matches its label (forehand +1, backhand -1). There are 120.

`tests/fixtures/phone-2026-11-09.csv` (the first, unlabelled recording) is not
part of the split: it has no labels and is only used to check swing counts.

## The rule

Within each session and label, in time order:

1. Swings 1 to 3 are **teach**: the three teaching swings the spin
   calibration asks for. They fit the calibration and are never scored.
2. Of the rest, the first half (rounded up) is **tuning**.
3. The second half is **held-out**.

Later swings are held out on purpose. A player's "flat" drifts within a
session, so anything fitted on earlier swings has to prove itself on later
ones. An alternating split would hide that drift.

A swing's identity is its session and peak time (`tp`), as found by the v1
detector. If detection is ever changed, freeze the three lists by `tp` first,
so the sets do not move with the detector under test.

## Counts

| Session and label | Teach | Tuning | Held-out |
|---|---|---|---|
| 0 fh-flat | 3 | 2 | 2 |
| 0 fh-top | 3 | 2 | 1 |
| 0 fh-slice | 3 | 2 | 2 |
| 0 bh-flat | 3 | 1 | 1 |
| 0 bh-top | 3 | 3 | 3 |
| 0 bh-slice | 3 | 3 | 2 |
| 1 fh-flat | 3 | 4 | 3 |
| 1 fh-top | 3 | 5 | 5 |
| 1 fh-slice | 3 | 5 | 5 |
| 2 bh-flat | 3 | 5 | 4 |
| 2 bh-top | 3 | 5 | 4 |
| 2 bh-slice | 3 | 8 | 7 |
| **Total (120)** | **36** | **45** | **39** |

## Reference results (v1 detection, unchanged in v2)

A swing is correct when its spin reads as the labelled word: topspin above
+0.2, slice below -0.2, flat between.

| Rule | Every labelled swing | Tuning | Held-out |
|---|---|---|---|
| Fixed rule | 88/120 (73%) | 33/45 (73%) | 27/39 (69%) |
| Calibrated on the session's own teach swings | not scored on teach | 35/45 (78%) | 33/39 (85%) |

Tuning and held-out together: calibrated 68/84 (81%) against the fixed rule's
60/84 (71%). These are the 73% and 81% of the brief, now with their held-out
parts: **69% (fixed rule) and 85% (calibrated)**.

## What a detection change must do

Fit on teach and tuning only. Report all four numbers. It stays only if it
beats 69% for the fixed rule and 85% for the calibration on the held-out set,
without falling below 73% and 78% on the tuning set. Otherwise it is reverted.
The held-out set is small (39 swings): one swing is 2.6 points, so a change
that wins by one or two swings is noise, not a result.
