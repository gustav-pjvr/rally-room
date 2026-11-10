# Rally Room v2 | wire protocol

The relay between the host page (the court) and the phones (the rackets).
Constants, types and validators live in `src/shared/protocol.ts`; this file
describes them. The room rules are one pure core (`server/core.ts`) behind two
adapters: Node `ws` on the dev server (`server/relay.ts`) and a Cloudflare
Worker with one Durable Object per room (`worker/`). Both pass the same
conformance suite (`tests/relay/conformance.ts`).

## 1. Transport and URLs

One WebSocket per page. Every frame is one UTF-8 JSON object with a string
`t` (type). Binary frames are refused.

| Path | Who | Purpose |
|---|---|---|
| `/ws/host` | host | Create a room. Send `{t:"host"}` after open. |
| `/ws/room/<CODE>` | phone | Join room CODE with `{t:"join"}`. |
| `/ws/room/<CODE>` | host | Resume room CODE with `{t:"host", resume}`. |
| `/ws` | v1 clients | Node adapter only, until the clients move: host or join any room by message, no host hold. The Worker answers 404. |

`relayPath({create:true})` and `relayPath({room})` in `protocol.ts` build the
paths. CODE is 4 letters from `ABCDEFGHJKMNPQRSTUVWXYZ`, case-insensitive. If
CODE is malformed or names no live room, the relay sends
`{t:"error",reason:"no-room"}` and closes with 1008 as soon as the socket opens.

The Worker serves the built site (`assets` binding) on every other path, so a
deployment can serve pages and relay from one origin.

## 2. Messages

### Client to relay

| Message | From | Notes |
|---|---|---|
| `{t:"host"}` | host on `/ws/host` | Answered by `room`. |
| `{t:"host", resume:{code, key}}` | host on `/ws/room/<code>` (or `/ws`) | Answered by `room` with `resumed:true`, then one `player` per known slot. |
| `{t:"join", room, name, pid}` | phone | `room` must equal the path's CODE. `name`: 1 to 40 characters after trimming, no control, bidi or zero-width characters. `pid`: 1 to 128 printable ASCII characters, no spaces. |
| `{"t":"hb"}` | anyone | Keepalive, answered with the same frame. Send this exact text every 10 s (`CLIENT_HEARTBEAT_MS`, `HEARTBEAT_FRAME`): the Worker cannot send protocol pings. |

### Relay to client

| Message | To | Meaning |
|---|---|---|
| `{t:"room", code, key, resumed?}` | host | The room. `key` is 32 hex characters (128 random bits) and changes on every resume: keep the latest. |
| `{t:"joined", slot}` | phone | Slot 1 to 4. |
| `{t:"player", slot, name, state:"in"\|"out", id}` | host | A phone joined, rejoined or dropped. `id` is its pid. |
| `{t:"error", reason}` | anyone | Section 4. |
| `{t:"host-away"}` | phones | The host socket closed; the room is held (section 3). |
| `{t:"host-back"}` | phones | The host resumed. |
| `{t:"host-gone"}` | phones | The room closed; the socket is then closed with 4001. |
| `{t:"hb"}` | anyone | Answer to `hb`. |

### Phone to host (forwarded)

Only these types are forwarded; any other type from a phone is dropped
silently. The relay removes `slot`, `to` and `id` and writes the phone's real
`slot`. Extra fields are kept.

| Type | Shape checked by the relay | Cap (bytes, whole frame) |
|---|---|---|
| `swing` | finite numbers `tp, power, omega, spin, dir, dur` | 512 |
| `trace` | none beyond section 2.1 (the host must validate it) | 10 240 |
| `raw` | `s`: 1 to 8 samples of 10 finite numbers | 2 048 |
| `status` | `motion` in `ok, denied, none`; boolean `wake`; optional `handedness`, `colour` up to 32 characters | 256 |
| `pong` | finite numbers `h, p` | 256 |
| `player-info` | strings `hand`, `colour` up to 32 characters | 256 |
| `profile` | none beyond section 2.1 | 1 024 |

### Host to phone (forwarded)

Any type except the relay's own (`room, joined, error, player, host-gone,
host-away, host-back, hb`), with an integer `to` naming a slot of the host's
own room; anything else is dropped silently. Cap: 4 096 bytes. Forwarded
unchanged (v1 messages: `ping, mode, hit, you, game, miss`, DESIGN.md section 3).

### 2.1 Checks on every frame

A frame over 16 384 bytes closes the socket with 1009 (the Node adapter stops
reading at that size). Then, in order: rate limits (section 5), JSON parse, an
object with a string `t`, and a structural check: at most 6 levels deep, no
`__proto__`, `constructor` or `prototype` key, finite numbers only (`1e999`
is refused), keys up to 64 characters, strings up to 2 048 characters with no
control characters (a host may use tab and line breaks). `host`, `join` and
`hb` frames are capped at 512 bytes. A frame that fails gets
`invalid-message` (or `too-big`) and counts as a strike.

## 3. Rooms

- **Slots.** Up to 4 phones. A dropped phone's slot is held 60 s for its pid.
  A returning pid gets its old slot back even after the hold while nobody took
  it, otherwise a free slot. The same pid on a new socket takes over: the old
  socket gets `rejoined` and loses its place.
- **Host hold.** When the host socket of a `/ws/host` room closes, the room is
  kept for 30 s (`HOST_HOLD_MS`); phones get `host-away`, may keep joining,
  and their messages are dropped. A host that resumes with the right key gets
  `room` (new key), a `player` message per slot (`in` or `out`), and phones get
  `host-back`. The right key also takes over from a host socket that is still
  open (the old one gets `replaced` and is closed with 4002). After the hold
  the room closes: phones get `host-gone`, then the code is free. `/ws` rooms
  close at once when the host leaves (v1).
- **Second handshake.** A second `host` or `join` on a socket that already has
  a role gets `already-connected`. `join` on `/ws/host` and plain `host` on
  `/ws/room/<code>` get `wrong-endpoint`.
- **Isolation.** A phone reaches only its own room's host; a host reaches only
  its own room's slots. On the Worker each room is its own Durable Object.

## 4. Errors and close codes

| Reason | When | Counts as a failed attempt |
|---|---|---|
| `invalid-message` | Section 2.1, or a malformed `resume` | no (strike); a bad `resume` yes |
| `invalid-join` | Bad `room`, `name` or `pid` type or value | yes |
| `no-room` | No such live room, or `room` differs from the path | yes |
| `full` | Four slots taken or held | yes |
| `bad-key` | Resume with the wrong key | yes |
| `wrong-endpoint` | See section 3 | yes |
| `too-big` | Frame over its type's cap | no (strike) |
| `already-connected` | Second handshake | no |
| `busy` | Room or socket cap reached, or no free code | no |
| `rejoined` | Your pid joined on another socket | no |
| `replaced` | Another socket resumed your room with the key | no |
| `too-many-attempts` | Fifth failed attempt on a socket, or the address is blocked | sent before the close |

| Close code | Meaning |
|---|---|
| 1008 | Policy: refused at open, too many failed attempts, or too many strikes |
| 1009 | Frame over 16 384 bytes |
| 4000 | No handshake within 10 s, or nothing heard for 25 s |
| 4001 | Room closed (`host-gone`) |
| 4002 | Replaced by a resuming host |

## 5. Limits and why

| Limit | Value | Reason |
|---|---|---|
| Phone messages | burst 80, 40 per s | Lab play: raw 15/s, pong 0.5/s, swing + trace + profile per swing (about 4.5/s when swinging hard), about 21/s in all; a 3 s Wi-Fi stall delivers about 60 at once |
| Phone bytes | burst 128 KiB, 64 KiB per s | Raw about 13 KB/s plus an 8 KB trace per swing: about 25 KB/s; the stall backlog is about 75 KB |
| Host messages | burst 120, 60 per s | 4 phones: pings 2/s, game state to each phone on change, hit and miss per shot, 12 at once at match start |
| Host bytes | burst 128 KiB, 64 KiB per s | Host messages are small (about 150 bytes) |
| Strikes | close after 40, decay 2 per s | Each rate drop or bad frame is a strike: a flood at twice the rate is closed within about 2 s; normal play never strikes |
| Failed attempts per socket | 5 | A phone fails at most once or twice; a room code cannot be guessed over one connection |
| Failed attempts per address | 30, forgiven at 0.5 per s | Guessing over many connections. Node: per instance. Worker: per isolate (best effort) and per room object |
| Rooms | 256 per Node instance, 8 hosted per address; 1 per Durable Object | A LAN party needs one or two |
| Sockets | 1 024 per Node instance, 16 per room object | Host, 4 phones and reconnects |
| Handshake | 10 s | A socket must become host or player |
| Idle | 25 s | Node pings every 10 s; clients send `hb` every 10 s |

`tests/relay.test.ts` replays a minute of hard lab play and a host running four
phones, each with a stall, and asserts that nothing is dropped.

## 6. Running the Worker locally

`npm run build` (for the assets), then `npm run worker:dev`
(`wrangler dev --config worker/wrangler.jsonc`): workerd on this machine, no
account. `npm run test:worker` starts its own `wrangler dev` per relay on free
ports and runs the conformance suite against it. Nothing is deployed.

Before any deployment: add a Cloudflare rate limiting rule per IP on
`/ws/host` and `/ws/room/*` (the Worker's address table is per isolate only),
and decide how to bind the Worker's origin to the page's origin.
