/**
 * DOM overlays over the court canvas: title, setup, in-match HUD, pause and
 * match end. Reads MatchView only. Screen changes that are pure UI happen
 * here; the main wiring hears about the ones that matter through handlers.
 */
import QRCode from 'qrcode';
import type { HitWindow, Level, MatchConfig, MatchLength, MatchView, Side } from '../../engine/types';

export type Screen = 'title' | 'setup' | 'match' | 'pause' | 'end';

export interface UiHandlers {
  /** First click or key press anywhere: unlock audio here. Called once. */
  onUnlock?(): void;
  /** "Start match" or "Play again". The UI has already switched to 'match'. */
  onStart(config: MatchConfig): void;
  /** Escape or Pause (true), Resume or Escape again (false). The UI has already switched screen. */
  onPause(paused: boolean): void;
  /** "Quit to title" from the pause menu. The UI is already on 'title'. */
  onQuit(): void;
  /**
   * "Continue with the keyboard" on the waiting card (offered after a phone has
   * been away for a while). The handler takes the missing players over with
   * the keyboard and lifts the wait.
   */
  onKeyboard?(): void;
  /** Sound toggle in the pause menu. */
  onMute?(muted: boolean): void;
  /** Any setup option changed (format, human players, ...). */
  onSetupChange?(config: MatchConfig): void;
}

/** One phone card in the lobby's Players panel. */
export interface LobbyCard {
  slot: number;
  name: string;
  /** #rrggbb */
  color: string;
  connected: boolean;
  /** What the phone does in the chosen format, e.g. "Player 1" or "Watching". */
  role: string;
  /** True when the phone plays in the chosen format. */
  playing: boolean;
}

export interface Lobby {
  /** Show the room code and the phone link (QR). url null keeps the QR empty. */
  setRoom(code: string, url: string | null): void;
  /** A problem with the room or the link, shown where the link goes. */
  setRoomError(text: string): void;
  /** Redraw the phone cards (only when they changed) and the summary line. */
  setPlayers(cards: LobbyCard[], summary: string): void;
  /** Kick the swing meter on a phone's card. */
  kick(slot: number, power: number): void;
}

export interface Ui {
  show(screen: Screen): void;
  screen(): Screen;
  /** Call every frame while the screen is 'match' or 'pause'. Writes to the DOM only on change. */
  update(view: MatchView): void;
  /** Fill and show the match end screen. */
  end(view: MatchView): void;
  /** The config chosen on the setup screen. */
  config(): MatchConfig;
  /** Set the "Human players" picker (doubles) without the user touching it. */
  setHumans(humans: 1 | 2): void;
  /**
   * Waiting for a phone: the pause card shows `text` as its heading and Resume
   * (button and Escape) does nothing until this is set back to null.
   * `offerKeyboard` also shows "Continue with the keyboard" (`keys` names the
   * keys, e.g. "Space for player 1").
   */
  setWaiting(text: string | null, offerKeyboard?: { keys: string } | null): void;
  /** Resume from the pause screen, as the Resume button does. Ignored while waiting. */
  resume(): void;
  lobby: Lobby;
  dispose(): void;
}

const LENGTH_LABEL: Record<MatchLength, string> = { game1: '1 game', games3: '3 games', set1: '1 set' };

const TEMPLATE = `
<section class="rr-screen rr-title" data-screen="title" aria-labelledby="rr-title-h">
  <div class="rr-card rr-card--title">
    <div class="rr-stripes" aria-hidden="true"></div>
    <p class="rr-eyebrow">Living-room tennis</p>
    <h1 class="rr-logo" id="rr-title-h">Rally<br>Room</h1>
    <p class="rr-lede">Your phone is the racket. Timing is aim.</p>
    <div class="rr-actions">
      <button type="button" class="rr-btn rr-btn--primary rr-btn--big" data-act="play">Play</button>
      <a class="rr-link" href="/lab/">Sensor lab</a>
    </div>
  </div>
</section>

<section class="rr-screen rr-setup" data-screen="setup" aria-labelledby="rr-setup-h" hidden>
  <form class="rr-card rr-card--setup" data-form="setup">
    <div class="rr-stripes" aria-hidden="true"></div>
    <h2 id="rr-setup-h">Match setup</h2>
    <div class="rr-setup-cols">
      <section class="rr-players" aria-labelledby="rr-players-h">
        <h3 class="rr-sub" id="rr-players-h">Players</h3>
        <div class="rr-join">
          <canvas class="rr-qr" data-lobby="qr" width="144" height="144" role="img" aria-label="QR code with the phone link"></canvas>
          <div class="rr-join-text">
            <p class="rr-join-label" id="rr-code-label">Room code</p>
            <p class="rr-code" data-lobby="code" aria-labelledby="rr-code-label">&middot;&middot;&middot;&middot;</p>
            <p class="rr-url" data-lobby="url">Creating the room...</p>
          </div>
        </div>
        <ol class="rr-phones" data-lobby="phones" aria-label="Phones in the room"></ol>
        <p class="rr-phones-note" data-lobby="summary" role="status"></p>
      </section>
      <div class="rr-options">
        <div class="rr-grid">
          <fieldset class="rr-seg"><legend>Format</legend>
            <label><input type="radio" name="mode" value="singles" checked><span>Singles</span></label>
            <label><input type="radio" name="mode" value="doubles"><span>Doubles</span></label>
          </fieldset>
          <fieldset class="rr-seg" data-humans hidden><legend>Human players</legend>
            <label><input type="radio" name="humans" value="1" checked><span>1 player</span></label>
            <label><input type="radio" name="humans" value="2"><span>2 players</span></label>
          </fieldset>
          <fieldset class="rr-seg"><legend>Level</legend>
            <label><input type="radio" name="level" value="rookie"><span>Rookie</span></label>
            <label><input type="radio" name="level" value="club" checked><span>Club</span></label>
            <label><input type="radio" name="level" value="pro"><span>Pro</span></label>
          </fieldset>
          <fieldset class="rr-seg"><legend>Hit timing</legend>
            <label><input type="radio" name="window" value="easy"><span>Easy</span></label>
            <label><input type="radio" name="window" value="normal" checked><span>Normal</span></label>
            <label><input type="radio" name="window" value="pro"><span>Pro</span></label>
          </fieldset>
          <fieldset class="rr-seg"><legend>Match length</legend>
            <label><input type="radio" name="length" value="game1"><span>1 game</span></label>
            <label><input type="radio" name="length" value="games3" checked><span>3 games</span></label>
            <label><input type="radio" name="length" value="set1"><span>1 set</span></label>
          </fieldset>
        </div>
        <div class="rr-keys">
          <p>Time it: early sends the ball cross-court, late down the line.</p>
          <p>No phone? <kbd>Space</kbd> swings for player 1, <kbd>Enter</kbd> for player 2.
          Hold <kbd>W</kbd> for topspin, <kbd>S</kbd> for slice.</p>
        </div>
        <div class="rr-actions">
          <button type="submit" class="rr-btn rr-btn--primary">Start match</button>
          <button type="button" class="rr-btn rr-btn--ghost" data-act="back">Back</button>
        </div>
      </div>
    </div>
  </form>
</section>

<section class="rr-hud" data-hud hidden aria-label="Match" tabindex="-1">
  <div class="rr-bug" role="group" aria-label="Score">
    <div class="rr-bug-row" data-row="0"><span class="rr-serve"><span class="rr-sr-only"></span></span><span class="rr-name"></span><span class="rr-games"></span><span class="rr-points"></span></div>
    <div class="rr-bug-row" data-row="1"><span class="rr-serve"><span class="rr-sr-only"></span></span><span class="rr-name"></span><span class="rr-games"></span><span class="rr-points"></span></div>
    <div class="rr-callout" hidden></div>
  </div>
  <div class="rr-rally" hidden aria-hidden="true"></div>
  <div class="rr-message" hidden aria-hidden="true"></div>
  <p class="rr-hint"><kbd>Esc</kbd> pause</p>
</section>

<section class="rr-screen rr-pause" data-screen="pause" hidden role="dialog" aria-modal="true" aria-labelledby="rr-pause-h">
  <div class="rr-card rr-card--small">
    <h2 id="rr-pause-h">Paused</h2>
    <p class="rr-wait" data-wait hidden>Its place is held for 60 seconds. Play carries on when it reconnects.</p>
    <div class="rr-actions rr-actions--stack">
      <button type="button" class="rr-btn rr-btn--primary" data-act="keyboard" hidden>Continue with the keyboard</button>
      <button type="button" class="rr-btn rr-btn--primary" data-act="resume">Resume</button>
      <button type="button" class="rr-btn rr-btn--ghost" data-act="mute" aria-pressed="false">Sound: on</button>
      <button type="button" class="rr-btn rr-btn--ghost" data-act="quit">Quit to title</button>
    </div>
  </div>
</section>

<section class="rr-screen rr-end" data-screen="end" hidden aria-labelledby="rr-end-h">
  <div class="rr-card rr-card--end">
    <div class="rr-stripes" aria-hidden="true"></div>
    <p class="rr-eyebrow" data-end="eyebrow">Game, set and match</p>
    <h2 class="rr-winner" id="rr-end-h" data-end="winner"></h2>
    <p class="rr-scoreline"><span data-end="score"></span> <span class="rr-vs" data-end="sides"></span></p>
    <dl class="rr-stats">
      <div><dt>Longest rally</dt><dd data-end="rally"></dd></div>
      <div><dt>Fastest shot</dt><dd data-end="speed"></dd></div>
    </dl>
    <div class="rr-actions">
      <button type="button" class="rr-btn rr-btn--primary" data-act="again">Play again</button>
      <button type="button" class="rr-btn rr-btn--ghost" data-act="setup">Change setup</button>
    </div>
  </div>
</section>

<div class="rr-sr" aria-live="polite" aria-atomic="true"></div>
`;

export function createUi(root: HTMLElement, handlers: UiHandlers): Ui {
  root.classList.add('rr-overlay');
  root.innerHTML = TEMPLATE;
  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`ui: missing ${sel}`);
    return el;
  };

  const screens = {
    title: q<HTMLElement>('[data-screen="title"]'),
    setup: q<HTMLElement>('[data-screen="setup"]'),
    pause: q<HTMLElement>('[data-screen="pause"]'),
    end: q<HTMLElement>('[data-screen="end"]'),
  };
  const hud = q<HTMLElement>('[data-hud]');
  const form = q<HTMLFormElement>('[data-form="setup"]');
  const humansSet = q<HTMLFieldSetElement>('[data-humans]');
  const rows = [q<HTMLElement>('[data-row="0"]'), q<HTMLElement>('[data-row="1"]')];
  const cells = rows.map((r) => ({
    serve: r.querySelector<HTMLElement>('.rr-serve')!,
    name: r.querySelector<HTMLElement>('.rr-name')!,
    games: r.querySelector<HTMLElement>('.rr-games')!,
    points: r.querySelector<HTMLElement>('.rr-points')!,
  }));
  const callout = q<HTMLElement>('.rr-callout');
  const rallyEl = q<HTMLElement>('.rr-rally');
  const messageEl = q<HTMLElement>('.rr-message');
  const live = q<HTMLElement>('.rr-sr');
  const muteBtn = q<HTMLButtonElement>('[data-act="mute"]');
  const resumeBtn = q<HTMLButtonElement>('[data-act="resume"]');
  const pauseHeading = q<HTMLElement>('#rr-pause-h');
  const waitNote = q<HTMLElement>('[data-wait]');
  const keyboardBtn = q<HTMLButtonElement>('[data-act="keyboard"]');
  const lobbyEl = {
    qr: q<HTMLCanvasElement>('[data-lobby="qr"]'),
    code: q<HTMLElement>('[data-lobby="code"]'),
    url: q<HTMLElement>('[data-lobby="url"]'),
    phones: q<HTMLOListElement>('[data-lobby="phones"]'),
    summary: q<HTMLElement>('[data-lobby="summary"]'),
  };
  const endEl = (k: string) => q<HTMLElement>(`[data-end="${k}"]`);

  let current: Screen = 'title';
  let lastConfig: MatchConfig | null = null;
  let muted = false;
  let unlocked = false;
  let waiting: string | null = null;
  let cardsShown = '';

  // Cache of what the HUD shows, so update() touches the DOM only on change.
  const shown = { names: ['', ''], games: ['', ''], points: ['', ''], server: '' as Side | '', callout: '', rally: '', message: '' as string };
  function resetHud(): void {
    shown.names = ['', '']; shown.games = ['', '']; shown.points = ['', ''];
    shown.server = ''; shown.callout = '\u0000'; shown.rally = '\u0000'; shown.message = '\u0000';
  }
  resetHud();

  function readConfig(): MatchConfig {
    const data = new FormData(form);
    const mode = data.get('mode') === 'doubles' ? 'doubles' : 'singles';
    const humans = mode === 'doubles' && data.get('humans') === '2' ? 2 : 1;
    return {
      mode,
      humans,
      level: (data.get('level') as Level | null) ?? 'club',
      window: (data.get('window') as HitWindow | null) ?? 'normal',
      length: (data.get('length') as MatchLength | null) ?? 'games3',
    };
  }

  function focusFirst(el: HTMLElement, selector: string): void {
    const target = el.querySelector<HTMLElement>(selector);
    target?.focus({ preventScroll: true });
  }

  function show(screen: Screen): void {
    current = screen;
    screens.title.hidden = screen !== 'title';
    screens.setup.hidden = screen !== 'setup';
    screens.pause.hidden = screen !== 'pause';
    screens.end.hidden = screen !== 'end';
    hud.hidden = screen !== 'match' && screen !== 'pause';
    hud.inert = screen === 'pause';
    root.dataset.screen = screen;
    if (screen === 'title') focusFirst(screens.title, '[data-act="play"]');
    else if (screen === 'setup') focusFirst(screens.setup, 'input:checked');
    else if (screen === 'pause') focusFirst(screens.pause, keyboardBtn.hidden ? '[data-act="resume"]' : '[data-act="keyboard"]');
    else if (screen === 'end') focusFirst(screens.end, '[data-act="again"]');
    else {
      // In play, Space and Enter are swing keys: keep focus off every button.
      (document.activeElement as HTMLElement | null)?.blur?.();
      hud.focus({ preventScroll: true });
    }
  }

  function announce(text: string): void {
    live.textContent = text;
  }

  function start(config: MatchConfig): void {
    lastConfig = config;
    resetHud();
    messageEl.hidden = true;
    rallyEl.hidden = true;
    announce('Match started.');
    show('match');
    handlers.onStart(config);
  }

  function sideNames(view: MatchView, side: Side): string {
    const names: string[] = [];
    for (const p of view.players) if (p.side === side) names.push(p.name);
    return names.join(' / ') || (side === 'near' ? 'Near' : 'Far');
  }

  function update(view: MatchView): void {
    let scoreChanged = false;
    for (let i = 0; i < 2; i++) {
      const side: Side = i === 0 ? 'near' : 'far';
      const name = sideNames(view, side);
      if (name !== shown.names[i]) { shown.names[i] = name; cells[i].name.textContent = name; }
      const games = String(view.score.games[i]);
      if (games !== shown.games[i]) { shown.games[i] = games; cells[i].games.textContent = games; scoreChanged = true; }
      const points = view.score.points[i];
      if (points !== shown.points[i]) { shown.points[i] = points; cells[i].points.textContent = points; scoreChanged = true; }
    }
    if (view.score.server !== shown.server) {
      shown.server = view.score.server;
      for (let i = 0; i < 2; i++) {
        const on = shown.server === (i === 0 ? 'near' : 'far');
        cells[i].serve.classList.toggle('is-on', on);
        cells[i].serve.firstElementChild!.textContent = on ? 'Serving: ' : '';
      }
    }
    const co = view.score.callout || (view.score.tiebreak ? 'Tiebreak' : '');
    if (co !== shown.callout) {
      shown.callout = co;
      callout.textContent = co;
      callout.hidden = co === '';
    }
    const rally = view.rally >= 4 ? `Rally ${view.rally}` : '';
    if (rally !== shown.rally) {
      shown.rally = rally;
      rallyEl.textContent = rally;
      rallyEl.hidden = rally === '';
    }
    const msg = view.message ?? '';
    let said = '';
    if (msg !== shown.message) {
      shown.message = msg;
      messageEl.hidden = msg === '';
      if (msg) {
        messageEl.textContent = msg;
        messageEl.classList.remove('is-in');
        void messageEl.offsetWidth;
        messageEl.classList.add('is-in');
        said = msg + '.';
      }
    }
    if (scoreChanged) {
      const line = `${shown.names[0]} ${shown.points[0]}, ${shown.names[1]} ${shown.points[1]}. Games ${shown.games[0]} to ${shown.games[1]}.`;
      said = said ? `${said} ${line}` : line;
    }
    if (said) announce(said);
  }

  function end(view: MatchView): void {
    const length = lastConfig?.length ?? 'games3';
    endEl('eyebrow').textContent = length === 'set1' ? 'Game, set and match' : 'Game and match';
    const winner: Side = view.winner ?? (view.score.games[0] >= view.score.games[1] ? 'near' : 'far');
    endEl('winner').textContent = sideNames(view, winner);
    const useSets = view.score.sets[0] + view.score.sets[1] > 0;
    // Tennis convention: the winner's score comes first.
    const w = winner === 'near' ? 0 : 1;
    const a = useSets ? view.score.sets[w] : view.score.games[w];
    const b = useSets ? view.score.sets[1 - w] : view.score.games[1 - w];
    endEl('score').textContent = `${a}-${b}`;
    endEl('sides').textContent = `${sideNames(view, 'near')} v ${sideNames(view, 'far')}, ${LENGTH_LABEL[length]}`;
    const longest = view.stats.longestRally;
    endEl('rally').textContent = `${longest} ${longest === 1 ? 'shot' : 'shots'}`;
    endEl('speed').textContent = view.stats.fastestShotKmh > 0 ? `${Math.round(view.stats.fastestShotKmh)} km/h` : 'None yet';
    announce(`${sideNames(view, winner)} won, ${a}-${b}.`);
    show('end');
  }

  function setPaused(paused: boolean): void {
    if (!paused && waiting !== null) { announce(`${waiting}.`); return; }
    show(paused ? 'pause' : 'match');
    handlers.onPause(paused);
  }

  const onClick = (e: MouseEvent) => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'play': show('setup'); break;
      case 'back': show('title'); break;
      case 'resume': setPaused(false); break;
      case 'quit': show('title'); handlers.onQuit(); break;
      case 'keyboard': handlers.onKeyboard?.(); break;
      case 'again': start(lastConfig ?? readConfig()); break;
      case 'setup': show('setup'); break;
      case 'mute':
        muted = !muted;
        muteBtn.textContent = muted ? 'Sound: off' : 'Sound: on';
        muteBtn.setAttribute('aria-pressed', String(muted));
        handlers.onMute?.(muted);
        break;
    }
  };
  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    start(readConfig());
  };
  const onChange = () => {
    const config = readConfig();
    humansSet.hidden = config.mode !== 'doubles';
    handlers.onSetupChange?.(config);
  };

  function setHumans(humans: 1 | 2): void {
    const input = form.querySelector<HTMLInputElement>(`input[name="humans"][value="${humans}"]`);
    if (!input || input.checked) return;
    input.checked = true;
    onChange();
  }

  function setWaiting(text: string | null, offerKeyboard: { keys: string } | null = null): void {
    const offerChanged = keyboardBtn.hidden === Boolean(offerKeyboard && text !== null);
    if (text === waiting && !offerChanged) return;
    waiting = text;
    pauseHeading.textContent = text ?? 'Paused';
    waitNote.hidden = text === null;
    const offer = text !== null && offerKeyboard !== null;
    keyboardBtn.hidden = !offer;
    waitNote.textContent = offer
      ? `The phone has been away for a minute. Carry on with the keyboard (${offerKeyboard!.keys}) or quit; if the phone comes back, it takes over again.`
      : 'Its place is held for 60 seconds. Play carries on when it reconnects.';
    if (text === null) resumeBtn.removeAttribute('aria-disabled');
    else resumeBtn.setAttribute('aria-disabled', 'true');
    resumeBtn.hidden = offer;
    if (offer && current === 'pause' && offerChanged) focusFirst(screens.pause, '[data-act="keyboard"]');
    if (text !== null && current === 'pause') announce(offer ? `${text}. Continue with the keyboard, or quit.` : `${text}.`);
  }

  function renderCards(cards: LobbyCard[]): void {
    const key = JSON.stringify(cards);
    if (key === cardsShown) return;
    cardsShown = key;
    const items: HTMLLIElement[] = [];
    for (const card of cards) {
      const li = document.createElement('li');
      li.className = 'rr-phone';
      li.dataset.slot = String(card.slot);
      li.classList.toggle('is-out', !card.connected);
      li.classList.toggle('is-playing', card.playing);
      li.style.setProperty('--pc', card.color);
      const head = document.createElement('div');
      head.className = 'rr-phone-head';
      const swatch = document.createElement('span');
      swatch.className = 'rr-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'rr-phone-name';
      name.textContent = card.name;
      name.title = card.name;
      head.append(swatch, name);
      const role = document.createElement('span');
      role.className = 'rr-phone-role';
      role.textContent = card.role;
      const state = document.createElement('span');
      state.className = 'rr-phone-state';
      state.textContent = card.connected ? 'Connected' : 'Reconnecting…';
      const meter = document.createElement('span');
      meter.className = 'rr-meter';
      meter.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'rr-meter-fill';
      meter.append(fill);
      li.append(head, role, state, meter);
      items.push(li);
    }
    for (let i = cards.length; i < 4; i++) {
      const li = document.createElement('li');
      li.className = 'rr-phone is-empty';
      li.textContent = 'Open: scan to join';
      items.push(li);
    }
    lobbyEl.phones.replaceChildren(...items);
  }

  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lobby: Lobby = {
    setRoom(code, url) {
      lobbyEl.code.textContent = code;
      lobbyEl.url.textContent = url ?? '';
      lobbyEl.qr.setAttribute('aria-label', url ? `QR code with the phone link ${url}` : 'QR code with the phone link');
      if (url) {
        QRCode.toCanvas(lobbyEl.qr, url, { width: 144, margin: 1, color: { dark: '#1B1B1E', light: '#F3E9D2' } })
          .catch(() => lobby.setRoomError('Could not draw the QR code. Type the link instead.'));
      }
    },
    setRoomError(text) {
      lobbyEl.url.textContent = text;
    },
    setPlayers(cards, summary) {
      renderCards(cards);
      if (lobbyEl.summary.textContent !== summary) lobbyEl.summary.textContent = summary;
    },
    kick(slot, power) {
      const fill = lobbyEl.phones.querySelector<HTMLElement>(`[data-slot="${slot}"] .rr-meter-fill`);
      if (!fill) return;
      const p = Math.max(0.06, Math.min(1, Number.isFinite(power) ? power : 0));
      if (reduceMotion || typeof fill.animate !== 'function') {
        fill.style.transform = `scaleX(${p})`;
        return;
      }
      fill.getAnimations().forEach((a) => a.cancel());
      fill.animate(
        [{ transform: 'scaleX(0)' }, { transform: `scaleX(${p})`, offset: 0.12 }, { transform: `scaleX(${p})`, offset: 0.45 }, { transform: 'scaleX(0)' }],
        { duration: 1400, easing: 'ease-out' },
      );
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat) return;
    if (current === 'match') { e.preventDefault(); setPaused(true); }
    else if (current === 'pause') { e.preventDefault(); setPaused(false); }
    else if (current === 'setup') { e.preventDefault(); show('title'); }
  };
  const onFirst = () => {
    if (unlocked) return;
    unlocked = true;
    handlers.onUnlock?.();
  };

  root.addEventListener('click', onClick);
  form.addEventListener('submit', onSubmit);
  form.addEventListener('change', onChange);
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onFirst, true);
  window.addEventListener('keydown', onFirst, true);

  show('title');

  return {
    show,
    screen: () => current,
    update,
    end,
    config: readConfig,
    setHumans,
    setWaiting,
    resume: () => { if (current === 'pause') setPaused(false); },
    lobby,
    dispose() {
      root.removeEventListener('click', onClick);
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('change', onChange);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onFirst, true);
      window.removeEventListener('keydown', onFirst, true);
      root.innerHTML = '';
    },
  };
}
