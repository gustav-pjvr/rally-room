# Rally Room | design

Working title. A living-room tennis game: the laptop or TV shows the court, and
each player's phone is their racket. Players join by scanning a QR code, hold
the phone like a racket handle, and swing.

Status: design v1, 2026-11-09. Phase 1 (sensor lab) is the first build.

---

## 1. Brief (self-authored under explicit creative delegation)

Gustav chose the phone-control route and said "complete design and then begin
where you see fit". Everything below is an authored decision unless quoted.

- **For whom:** friends and family in one room (a screen, phones in hand).
  Nobody installs anything.
- **What it must prove:** a swing of your own phone hits the ball where you
  meant it to go. Timing, power and spin all come from the swing.
- **Feeling curve:** curious (scan the code) > delighted (the racket on your
  phone reacts to your first practice swing) > focused (first rally) > loud
  (a long rally, the crowd sound rises) > proud (the swing replay of the winner).
- **The peak:** "I swung late on purpose and it went down the line." The
  moment a player realises timing is aim.
- **Tell-someone sentence:** "It's the game where your phone turns into the
  racket and you can feel the sweet spot."
- **Signature move (bespoke, from this subject):** the phone screen *is* the
  racket face. It shows strings; on contact a ripple starts where the ball met
  the strings (the sweet spot for a clean hit, toward the tip, the throat or an
  edge for a mistimed one; a frame hit flashes and shakes the rim instead) and
  Android phones buzz. Your racket tells you how you hit it, in your hand.
- **Second unique moment:** after a winner, the host screen shows a two-second
  replay with the swing path drawn from the phone's own sensor data.
- **Originality:** no Miis, no white-and-blue console look, no copied courts or
  sounds. First-guess ideas rejected: a generic green grass court with cartoon
  avatars (every casual tennis game), and a neon "cyber" court (stock look).
  Chosen world: **a sun-bleached hard court at dusk, floodlights warming up,
  long shadows, a 1970s tennis-poster palette** (clay orange, cream, deep teal,
  ink). Players are simple pill-shaped figures in team colours with oversized
  rackets; readable from across a room, not a person's likeness.
- **Assets:** none supplied. Everything is generated in code (geometry, toon
  shading, Web Audio synthesis). No paid generation is planned.
- **Verification:** every screen is shot in a real browser at desktop and phone
  width; the phone page is also tested on Gustav's real phones (headless
  Chrome has no gyroscope). `/web-design-guidelines` and `site-qa` run before
  any phase that ships UI is called done.

## 2. Platform and stack

| Piece | Choice | Why |
|---|---|---|
| Game screen | Browser, Three.js, TypeScript | Runs on any laptop, casts to a TV |
| Phone | Plain web page | No install; DeviceMotion gives gyro and accelerometer |
| Build | Vite, multi-page (`/`, `/play/`, `/lab/`) | One dev server for all three pages |
| Relay | Node `ws` attached to the Vite server at `/ws` | Same origin, same HTTPS cert, LAN latency |
| HTTPS | `@vitejs/plugin-basic-ssl` (self-signed) | Phones only expose motion sensors on secure pages |
| Tests | Vitest | Swing detector, shot solver, scoring and relay are pure modules |
| Later | Cloudflare Worker + Durable Object relay | Play without being on the same Wi-Fi |

**Why LAN first:** phone and laptop on the same Wi-Fi gives 5 to 20 ms one way,
with no account or deploy. The relay is a small pure module so it can move to a
Durable Object in Phase 4 without touching the game.

**Known risks, to be answered by Phase 1 on real phones:**
1. Phones show a certificate warning for the self-signed cert. The player taps
   through once. We must confirm motion events still fire after that on both
   iPhone Safari and Android Chrome. Fallback: a Cloudflare tunnel or a
   workers.dev deploy (both need Gustav's OK, they are outward actions).
2. iOS asks for motion permission. `DeviceMotionEvent.requestPermission()` must
   be called from a tap, so the phone page has an "Allow motion" button.
3. Windows Firewall may block the dev server from the LAN the first time. Allow
   Node on private networks.
4. The QR code needs the laptop's LAN address, which the browser cannot know.
   The dev server exposes `GET /api/lan`, preferring `192.168.*`, `10.*` and
   `172.16-31.*` over VPN adapters (this laptop also has a Radmin VPN address).

## 3. Rooms and protocol

A host creates a room; up to 4 phones join it. Every message is one JSON object
with a `t` (type) field.

**Room code:** 4 letters from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O).
**Phone URL:** `https://<lan-ip>:<port>/play/?r=<CODE>`.

| Direction | Message | Meaning |
|---|---|---|
| host > relay | `{t:"host"}` | Create a room |
| relay > host | `{t:"room", code}` | Room created |
| phone > relay | `{t:"join", room, name, pid}` | Join; `pid` is the phone's id, a random id kept in `localStorage` under `rally-room-pid-<CODE>`, so a reload, a re-scan of the QR or a new tab is the same player |
| relay > phone | `{t:"joined", slot}` or `{t:"error", reason}` | Slot 1 to 4, or `no-room` / `full`; `rejoined` to the old socket when the same pid joins again |
| relay > host | `{t:"player", slot, name, state:"in"\|"out", id}` | Joins, leaves, reconnects; `id` is the pid (host only, LAN game) |
| phone > host | `swing`, `raw`, `status`, `pong`, `player-info`, `profile`; relay adds `slot` | Forwarded as is; any other type from a phone is dropped |
| host > phone | any message with `to: slot` | Forwarded to that slot only |
| relay > phone | `{t:"host-gone"}` | Host closed; phone shows "waiting for the game" |

A slot is held for 60 s after a phone drops, so a locked screen or a Wi-Fi blip
does not lose your place. After the hold the slot is free for someone else, but
a phone whose pid is still recorded on it gets it back while nobody took it; if
someone did, the returning phone gets a free slot. The room closes when the
host disconnects.

**Identity by pid.** The host binds a match's human players to phone ids, not
slots. A `player in` whose `id` belongs to a match player re-maps that player
to the new slot, whatever its number. A new id never takes over a match
player, even on an old slot number: it watches.

**Liveness.** The relay pings every socket every 10 s (ws ping) and terminates
one that did not answer since the last ping; its close frees the slot as usual.
The host also counts a playing phone with no `pong` for 6 s as missing (pings
go every 2 s), which takes the same pause path as a disconnect. A phone that
comes back (`player in`) stays missing until it sends `status` with motion
`ok` (it does so on rejoin when motion is known, and on its first sensor data),
because before that it cannot swing; play resumes 1.5 s later.

**Clock sync (host time is the truth).** Every 2 s the host sends
`{t:"ping", h:hostNow, to:slot}`; the phone answers `{t:"pong", h, p:phoneNow}`.
The host computes `rtt = now - h` and `offset = p - (h + rtt/2)` and keeps the
offset from the lowest-rtt sample of the last 10. A swing at phone time `tp`
happened at host time `tp - offset`.

**Phone > host game messages:**
- `{t:"swing", tp, power, omega, spin, dir, dur}`: one per detected swing (§4).
- `{t:"raw", s:[[t, ax,ay,az, gx,gy,gz, rx,ry,rz], ...]}`: lab only, batched
  every 4 samples. `a*` is acceleration including gravity (m/s²), `g*` is the
  low-pass gravity estimate, `r*` is the rotation rate about the phone's x, y
  and z axes (deg/s). **Measured, not taken from the spec:** on Gustav's phone
  (recording of 2026-11-09) `rotationRate.alpha, beta, gamma` are the rates
  about x, y, z, in that order. Integrating them in that order tracks gravity
  through a swing to within 16 degrees on average; the spec's reading
  (beta, gamma, alpha) was off by 65. A second phone brand must be checked the
  same way before it is trusted; if brands disagree, the phone detects its own
  mapping from its first few rest-swing-rest moves.
- `{t:"status", motion:"ok"|"denied"|"none", wake:boolean}`.

**Host > phone:** `{t:"hit", to, quality, u, v}` drives the string ripple
(`u, v` in -1..1 is where the ball met the strings); `{t:"mode", to, mode}`
switches the phone screen (`lobby`, `serve`, `rally`, `lab`).

**Phase 3 messages (co-op vs CPU, no versus yet).** These supersede the line
above where they differ.

| Direction | Message | Meaning |
|---|---|---|
| host > phone | `{t:"mode", to, mode}` with mode `lab`, `lobby` or `play` | Lab page sends `lab` (raw stream on). Game page sends `lobby` on join and between matches, `play` when a match starts |
| host > phone | `{t:"you", to, player, color, team}` | On join and when settings change: player number (1 or 2) in the next match, team colour, team name for the score line |
| host > phone | `{t:"game", to, state, score, message}` | On change only. `state`: `wait` (other side serving or between points), `serve` (your serve: swing to toss), `toss` (swing to hit), `rally` (ball in play), `paused`, `over`. `score`: short text like "30-15, games 1-0". `message`: the big host message or null |
| host > phone | `{t:"hit", to, quality, u, v, frame}` | Your swing touched the ball, and where (section 5, the contact point). `u` = `a` along the racket (-1 throat .. +1 tip); `v` = `b` across it (-1 bottom edge .. +1 top edge); both up to 1.25 on the frame. `frame`: true for a frame hit. `quality` 0..1 = 1 - d, the distance from the sweet spot (0.05 on the frame) |
| host > phone | `{t:"miss", to}` | You were meant to hit and did not. Sent once per ball, when the point is decided: a whiff alone sends nothing, because the ball is still live and a later swing may hit it (a whiff then a hit sends only the hit; a whiff then nothing sends one miss at the point) |
| phone > host | `{t:"player-info", hand, colour}` | After joining; `name` came with `join` |

Host side: the first phone to join is player 1, the second player 2 (doubles
with two humans). Swing host time is `clock.toHost(tp)`, then converted to
match time by the one `toMatchTime` function, which subtracts only the time
paused before that moment (`src/host/timeline.ts`: user pause, missing-phone
pause, hidden tab and absorbed long frames are all recorded as intervals); a
swing whose host time falls inside a pause is dropped. If a playing phone is
missing (disconnected, silent, or back without motion), the match pauses with
"Waiting for <name>'s phone" and resumes 1.5 s after it is back with motion
`ok`; an auto-resume never fires while the host tab is hidden. After 60 s the
pause card also offers "Continue with the keyboard" (that player is then
played with the keyboard: Space for player 1, Enter for player 2) and "Quit to
title"; if the phone comes back later, it takes its player over again. The
keyboard stays as a fallback when no phone has joined.

Phone side: after Allow motion, the lobby shows the swing test. On `play` the
screen becomes the racket face (signature move, section 1): strings in the
team colour, and on every `hit` a ripple from where the ball met the strings:
`a` runs up the screen (tip at the top, throat at the bottom), `b` across it
(the top edge on the right for a right-handed grip, on the left for a
left-handed one, because the screen's right edge faces up in a right-handed
forehand). Bigger and brighter for higher quality; near the frame it reads as
a mishit. With `frame: true` there is no string ripple: the rim flashes pale
and shakes along the line of the blow, with a ball mark and sparks where it
struck (reduced motion: the flash and the mark only, no shake). A short frame
shake on `miss`, `navigator.vibrate` on Android (strength by quality, a rattle
for a frame hit), and a small line with the score and the prompt from
`game.state` ("Your serve: swing to toss").

## 4. Swing detection (runs on the phone)

**Grip:** hold the phone like a racket handle, screen facing sideways, the top
of the phone pointing out where the racket head would be. The phone shows this
as a picture on first join.

Per `devicemotion` sample (about 60 Hz, measured: median 16.7 ms):
- `omega = |rotationRate|` in deg/s.
- `up` = unit vector to the sky in phone coordinates. While the phone moves it
  is turned by the gyro (`du/dt = -w x u`); at rest (`omega < 150` and the
  accelerometer within 2 m/s² of 1 g) it is pulled toward the accelerometer
  with weight 0.1. Freezing it at the start of the swing was wrong: the
  backswing turns the phone a long way before contact.

State machine (pure module `src/shared/swing.ts`, no DOM):

```
idle    -> rising   when omega > START (250 deg/s)
rising  : track the peak omega, and the rotation vector and up at the peak
rising  -> end      when omega < 0.7 * peak, or 600 ms passed (safety net)
end     : peak > MIN_PEAK (450 deg/s): emit, then cooldown 350 ms
          otherwise: back to idle with no cooldown
```

The "no cooldown" rule matters: the first detector put every gentle wind-up
into a cooldown and so missed the real swing right behind it.

Emitted features:
- `tp`: phone timestamp of the peak (contact moment).
- `power`: `clamp((peak - 450) / (1400 - 450), 0, 1)`.
- `spin`: vertical direction of the racket head at the peak. With `w` the
  rotation vector and `y` the phone's long axis `(0,1,0)`, the head velocity is
  `w x y`; `spin = ((w x y) . up) / |w|` in -1..1. Positive is low to high
  (topspin), negative is high to low (slice).
- `dir`: sign of `w . up` (which way round the swing went; used to sanity-check
  forehand versus backhand and to learn handedness).
- `dur`: ms from START to the peak.

All thresholds live in one exported `TUNING` object, set from the first real
recording (kept as `tests/fixtures/phone-2026-11-09.csv` with a replay test):
real swings peaked at 700 to 1342 deg/s, gentle backswings at 400 to 620.
The gyro never saturated; the accelerometer clips at 8 g (78.4 m/s²) during
swings, which is harmless because acceleration is only trusted at rest.

**Backswings:** a hard backswing can still pass MIN_PEAK and fire about 0.5 s
before the real swing. The phone reports every swing; the game (section 5)
ignores swings outside the acceptance window and takes the strongest swing
that touches the ball inside it, so an early backswing never costs the point.

**Verified with labels** (Samsung A32, Chrome, 2026-11-09, 73 swings in eight
labelled sets, kept as `tests/fixtures/phone-a32-labelled-2026-11-09.csv`):
`dir` separates forehand (+1) from backhand (-1); `spin` puts topspin, flat and
slice in the right order.

**Spin rule, revised after play-testing** (two more labelled sessions swung the
way Gustav plays, `phone-a32-forehand-2026-11-09.csv` and `phone-a32-backhand-2026-11-09.csv`; replayed
in order through one detector in `tests/spin.test.ts`):
- In play, slices read as flat and nearly everything else as topspin. The
  cause was the running per-player offset (median of the last 25 spins): after
  ten flat forehands it centred the topspin forehands away to flat. It labelled
  only 64% of the match-style swings correctly. It is removed.
- Now: spin = (upward racket-head path at the peak, using the learned racket
  axis, minus a fixed neutral point of +0.05) scaled so measured flat swings
  (-0.12 to +0.22) fall in the +-0.2 "flat" band. 73% correct over 120
  labelled swings, with slice < flat < topspin on average for both sides in
  every session, and no dependence on swing order.
- Ceiling without labels: a player's "flat" moves between sessions (forehand
  flat averaged +0.25 in one session and -0.44 in another), so no fixed rule
  can do much better. Measured options: averaging the path over the swing
  instead of the peak did not generalise across sessions; a separate backhand
  neutral point did not help overall. Adding the racket-face angle at contact
  plus a player's own labelled examples reached about 90% (left one out, per
  session): that needs a short spin calibration with labels, built as below.

**Spin calibration (optional, per player and phone).** Code:
`src/shared/calibration.ts` (pure), tests `tests/calibration.test.ts`.
- Two features per swing at the peak: `path` (the upward head path above,
  before the neutral point) and `face = up.z * dir` (the screen normal's upward
  part). Phone only: `wireSwing` strips them before the swing is sent. Both
  are NaN without a gyroscope, so such swings are never used for teaching.
- Teaching, in the phone lobby only, and only on a phone whose gyroscope is
  confirmed (the card is hidden in accelerometer mode and until the mode is
  known): six steps (forehand slice, flat, topspin, then backhand), three
  swings each. A swing the other way round is ignored. The player's hand
  decides which way the strokes turn: a left-hander's forehand steps expect
  the turn direction `dir` -1 and the backhand steps +1. Features and storage
  keep the physical side (`dir` +1 is `fh`, -1 is `bh`), so the swing at play
  time reads the same side its calibration was stored under. "Redo" goes back
  one step at most: after a go-back it reads "Redo this step" until that step
  is finished, so redo and swing cycles never reach an earlier step.
- Fit: per side, the class means of the three kinds, standardised by the
  pooled within-class standard deviation; a side needs two swings of every
  kind and distinct means, else it stays on the fixed rule.
- Spin: the arm is the nearer of the topspin and slice means by distance in
  the standardised space (so the word is the nearest class mean, also when the
  arms are unequal or not opposite, and each class mean reads its own sign).
  Along that arm, with 0 at the flat mean and 1 at the class mean: halfway
  +-0.2 (the word boundary), class mean +-0.6, then linear, clamped to +-1.
- Saved under `localStorage['rally-room-calibration-v1']`, a map from the
  trimmed lower-case player name to the calibration; another name on the same
  phone starts on the fixed rule. A rejoin under the same name keeps the
  calibration in memory (it may not have been saved); it is reloaded only when
  the name key changes.
- Measured (calibrate on the first three swings of each kind, score the rest
  of the same session): 81% against 71% for the fixed rule on the same 84
  swings (session 0: 83 vs 71, forehand session: 96 vs 78, backhand session:
  67 vs 67, where the player's flat drifted during the session). Calibrated
  on one session and scored on another: 76% against 71%.

## 4a. Automatic phone setup (no setup screen)

Every family member has a different phone, so the phone works out its own
conventions while the player swings and saves them (`localStorage`), so the
next game starts ready. Code: `src/shared/profile.ts`; tests replay the A32
recording as if made on differently behaved phones (`tests/profile.test.ts`).

| Differs between phones | Handled by | Proven on |
|---|---|---|
| Rotation axis order and signs | `AxisCalibrator`: after each still, move, still, it integrates the gyro under all 48 orders and signs and keeps the one that carries gravity from the first pose to the second. Until it is sure (6 moves, best mean error under 40 degrees, 12 better than the runner-up) the platform default is used | Scrambled and flipped axes: exact inverse found after about 60 s of play |
| deg/s or rad/s | `UnitsGuess`: a pull over 25 m/s² only happens in a real swing (several hundred deg/s); if the reading is then under 40, it is rad/s | Found after about 7 s |
| Accelerometer sign, how the phone sits in the hand | `RacketAxisLearner`: the swing pulls the phone away from the wrist, so the accelerometer minus gravity points back to the wrist; the racket is the other way. Averaged over swings, it absorbs grip and a flipped accelerometer | Flipped accelerometer: identical spin results |
| The player's own swing style | Not corrected automatically. A running median offset was tried and removed (section 4: it erased a player's habitual spin). A fixed neutral point (+0.05) is used, unless the player teaches the phone their spin in the lobby (section 4, "Spin calibration") | 73% correct spin over 120 labelled swings; 81% with the calibration on the swings after it |
| Gyro that tops out early | `SaturationWatch`: three swings at the same top; thresholds then scale to that top | 500 deg/s gyro: swings found, spin degraded to 57% |
| No gyroscope | Accelerometer-only mode after 60 samples with no rotation rate: turn rate estimated from the pull (a = w² r, r = 0.35 m), spin reads flat | Swings found, about 10% extra |
| Sample rate | Everything uses timestamps | |

**Platform defaults:** Android maps every phone's sensors to one device
coordinate system before the browser sees them, and every iPhone browser is
WebKit. So conventions differ by platform, not by model: Android Chrome is
measured (identity, deg/s). **iPhone Safari is not yet measured**; one labelled
lab recording from an iPhone sets its default. The calibrator covers the gap.

**Rejected after testing on the real recordings** (do not retry):
- Comparing any two "nearly still" moments, without a gyro stillness check:
  even the right mapping missed by about 30 degrees; it did not lock reliably.
- Only "slow" stretches where the accelerometer stays near 1 g: also 30 to 50 degrees.
- Assuming the swing pull is at right angles to the rotation axis: wrong on
  real data, because the elbow and shoulder move and the accelerometer clips at 8 g.

The one iPhone requirement that cannot be automated: iOS shows a motion
permission prompt that needs a tap, so the "Allow motion" button stays.

## 5. The game (host)

**Court:** real dimensions in metres. Net on `z = 0`, near baseline `z = +11.885`,
far baseline `z = -11.885`, singles half width 4.115, doubles 5.485. `y` is up.
Net modelled as a 0.95 m wall. The ball renders larger than life (0.06 m radius)
and always has a ground shadow and a short trail, so depth reads on a TV.

**Ball physics:** constant acceleration `a = (0, -(9.81 + 6 * spin), 0)`, no
drag. Because it is analytic, the shot solver and the simulation agree exactly.
Bounce: `vy = -0.75 vy`, horizontal `x 0.85`; topspin keeps more pace
(`x 0.92`), slice bounces lower (`vy x 0.6`).

**Shot solver:** given start `p0`, a landing target `L` and a flight time `T`,
`v0 = (L - p0 - a T² / 2) / T`. If the ball would not clear the net plus 0.15 m,
raise `T` in 5% steps. Pure and unit tested.

**Movement:** players run to the ball on their own, at 5.5 m/s (CPU speed
depends on level). In doubles each player covers their half of the court. The
game picks forehand or backhand from which side of the body the ball passes.
Humans only swing.

**Hitting (timing is aim, and where the ball meets the strings):**
- `T*` = the moment the ball passes the player's contact point.
- `Ts` = swing host time (`tp - offset`). `dt = Ts - T*`.
- Timing unit `W`: 180 ms (easy), 130 ms (normal), 90 ms (pro); `u = dt / W`.
  Near `|u| = 1` the ball meets the edge of the string bed, where the old
  all-or-nothing window ended.
- **Acceptance window:** swings with `|u| <= 1.6` (Normal: 208 ms either side)
  meet the ball somewhere: on the strings, on the frame, or not at all (a clean
  miss, a `whiff`). Swings outside it are ignored (a backswing is not a whiff).
  Of the swings that touch the ball, the strongest counts. A whiff does not end
  the chance: a later swing in the window may still touch the ball, and a
  stronger swing that would whiff never undoes a hit. No touching swing in the
  window is a miss. The window always opens after the first bounce: a human
  can never strike a ball before it lands, so a ball going out stays out. It
  also closes at the second bounce: a ball that has bounced twice is dead and
  no swing can touch it (a swing dated at or after the second bounce is
  ignored, and the miss is declared at the latest 300 ms after it). Planning
  keeps T* at least ACCEPT * W before the second bounce when that still gives
  a reachable contact at a comfortable height, so the window normally closes
  by itself first. If it does not, the full range is used and the window is
  cut short at the second bounce: the rule never makes a ball awkward or
  unreachable (tested across all three windows and many positions).
- **Phone feedback for a whiff:** the host sends `miss` at most once per ball
  and only once the outcome is known (`phones.ts` `eventMessages`). A whiff is
  remembered, not sent. The point then decides: `missed` and `ace` send the
  receiver's miss, `winner` (a ball too far to reach, swung at anyway) sends
  one to the whiffer, and a later hit forgets the whiff.
- **One exception to "strongest counts":** once a bounce, net or fault has been
  shown, a later-arriving swing never undoes it. A stronger serve swing that
  reaches the host after the weaker serve has already bounced is ignored.
  Announced outcomes are final; it takes over 250 ms of lag to happen.
- Aim from timing: early pulls the ball cross-court, late pushes it down the
  line: aim `x = hitSide * clamp(u, -1, 1) * 0.75 * halfWidth`.
- Depth and pace from `power * transfer` (transfer: below): flight time from
  1.6 s (soft) to 0.75 s (full). Target depth from 5 m to 10.5 m past the net.
- `spin` from the swing sets topspin or slice in the physics.

**The contact point** (`src/host/game/contact.ts`, all numbers below are the
tuned values). Face coordinates: `a` along the racket, -1 at the throat (the
handle end of the string bed) to +1 at the tip; `b` across it, -1 bottom edge
to +1 top edge (the edge facing up at contact). The string bed is
`a^2 + b^2 <= 1`, the frame `1 < r <= 1.25`; beyond 1.25 the racket misses.
The sweet spot is `(a, b) = (-0.15, 0)`.

Where the ball lands on the face:
- `a = -0.15 - u * 1.0` early (`u < 0`, reaching: toward the tip) and
  `a = -0.15 - u * 0.75` late (cramped: toward the throat), plus placement
  noise. The early slope is steeper because the sweet spot sits toward the
  throat: with one slope of 0.75 the early bed edge fell at `u = -1.53`, far
  outside the old window, and a casual player's very early swings were safer
  than centred ones. Now the bed edges fall at `u = -1.15` (tip) and
  `u = +1.13` (throat); the frame runs to about `u = -1.4` and `u = +1.47`
  (with no spin); beyond is a whiff, up to the 1.6 acceptance edge.
- `b = -0.7 * u * spin` plus a height push plus noise. A topspin (low to high)
  swing met early has not risen yet, so the ball sits high on the face
  (`b > 0`); late, low (`b < 0`); slice the other way. Height push: below
  0.5 m, `-(0.5 - y) * 0.9`; above 1.4 m, `+(y - 1.4) * 0.5`.
- Placement noise (sd along the racket, face units):
  `0.05 + 0.12 * rushed + 0.14 * awkward`; across the face 0.6 of that.
  `rushed = clamp(1 - slack / 0.4 s)`, where slack is the time to spare after
  running to the contact point at run speed (an unreachable ball is 1).
  `awkward` is 1 for a ball jammed into the body (under 0.3 m sideways, full
  at 0) or at full stretch (over 0.95 m, full at 1.8 m), 0 in between.
  All seeded, so a match replays exactly.

What the contact does. `d` is the distance from the sweet spot as a fraction
of the way to the rim along the same line (0 at the sweet spot, 1 on the rim
in every direction):
- **Quality** (ripple, sound, haptics) `= clamp(1 - d)`; a frame hit 0.05.
- Power transfer `1 - 0.45 d^2`; random sideways error sd `1.2 d` m and length
  error sd `0.6 d` m.
- **Tip** (`a > 0.5`): twists the ball wide, up to 1.5 m further toward the
  sideline the shot was heading for at `a = 1` (a shot aimed down the middle
  goes toward the outside of the side of the body the ball was on). The
  literal "toward the outside of the hitting side" was tried first: it pulled
  early cross-court balls back into the court half the time, so tip hits went
  in 94% of the time, safer than centred ones.
- **Throat** (`a < -0.6`): dead and short: at `a = -1`, 45% less power, 3.5 m
  shorter and launched up to 3 degrees lower (net risk).
- **Top edge** (`b > 0.4`): launched up to 6 degrees lower at `b = 1` (net
  risk). **Bottom edge** (`b < -0.4`): up to 6 degrees higher (long or a
  pop-up).
- The old length risk stays: a flat swing (`|spin| < 0.2`) over 0.9 power adds
  length error up to sd 1.8 m at full power, even when centred.
- **Frame** (`1 < r <= 1.25`): a shank. 40% go into the net slowly (0.9 to
  1.2 s), the rest are slow loopy balls (1.5 to 2.1 s) to a random spot up to
  3.5 m outside the sidelines and 2.5 to 15 m past the net. A shank that lands
  in is a valid ball (about 1 in 4 do).
- **Beyond 1.25:** a clean miss: `whiff`, the ball stays in play and the point
  is lost at the miss time unless a later swing touches it.

The hit event carries `contact: { a, b, frame }`; the phone draws it (section
3). The old separate risk rule (`|u| > 0.8` width error) is gone: risk now
comes from where on the face the ball was struck.

**Playability** (seeded simulation, 30 one-set matches per row, scripted human
swinging at `T* + jitter` with power 0.4 to 0.9 and spin -0.1 to 0.6; the old
model's results in brackets). "Uniform ±X" is the spread `chain.mjs` uses;
"Gaussian sd X" is a harsher reading of the same words.

| Human | Window | CPU | Sets won | Shots per point |
|---|---|---|---|---|
| Casual, uniform ±100 ms | Normal | Rookie | 30/30 (30/30) | 14.4 (14.4) |
| Casual, Gaussian sd 75 ms | Normal | Rookie | 30/30 | 9.6 |
| Casual, Gaussian sd 100 ms | Normal | Rookie | 2/30 (3/30) | 6.9 (5.9) |
| Casual, Gaussian sd 100 ms | Easy | Rookie | 30/30 (30/30) | 7.2 (9.3) |
| Casual, uniform ±100 ms | Normal | Club | 30/30 (30/30) | 21.5 (21.7) |
| Good, uniform ±50 ms | Normal | Pro | 23/30 (29/30) | 11.6 (15.0) |
| Good, Gaussian sd 50 ms | Normal | Pro | 12/30 (28/30) | 10.7 (13.7) |
| Good, uniform ±50 ms | Pro | Pro | 30/30 (30/30) | 14.9 (14.5) |

With uniform ±100 ms every swing lands in the bed (centre 47%, mid 36%, tip 7%,
throat 10%) and almost every ball goes in (tip hits 97%); the ripple moves
around the face and off-centre balls are slower. With Gaussian sd 100 ms, 8% of the human's hits are frame hits
(24% of those land in), tip hits land in 79% of the time and throat hits 91%;
in the old model those swings were all clean misses. A good player is no
longer near-certain to beat Pro because off-centre balls arrive slower, so the
Pro CPU, which errs more under pace, makes fewer errors.

**Lag compensation:** the swing message arrives after the contact moment. The
host knows the ball's exact path (it is analytic). When a valid swing arrives,
the new shot starts from the ball's position at `Ts` and is fast-forwarded to
now. The ball can jump 1 to 6 m on screen (incoming plus outgoing speed times
the lag), so the renderer draws the difference away over 120 ms. A miss is
only declared after `T* + 1.6 W + 300 ms` (the acceptance edge plus the 300 ms
of lag the contract allows).
The host pauses the match when its tab is hidden and treats any frame gap
over 250 ms as paused time, so nothing is played while nobody can see it.

**Serving:** the first swing tosses the ball (it rises to about 3 m and falls
in 1.1 s); the second swing hits it, between 250 and 1150 ms after the toss.
The serve uses the same contact model: `a` from the toss timing
(`u = (Ts - top of toss) / 550 ms`, same slopes), `b = -0.6 * drop`, where
drop is how far the ball has fallen below the top of the toss (capped at
1.1 m), plus 0.05 noise. So the top of the toss is the sweet spot, and a late
serve is struck low on the face toward the throat (short, dead, launched
high). A tip hit twists the serve toward the sideline of its box. Struck below
1.9 m it goes into the net whatever the contact. A human serve whiff leaves
the toss falling: another swing may still hit it, or it is caught and tossed
again without a fault. The serve goes to the correct service box, with timing
nudging it wide or to the T. Two faults lose the point. CPU players serve on
their own and never whiff a serve.

**CPU opponent:** reads the incoming ball, runs to it at its level's speed, and
picks a target with a level-based error. Levels: Rookie, Club, Pro. CPUs strike
through the same contact model, so they mishit too: their timing is measured
against the Normal unit (130 ms) whatever window the humans chose, and each
level adds its own face placement noise (sd 0.3 Rookie, 0.2 Club, 0.07 Pro) on
top of its timing noise (45, 25, 12 ms) and its chance of a botched shot
(12%, 7%, 5% before pressure from a fast ball). A CPU frame hit is a shank, a
CPU whiff loses the point, and lost power makes a CPU shot 5 m shorter and
0.9 s slower per unit lost. In the simulation a Rookie hits the frame on about
1.4% of its shots.

**Scoring:** standard tennis: 15, 30, 40, deuce, advantage; games; tiebreak at
6-6. Match lengths: 1 game, 3 games, 1 set. Server alternates each game and
sides each point.

**Camera:** behind and above the near baseline, gently following the ball's
`x`. Humans always play on the near side in v1 (singles: 1 human vs CPU;
doubles: 1 or 2 humans with CPU partners and CPU opponents). Versus on both
ends of the court is Phase 4.

**Sound:** Web Audio synthesis only (hit pop pitched by quality, bounce, net,
crowd swell that grows with rally length). Nothing autoplays before the first tap.

## 6. Screens

**Host**
1. Title: name, "Start" (one button).
2. Lobby: room code in big type, QR code, four player cards (name, colour, a
   live swing meter that kicks on every practice swing), mode picker
   (Singles, Doubles, Practice), level, match length, "Play".
3. Match: court, score bug top-left, pause on Escape. A missing playing phone
   pauses the match: the pause card reads "Waiting for <name>'s phone" and
   Resume is blocked; after 60 s it offers "Continue with the keyboard" (Space
   for player 1, Enter for player 2) and "Quit to title". The phone takes its
   player back when it returns.
4. Point replay: two seconds, swing path overlay, then back.
5. Match end: score line, best rally, fastest swing.

**Phone**
1. Join: name, left or right handed, colour; "Join".
2. Allow motion: one big button (required tap for iOS) and the grip picture.
3. Lobby: "Swing to test" with a power meter; your colour; status of the game.
   A "Teach your racket your spin" card (lobby mode only) runs the optional
   spin calibration step by step and shows "Spin: calibrated / automatic".
   "You are player N" while the phone plays in the next match; a phone that
   is told `player: null` loses the number (it watches).
4. In play: the racket face (strings, frame, team colour) filling the screen,
   ripple on contact, the score in small type at the top. A small pause button.
   Wake Lock keeps the screen on; if it is unsupported, the phone says to turn
   off auto-lock.

**Lab** (`/lab/`, developer only): the room code and QR, and for each phone a
live chart of `omega`, the three rotation axes and acceleration, every
detected swing marked with its power, spin and dir, the measured rtt and clock
offset, and a "download CSV" button for a recorded take.

## 7. Code layout

```
docs/DESIGN.md
index.html               host game page
play/index.html          phone controller page
lab/index.html           sensor lab page
src/shared/protocol.ts   message types, room-code alphabet
src/shared/swing.ts      swing detector (pure) + TUNING
src/shared/clock.ts      clock-sync estimator (pure)
src/phone/*.ts           permission, sensors, UI, wake lock, racket face
src/host/net.ts          host connection, players, clock sync
src/host/game/*.ts       physics, solver, scoring, AI, render, audio
src/lab/*.ts             lab charts
server/relay.ts          rooms and forwarding (pure logic + ws adapter)
vite.config.ts           https, multi-page, relay on /ws, /api/lan
tests/*.test.ts
```

## 8. Build phases

1. **Sensor lab.** Relay, rooms, QR join, phone permission and sensors, swing
   detector, clock sync, lab charts and CSV. *Done when:* tests pass, and on
   Gustav's real phones swings show up in the lab with sensible power and spin.
   Then tune `TUNING` from the recorded CSVs.
2. **Game with keyboard.** Court, physics, solver, scoring, CPU, camera, sound;
   Space swings (timing still decides aim). *Done when:* a full CPU match plays
   to the end on keyboard, with screenshots at every screen.
3. **Phones in the game.** Swing messages drive hits with lag compensation,
   serving by toss and swing, the racket-face ripple, lobby and match end.
4. **Polish and reach.** Point replay, doubles with humans, Versus, Practice
   targets, Cloudflare deploy for play without shared Wi-Fi.
