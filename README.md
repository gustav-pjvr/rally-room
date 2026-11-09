# Rally Room

Living-room tennis where your phone is the racket. The court runs in a
browser on a laptop or TV; each player scans a QR code, holds their phone like
a racket handle and swings. Timing is aim: swing early and the ball goes
cross-court, late and it goes down the line. No app to install.

## Play

Requirements: Node.js 20 or newer, and the laptop and phones on the same Wi-Fi.

```bash
npm install
npm run dev
```

1. On the laptop open `https://127.0.0.1:5280` and accept the local certificate
   warning (the dev server uses a self-signed certificate, because phones only
   share motion sensors with secure pages).
2. Press **Play**. Scan the QR code with each phone (up to two players, more can
   watch), accept the warning, join, and tap **Allow motion**.
3. Take a few practice swings, then **Start match**.

No phone? Space swings for player 1 and Enter for player 2.

If phones cannot load the page, allow Node.js through the Windows firewall on
private networks.

## How it works

- `src/phone`: the controller page. Reads the gyroscope and accelerometer,
  detects swings (power, spin, timing) and learns each phone's sensor
  conventions automatically.
- `server/relay.ts`: a small WebSocket relay for rooms of one host and up to
  four phones, attached to the dev server.
- `src/host`: the game. Rules engine (`src/host/game/match.ts`), Three.js
  renderer, Web Audio sound, lobby and phone wiring.
- `lab/`: a sensor lab for recording and charting raw swings.
- `docs/DESIGN.md`: the full design, including what was measured on real
  phones and why.

## Tests

```bash
npm test          # unit tests, including replays of real phone recordings
npm run build     # type-check and production build
```

## Status

Co-op against the computer is playable (singles and doubles). Player against
player with split screen is planned.
