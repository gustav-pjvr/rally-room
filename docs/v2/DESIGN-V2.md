# Rally Room v2 | design brief and direction

Self-authored under explicit creative delegation (BRIEF section 2: "You own
every decision"). Nothing here is a quotation from Gustav unless marked.
Process rules come from the `scroll-craft` skill (brief, originality,
verification; its scroll choreography is dropped because this is an app) and
UX rules from `ui-ux-pro-max` (never its looks).

## 1. Brief

- **What it is, and for whom:** living-room tennis for friends and family in
  one room. The TV or laptop shows the court; each player's phone is the
  racket. Nobody installs anything.
- **What a player must believe by the end:** "My swing put the ball there."
- **The one action:** scan the code and swing.
- **Vibe in five words:** dusk, floodlit, 1970s, sporty, warm.
- **References (reasons, not layouts):** 1970s tournament posters (flat
  colour, confident type, a sun disc); a club's hand-painted scoreboard at
  the end of a long day (worn, physical, legible from the far baseline);
  1970s television sport graphics (chunky, rounded, striped, friendly).
- **Energy curve:** quiet title and lobby, a calm first rally, loud long
  rallies, a held breath on the replay, a proud end screen.
- **Feeling curve, with what causes each:**
  1. Curious: a huge room code and QR on a floodlit court that is already alive.
  2. Delighted: the phone turns into a racket face and reacts to a practice swing.
  3. Focused: the first rally; the HUD gets out of the way.
  4. Loud: the rally counter climbs, the crowd rises, the lights feel hotter.
  5. Proud: the replay draws the winner's own swing path; the end screen
     prints the score line like a result worth keeping.
- **The peak:** "I swung late on purpose and it went down the line, and then
  it showed me my own swing." It lives in the match and its replay.
- **Tell-someone sentence:** "It's the game where your phone turns into the
  racket and you can feel where the ball hit the strings."
- **How far from premium-minimal:** far. The family is **retro and playful**,
  specific to the 1970s, not vaguely nostalgic.
- **Assets:** none supplied. Everything is made in code: geometry, shaders,
  SVG, Web Audio. No generated images, no spend.

## 2. Originality

- **Signature move (kept from v1):** the phone screen is the racket face, and
  a ripple starts where the ball met the strings. It comes from the one fact
  only this game has: the controller is in the player's hand and has a screen.
- **Second unique moment (new in v2):** the point replay draws the swing path
  from that phone's own sensor trace. It comes from the same fact: the game
  holds real motion data of a real swing.
- **Close:** the match-end screen is a printed result (score line, best
  rally, fastest swing) that holds still; it does not fade into a menu.
- **First-guess ideas, all dropped:** a green grass court with cartoon
  avatars; a neon "cyber" court; a white and blue console look with
  bobble-head figures; a generic esports HUD with angled panels.
- **Swap test:** the racket-face phone, the contact ripple and the sensor
  replay cannot be moved to another tennis game without its controller being
  a phone. Passes.
- **Describe-it test:** "A dusk hard court under warming floodlights, a
  seventies poster palette, and a phone that shows you where on the strings
  you hit it." Fits this game and no other.

## 3. Decisions fixed for every direction

Decided one at a time, before any markup.

### 3.1 Colour
The palette is named in the brief (DESIGN.md section 1), so it is earned, not
a default. Six roles:

| Role | Value | Use |
|---|---|---|
| Ink | `#1B1B1E` | Text on light, dark panels. Never pure black. |
| Cream | `#F3E9D2` | Text on dark, court lines, light panels. |
| Clay | `#D9622B` | The accent: one job per screen (the primary action, the server mark). |
| Teal | `#0F4C5C` | Large surfaces: court, panels. |
| Ball | `#D8EF3A` | The ball and anything that is "the ball's" (contact ripple, sweet spot). Nothing else. |
| Dusk | sky ramp from peach through rose to plum | The scene only, never UI chrome. |

Rules: teal and ink carry the large areas so the page never reads as the
cream-and-brass artisan look. Secondary text is a tint of its ground, never
flat grey. Body text 4.5:1 and large text 3:1, measured on the render. Team
colours must be told apart by more than hue (a shape or a label as well).

### 3.2 Motion
- UI: `transform` and `opacity` only, 120 to 240 ms,
  `cubic-bezier(0.23, 1, 0.32, 1)`, never ease-in, never `transition: all`.
- Enter from `scale(0.95)` and opacity 0. Press feedback on everything pressable.
- Score changes tick; big calls ("Out", "Ace") land hard and leave quickly.
- Game feel: a short hit-stop and a small camera kick on a clean hit, a
  slower camera on the replay.
- Reduced motion: opacity changes that carry meaning stay; position changes,
  shake, hit-stop and crowd bounce go.

### 3.3 Background
The live court is the background of every host screen. Title and lobby sit
over the court at dusk with a rally or a quiet court behind them; panels get
a local scrim where text sits, never a full-frame dark overlay. On the phone,
the background is the racket itself or one flat field of colour.

### 3.4 Typography (varies by direction, within these rules)
Two families at most: a display face with a 1970s voice and a text face.
Open licence, bundled in the build, never fetched (DECISIONS D9). Tracking
tightens as size grows. Tabular numerals for scores. Not Inter, not a
monospace costume, not a serif for "premium".

## 4. Looks to avoid (the refuse list for this project)

- Console-white minimalism, bobble-head or mascot avatars, any existing
  tennis or motion game's court, figures, HUD or sounds.
- Green grass with cartoon figures. Neon or cyber courts. Low-poly clay diorama.
- Esports chrome: angled panels, glow, gradient text, glass blur as decoration.
- Violet to blue gradients. Emoji as icons. Custom cursors.
- Identical card grids, three equal feature columns, a hero-metric block.
- An eyebrow above every heading, section counters, "scroll" cues.
- Em dashes or en dashes anywhere. Filler verbs. Invented statistics.
- A full-frame dark overlay to fix contrast.

## 5. UX rules that bind every screen

**TV and laptop (host):** readable from three metres: at 1920 x 1080 nothing a
player must read is under 28 px, the score is at least 72 px, and nothing
important sits in the outer 5% of the frame. The host is driven by keyboard
or mouse: visible focus, tab order in reading order, Escape pauses or goes
back, the current choice is marked by more than colour.

**Phone:** targets at least 48 px with 8 px between them, body text at least
16 px, no sideways scroll at 360 px, safe-area insets respected, one primary
action per screen, visible labels on every input, errors next to the field
with a way to recover, `touch-action: manipulation`, zoom never disabled.

**Everywhere:** no click or tap may look as if it did nothing (pending states
on buttons that wait, a skeleton for anything that waits on data for more
than about 300 ms), states for hover, focus, active and disabled, and one
label per intent ("Start match" is never also "Play" and "Begin").

**Flow:** title, then lobby (mode, players, opponent, join code), then match.
Back always returns to the previous screen with its choices kept. Quit is set
apart from Resume.

## 6. Screens

Host: title; lobby (room code, QR, players and sides, mode, opponent, match
length, first-session help); match (score, rally count, calls, serve prompt,
shot feedback); split-screen versus (two views, a shared score); pause;
point replay; match end; practice; tutorial.

Phone: join; allow motion; lobby (swing test, spin teaching); racket face in
play; reconnecting; game gone.

## 7. Three directions (mock-ups in `docs/v2/mockups/`)

All three share section 3 to 6. They differ in typography and graphic language.

| | A. Tournament poster | B. Club scoreboard | C. Broadcast '75 |
|---|---|---|---|
| Idea | A screen-printed tournament poster that moves | The hand-painted scoreboard of an old club at dusk | 1970s television sport graphics |
| Type | Heavy condensed display, flat and huge | Sign-painter slab or stencil numerals | Chunky rounded display |
| Graphic language | Flat colour blocks, a sun disc, thick rules, print grain | Painted boards, number plates that turn, lamp glow from the floodlights only | Stripes, rounded lozenges, lower-third bars |
| Risk | Could go cold and editorial | Could drift into fake wood and bolts | Could go childish |

The choice and its reason are recorded in DECISIONS when the mock-ups are in.
