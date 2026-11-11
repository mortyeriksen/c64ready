// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/toast.js — the unlock, score and notice toasts: a pixel
// icon for the kind, the title over a line of text, the points. One shows at a
// time, each for the same time, the rest wait. On the C64's screen where the
// player put them (toast-place.js), in the vibes view while it is open, else
// at the foot of the page (styles-achievements.css).
//
// It lands, its title flips in, and the points count up to one payoff beat:
// the chip pops, and the bigger the unlock the more goes off with it. A new
// best score is stamped BEST. A new first place turns the card over to gold,
// and so does the unlock that finishes a game's set, showing the game's icon.
// Every effect is on the toast or thrown off it, never on the screen behind,
// in the theme's colours, and none plays under reduced motion.

/** How long every toast shows, from the moment it appears. */
export const ACH_TOAST_MS = 5000;
/** A finished set's toast stays this much longer: its turn comes after the unlock's own payoff. */
export const COMPLETE_EXTRA_MS = 2500;
/** Unlocks worth this many points or more get the sweep, the sparkles, the full celebration. */
export const SWEEP_POINTS = 10, SPARKLE_POINTS = 25, CELEBRATE_POINTS = 50;

// 10x10: '#' lit, '+' half-tone, '.' none.
export const KIND_ICONS = {
  // A trophy.
  unlock: ['##########', '#+######+#', '#+######+#', '.+######+.', '..######..', '...####...', '....##....', '....##....', '..######..', '..######..'],
  // A podium with a medal over it.
  score: ['....##....', '...####...', '....##....', '..........', '...####...', '...####...', '####++####', '####++####', '##########', '##########'],
  // A warning sign.
  notice: ['....##....', '...####...', '...#++#...', '..##++##..', '..##++##..', '.###++###.', '.########.', '####++####', '##########', '..........'],
  // A crown, for first place.
  crown: ['..........', '#...##...#', '##.####.##', '##########', '##########', '#+##+##+##', '##########', '##########', '..........', '..........'],
};
// Confetti: PETSCII characters, 8x8 like the C64's own, in the theme's medal colours.
const CONFETTI = ['--medal-gold', '--highlight', '--amber', '--medal-silver', '--medal-bronze'];
const PETSCII = [
  ['.##..##.', '########', '########', '########', '.######.', '..####..', '...##...', '........'],   // heart
  ['...##...', '..####..', '.######.', '########', '.######.', '..####..', '...##...', '........'],   // diamond
  ['...##...', '..####..', '.######.', '########', '########', '...##...', '..####..', '........'],   // spade
  ['...##...', '..####..', '...##...', '.##..##.', '########', '.##..##.', '...##...', '..####..'],   // club
  ['...#....', '...#....', '.#####..', '..###...', '.##.##..', '.#...#..', '........', '........'],   // star
  ['..####..', '.######.', '########', '########', '########', '########', '.######.', '..####..'],   // ball
];
// Each character in each colour, drawn once: colour → [an 8x8 canvas per character].
const glyphCache = new Map();
function glyphs(color) {
  let set = glyphCache.get(color);
  if (set) return set;
  set = PETSCII.map((rows) => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = color;
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') g.fillRect(x, y, 1, 1); }));
    return c;
  });
  glyphCache.set(color, set);
  return set;
}
// The theme's colours as the toast sees them.
function themeColors(el, names) {
  const probe = document.createElement('i');
  el.append(probe);
  const out = names.map((n) => { probe.style.color = `var(${n})`; return getComputedStyle(probe).color; });
  probe.remove();
  return out;
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const later = (ms, fn) => setTimeout(fn, ms);
const replay = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
/**
 * A node's text changed in place, in its one text node, and only when it differs: a node put in
 * or taken out would have the page's body:has() rules restyle the whole page.
 */
export function write(node, text) {
  const t = node.firstChild;
  // Without a text node to change (no text yet, or letters put in as elements) it is set whole.
  if (!t || t.nodeType !== 3) node.textContent = text;
  else if (t.data !== text) t.data = text;
}

// An icon is one element: its pixels a mask over the kind's colour (styles-achievements.css),
// so the toast stays a dozen elements to restyle, and a change of colour needs no redraw.
const iconMasks = new Map();
/** A 10x10 bitmap as a CSS mask image, made once. */
export function iconMask(rows) {
  const key = rows.join('');
  let mask = iconMasks.get(key);
  if (!mask) {
    let rects = '';
    rows.forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== '.') rects += `<rect x='${x}' y='${y}' width='1' height='1'${c === '+' ? " fill-opacity='.5'" : ''}/>`;
    }));
    mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10' shape-rendering='crispEdges'>${rects}</svg>`)}")`;
    iconMasks.set(key, mask);
  }
  return mask;
}
function drawIcon(icon, rows) {
  icon.style.setProperty('--ach-icon', iconMask(rows));
  icon.style.removeProperty('--ach-art');
  icon.dataset.rows = rows.join('');
  delete icon.dataset.art;
}
/** Shows a game's colour icon (its URL, game-icons.js) on an icon element, or the trophy without one. */
export function drawGameIcon(icon, url) {
  if (!url) { drawIcon(icon, KIND_ICONS.unlock); return; }
  icon.style.setProperty('--ach-art', `url("${url}")`);
  icon.style.removeProperty('--ach-icon');
  icon.dataset.art = url;
  delete icon.dataset.rows;
}

/** The unlock's tier by its points: 0 calm, 1 the sweep, 2 sparkles, 3 the full celebration. */
export const unlockTier = (points = 0) => (points >= CELEBRATE_POINTS ? 3 : points >= SPARKLE_POINTS ? 2 : points >= SWEEP_POINTS ? 1 : 0);

/**
 * @param {object} o
 * @param {() => HTMLElement|null} o.host  where a toast goes; null for the page
 * @param {number} [o.ms]                  how long each one shows
 */
export function createAchToasts({ host, ms = ACH_TOAST_MS }) {
  const waiting = [];
  let current = null;

  /**
   * @param {object} t
   * @param {'unlock'|'score'|'notice'} t.kind
   * @param {string} t.title
   * @param {string} [t.text]
   * @param {number} [t.points]           an unlock's points
   * @param {object} [t.score]            a posted score, after the title:
   * @param {number} t.score.value
   * @param {(v: number) => string} t.score.format
   * @param {'plain'|'best'|'top'} [t.score.outcome]  a new personal best, or a new first place
   * @param {number|null} [t.score.from]  the old best it rolls up from
   * @param {number|null} [t.score.rankFrom]  the old rank, ticking down to the new one
   * @param {number|null} [t.score.rank]  the new rank: a new best that climbs shows "Rank" after the text, ticking from rankFrom
   * @param {boolean} [t.score.stillTop]  a new best by the player already first: a crown for the icon
   * @param {string} [t.score.topTitle]  for a new first place, the title it turns to, such as the board's own
   * @param {object} [t.complete]         the unlock finishes the game's set: the toast then turns to gold
   * @param {string} [t.complete.icon]    the game's icon URL (game-icons.js)
   * @param {string} t.complete.title
   * @param {string} t.complete.text
   * @param {string} [t.action]           a button's label
   * @param {() => void} [t.onAction]
   */
  function show(t) {
    waiting.push(t);
    if (!current) next();
    else counter();
  }

  function next() {
    const t = waiting.shift();
    current = t ? build(t) : null;
    if (current) counter();
  }

  // How many wait behind the one showing.
  function counter() {
    let el = current.el.querySelector('.ach-toast-more');
    if (!waiting.length) { el?.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'ach-toast-more'; current.el.append(el); }
    write(el, `+${waiting.length}`);
  }

  // A toast, timed and in the queue, or pinned: a sample that stays until closed.
  function build(t, pinned = null) {
    const place = pinned?.place ?? host() ?? document.body;
    const el = document.createElement('div');
    // The theme's dark colours everywhere, as on the monitor: over the picture, the vibes scene or the page.
    el.className = `ach-toast ach-toast-${t.kind} mode-dark${place === document.body ? ' ach-toast-page' : ''}`;
    el.setAttribute('role', 'status');
    const life = ms + (t.complete ? COMPLETE_EXTRA_MS : 0);
    el.style.setProperty('--ach-toast-ms', `${life}ms`);
    const still = reducedMotion();

    const icon = document.createElement('div');
    icon.className = 'ach-toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    drawIcon(icon, KIND_ICONS[t.kind]);

    const words = document.createElement('div');
    words.className = 'ach-toast-words';
    const title = document.createElement('span');
    title.className = 'ach-toast-title';
    const heading = t.score ? `${t.title}: ` : t.title;
    if (still) title.textContent = heading;
    else flap(title, heading);
    let num = null;
    if (t.score) {
      num = document.createElement('span');
      num.className = 'ach-toast-num';
      num.textContent = t.score.format(t.score.value);
      title.append(num);
    }
    title.setAttribute('aria-label', t.score ? `${heading}${t.score.format(t.score.value).trim()}` : t.title);
    words.append(title);
    const text = document.createElement('span');
    text.className = 'ach-toast-text';
    text.textContent = t.text ?? '';
    if (t.text) words.append(text);
    // A new best that climbs the board: its rank after the text, ticking down from the old one.
    let climb = null;
    if (t.score?.outcome === 'best' && climbs(t.score)) {
      climb = document.createElement('span');
      climb.className = 'ach-toast-rank';
      climb.textContent = String(still ? t.score.rank : t.score.rankFrom);
      text.append(text.textContent ? ' Rank ' : 'Rank ', climb);
      if (!text.isConnected) words.append(text);
    }
    if (t.score?.stillTop) drawIcon(icon, KIND_ICONS.crown);
    el.title = t.text ? `${title.getAttribute('aria-label')}\n${t.text}` : title.getAttribute('aria-label');
    el.append(icon, words);

    let chip = null;
    if (t.points) {
      chip = document.createElement('span');
      chip.className = 'ach-toast-points';
      chip.textContent = `+${t.points}`;
      el.append(chip);
    }
    if (t.action) {
      const act = document.createElement('button');
      act.className = 'ach-toast-action';
      act.textContent = t.action;
      act.addEventListener('click', () => { t.onAction?.(); leave(); });
      el.append(act);
    }
    const x = document.createElement('button');
    x.className = 'ach-toast-x';
    x.setAttribute('aria-label', 'Dismiss');
    // Drawn, not a character: the toast's font has no ✕, and finding one stalls the first toast.
    x.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"/></svg>';
    x.addEventListener('click', () => (pinned ? pinned.onClose() : leave()));
    const bar = document.createElement('i');
    bar.className = 'ach-toast-time';
    el.append(x, bar);
    place.append(el);
    if (pinned) return { el };

    // The same time for every toast. Pointing at it holds the time, as the bar shows.
    let left = life, since = performance.now();
    let timer = setTimeout(leave, left);
    el.addEventListener('pointerenter', () => { clearTimeout(timer); left -= performance.now() - since; });
    el.addEventListener('pointerleave', () => { since = performance.now(); timer = setTimeout(leave, Math.max(0, left)); });

    const me = { el, shownAt: performance.now() };
    const live = () => el.isConnected && !el.classList.contains('ach-toast-out');
    const words2 = { title, text };
    if (still) {
      if (t.complete) finished(el, icon, words2, chip, t.complete);
    } else {
      const done = () => {
        if (!live()) return;
        if (chip) payoff(el, chip, unlockTier(t.points));
        if (t.complete) later(chip && unlockTier(t.points) >= 3 ? 1500 : 700, () => live() && completeSet(el, icon, words2, chip, t.complete, live));
      };
      if (chip) count(chip, 0, t.points, (v) => `+${v}`, 700, done);
      else if (t.complete) later(1150, done);
      if (t.score && t.score.outcome && t.score.outcome !== 'plain') scored(el, icon, text, num, t.score, live, climb);
    }

    function leave() {
      clearTimeout(timer);
      if (el.classList.contains('ach-toast-out')) return;
      el.classList.add('ach-toast-out');
      const gone = () => {
        if (!el.isConnected) return;
        el.remove();
        if (current === me) next();
      };
      el.addEventListener('animationend', (e) => { if (e.target === el) gone(); });
      setTimeout(gone, 400);
    }
    return me;
  }

  /** Moves the toast showing to where toasts now go, such as into vibes when it opens. */
  function rehome() {
    if (!current) return;
    const place = host() ?? document.body;
    const { el, shownAt } = current;
    if (el.parentElement === place || el.classList.contains('ach-toast-out')) return;
    el.classList.toggle('ach-toast-page', place === document.body);
    // Moving restarts its animations: the time bar picks up where it was.
    el.querySelector('.ach-toast-time').style.animationDelay = `-${performance.now() - shownAt}ms`;
    place.append(el);
  }

  /**
   * A sample toast pinned to a place until closed, such as the one dragged
   * into position.
   * @param {object} t           as for show()
   * @param {HTMLElement} place
   * @param {() => void} onClose its ✕
   */
  function sample(t, place, onClose) {
    return build(t, { place, onClose }).el;
  }

  /**
   * Lets go of the toasts waiting behind the one showing, as when a new game
   * starts and they are about the game before it. The one showing keeps its time.
   */
  function dropWaiting() {
    if (!waiting.length) return;
    waiting.length = 0;
    if (current) counter();
  }

  return { show, rehome, sample, dropWaiting };
}

/** Each letter flips down in turn. */
export function flap(title, heading) {
  title.textContent = '';
  [...heading].forEach((c, i) => {
    const ch = document.createElement('span');
    ch.className = 'ach-toast-ch';
    ch.setAttribute('aria-hidden', 'true');
    ch.style.setProperty('--i', i);
    ch.textContent = c;
    title.append(ch);
  });
  title.setAttribute('aria-label', heading);
}

// The finished set's side of the card: gold, the game's icon, its line and a 100% stamp.
function finished(el, icon, words, chip, c, stamped = true) {
  el.classList.add('ach-toast-gold');
  drawGameIcon(icon, c.icon);
  words.title.textContent = c.title;
  words.title.setAttribute('aria-label', c.title);
  words.text.textContent = c.text;
  if (!words.text.isConnected) el.querySelector('.ach-toast-words').append(words.text);
  el.title = `${c.title}\n${c.text}`;
  chip?.remove();
  if (stamped) stamp(el, '100%');
}

// The unlock that finishes a set: after its own payoff, a tremble, the card
// turns over to its gold side, the title flips in again, and the full celebration.
function completeSet(el, icon, words, chip, c, live) {
  tremble(el, () => turnOver(el, () => {
    finished(el, icon, words, chip, c, false);
    flap(words.title, c.title);
  }, () => {
    if (!live()) return;
    stamp(el, '100%');
    el.classList.add('ach-toast-foil');
    celebrate(el, { rings: 2, pieces: 48 });
  }));
}

/** Counts a number from one value to another, easing out, after the landing. */
export function count(node, from, to, format, dur, done) {
  const start = performance.now() + 450;
  // Its widest value's characters, which the stylesheet makes room for from the start, so the
  // toast does not grow as a digit is added. Nothing is read back.
  node.style.setProperty('--ach-count', String(Math.max(format(from).length, format(to).length)));
  let shown = format(from);
  write(node, shown);
  const step = (now) => {
    if (!node.isConnected && now > start) return;
    const p = Math.min(1, Math.max(0, (now - start) / dur));
    // Only a changed number is written: each write restyles and lays out the toast.
    const next = format(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
    if (next !== shown) { shown = next; write(node, next); }
    if (p < 1) requestAnimationFrame(step);
    else done?.();
  };
  requestAnimationFrame(step);
}

// The payoff when an unlock's points land: the chip pops, then by its tier
// the sweep, the sparkles off the chip, or the full celebration with a coin spin.
function payoff(el, chip, tier) {
  replay(chip, 'ach-toast-pop');
  if (tier >= 1) el.classList.add('ach-toast-sweep');
  if (tier === 2) sparkle(el, chip);
  if (tier >= 3) celebrate(el, { spin: true });
}

// A posted score that beat something: it rolls up from the old best, then a
// BEST stamp, or for a new first place the rank ticks down, the card turns
// over to gold with a crown, and the full celebration.
const climbs = (s) => Number.isFinite(s.rankFrom) && Number.isFinite(s.rank) && s.rankFrom > s.rank;

// Ticks a rank down from one place to another, quicker each time: when it is done.
function tickRank(node, from, to, done) {
  const gap = from - to;
  const steps = gap <= 4 ? Array.from({ length: gap }, (_, i) => from - 1 - i) : [Math.ceil((from + to) / 2), to + 2, to + 1, to];
  let at = 0;
  steps.forEach((n, i) => { at += Math.max(90, 220 - i * 50); later(at, () => { write(node, String(n)); replay(node, 'ach-toast-bump'); }); });
  later(at + 160, done);
}

function scored(el, icon, text, num, s, live, climb) {
  const titleEl = el.querySelector('.ach-toast-title');
  const top = s.outcome === 'top';
  const from = Number.isFinite(s.from) ? s.from : 0;
  let rank = null;
  if (top && Number.isFinite(s.rankFrom) && s.rankFrom > 1) {
    text.textContent = 'Rank ';
    rank = document.createElement('span');
    rank.className = 'ach-toast-rank';
    rank.textContent = String(s.rankFrom);
    text.append(rank);
    if (!text.isConnected) el.querySelector('.ach-toast-words').append(text);
  }
  count(num, from, s.value, s.format, top ? 800 : 1000, () => {
    if (!live()) return;
    if (!top) {
      const best = () => {
        if (!live()) return;
        const st = stamp(el, 'BEST');
        el.classList.add('ach-toast-sweep');
        sparkle(el, st);
      };
      if (climb) tickRank(climb, s.rankFrom, s.rank, best);
      else best();
      return;
    }
    // The rank ticks down to 1, then the card turns over.
    const turn = () => {
      if (!live()) return;
      tremble(el, () => turnOver(el, () => {
        el.classList.add('ach-toast-gold');
        drawIcon(icon, KIND_ICONS.crown);
        if (s.topTitle) {
          flap(titleEl, `${s.topTitle}: `);
          titleEl.append(num);
          titleEl.setAttribute('aria-label', `${s.topTitle}: ${num.textContent}`);
        }
        text.textContent = 'Top of the board!';
        if (!text.isConnected) el.querySelector('.ach-toast-words').append(text);
      }, () => {
        if (!live()) return;
        stamp(el, '#1');
        el.classList.add('ach-toast-foil');
        celebrate(el, { rings: 2, pieces: 44 });
      }));
    };
    if (rank) tickRank(rank, s.rankFrom, 1, turn);
    else later(160, turn);
  });
}

function stamp(el, label) {
  const st = document.createElement('span');
  st.className = 'ach-toast-stamp';
  st.textContent = label;
  el.insertBefore(st, el.querySelector('.ach-toast-x'));
  return st;
}

/** A short, tightening tremble. */
export function tremble(el, done) {
  el.animate([
    { transform: 'none' }, { transform: 'translateX(-1px) rotate(-0.8deg)' }, { transform: 'translateX(1px) rotate(0.8deg)' },
    { transform: 'translateX(-1px) rotate(-0.5deg)' }, { transform: 'translateX(1px) rotate(0.3deg)' }, { transform: 'none' },
  ], { duration: 260 }).onfinish = done;
}

// Turns the card over: halfway it changes, and it settles past square and back.
function turnOver(el, change, done) {
  el.animate([{ transform: 'perspective(30em) rotateY(0deg)' }, { transform: 'perspective(30em) rotateY(90deg)' }],
    { duration: 170, easing: 'cubic-bezier(.5,0,1,.6)' }).onfinish = () => {
    change();
    el.animate([{ transform: 'perspective(30em) rotateY(-90deg)' }, { transform: 'perspective(30em) rotateY(12deg)', offset: 0.7 }, { transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = done;
  };
}

// Where effects thrown off a toast go: its own parent, in that parent's coordinates.
function layer(el) {
  const place = el.parentElement;
  if (!place) return null;
  const page = place === document.body;
  const rect = page ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : place.getBoundingClientRect();
  const add = (node) => { if (page) node.classList.add('ach-toast-page'); place.append(node); return node; };
  return { box: rect, width: rect.width, height: rect.height, add };
}

// The sparks: 14 of them, each 700 ms on its way after a wait of up to 120 ms, fading in 32 steps.
const SPARKS = 14, SPARK_MS = 700, SPARK_WAIT = 120, SPARK_FADES = 32;
// Their ease, cubic-bezier(.2, .7, .4, 1), as 256ths of the way at each millisecond: made once,
// so a frame looks a spark's place and fade up.
const SPARK_EASE = (() => {
  const curve = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const out = new Uint8Array(SPARK_MS);
  for (let ms = 0; ms < SPARK_MS; ms++) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (curve(0.2, 0.4, mid) < ms / SPARK_MS) lo = mid; else hi = mid; }
    out[ms] = Math.min(255, Math.floor(curve(0.7, 1, lo) * 256));
  }
  return out;
})();
// A colour at each step of a spark's fading, a pixel each in a strip: drawn once per colour.
const fadeCache = new Map();
function fades(color) {
  let strip = fadeCache.get(color);
  if (strip) return strip;
  strip = document.createElement('canvas');
  strip.width = SPARK_FADES; strip.height = 1;
  const g = strip.getContext('2d');
  g.fillStyle = color;
  for (let i = 0; i < SPARK_FADES; i++) { g.globalAlpha = 1 - i / SPARK_FADES; g.fillRect(i, 0, 1, 1); }
  fadeCache.set(color, strip);
  return strip;
}

/** A few pixels thrown off `from`, a part of `el`, in `el`'s colour and white, once. */
export function sparkle(el, from) {
  const at = layer(el);
  if (!at) return;
  const r = from.getBoundingClientRect();
  sparkleAt(el, r.left - at.box.left + r.width / 2, r.top - at.box.top + r.height / 2, Math.max(r.width, r.height) * 1.8, at.width);
}

/**
 * The same from a spot measured already: `x` and `y` in `el`'s parent, which is `width` wide,
 * thrown `reach` far. One small canvas draws them all: no element, style or timer per spark. Its
 * pixels are spark-sized, scaled up by the page (image-rendering: pixelated), and it covers only
 * the square the sparks can reach. It removes itself when the last has faded.
 */
export function sparkleAt(el, x, y, reach, width) {
  const place = el.parentElement;
  if (!place) return;
  const cs = getComputedStyle(el);
  // A spark's side in whole page pixels: the share of the parent's width the stylesheet gives, and its least.
  const side = Math.max(parseFloat(cs.getPropertyValue('--ach-spark-min')) || 2, Math.round(width * (parseFloat(cs.getPropertyValue('--ach-spark-share')) || 0.0045)));
  const ink = fades(cs.getPropertyValue('--ach-ink').trim()), white = fades(cs.getPropertyValue('--highlight').trim());
  // A spark flies up to 1.2 times the reach: so many pixels each way from the middle one, where they start.
  const mid = Math.ceil((reach * 1.2) / side), n = 2 * mid + 1;
  const canvas = document.createElement('canvas');
  canvas.className = place === document.body ? 'ach-toast-spark ach-toast-page' : 'ach-toast-spark';
  canvas.width = n;
  canvas.height = n;
  canvas.style.cssText = `left:${Math.round(x) - mid * side}px;top:${Math.round(y) - mid * side}px;width:${n * side}px;height:${n * side}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // Each spark in whole numbers: how far it flies in 256ths of a pixel, and its wait in ms. With
  // the time in whole ms too, a frame allocates nothing.
  const DX = new Int32Array(SPARKS), DY = new Int32Array(SPARKS), WAIT = new Uint8Array(SPARKS);
  for (let k = 0; k < SPARKS; k++) {
    const a = (k / SPARKS) * Math.PI * 2 + Math.random() * 0.4;
    const d = ((reach * (0.6 + Math.random() * 0.6)) / side) * 256;
    DX[k] = Math.round(Math.cos(a) * d);
    DY[k] = Math.round(Math.sin(a) * d);
    WAIT[k] = Math.round(Math.random() * SPARK_WAIT);
  }
  const start = performance.now() | 0;
  const step = (now) => {
    if (!canvas.isConnected) return;
    const ms = ((now | 0) - start) | 0;
    ctx.clearRect(0, 0, n, n);
    let flying = 0;
    for (let k = 0; k < SPARKS; k++) {
      const t = ms - WAIT[k];
      if (t >= SPARK_MS) continue;
      flying++;
      // Still at the start, whole, while it waits. Every third one is white.
      const e = t > 0 ? SPARK_EASE[t] : 0;
      ctx.drawImage(k % 3 ? ink : white, (e * SPARK_FADES) >> 8, 0, 1, 1, mid + ((DX[k] * e + 32768) >> 16), mid + ((DY[k] * e + 32768) >> 16), 1, 1);
    }
    if (flying) requestAnimationFrame(step);
    else canvas.remove();
  };
  place.append(canvas);
  requestAnimationFrame(step);
}

/** The shower's canvas in character pixels of `px` CSS pixels: the whole ones that fit in the layer. */
export function showerGrid(width, height, px) {
  return { cols: Math.max(1, Math.floor(width / px)), rows: Math.max(1, Math.floor(height / px)) };
}

// A PETSCII shower: characters flung up from the toast that fall with gravity,
// on a pixel grid sized to the toast and stepping 25 times a second, the way
// a C64 game moves its sprites. Now and then one turns into another character.
function shower(el, at, r, x0, y0, count) {
  const colors = themeColors(el, CONFETTI).map(glyphs);
  const px = Math.max(1, Math.round(r.height / 22));   // one character pixel
  const size = px * 8;
  const g = Math.max(r.height * 30, 900);              // gravity, pixels per second²
  // No higher than the room above the toast, so a toast at the top of the screen still rains over it.
  const throwUp = Math.sqrt(2 * g * Math.max(r.height, y0 + r.height / 2));
  // One canvas over the toast's parent draws them all: no element per piece, no style work per tick.
  // Its pixels are character pixels, scaled up by the page (image-rendering: pixelated): the
  // pieces only ever sit on that grid, so the picture is the same and the canvas is px² times smaller.
  const canvas = at.add(document.createElement('canvas'));
  canvas.className += ' ach-toast-shower';
  const { cols, rows } = showerGrid(at.width, at.height, px);
  canvas.width = cols;
  canvas.height = rows;
  canvas.style.width = `${cols * px}px`;
  canvas.style.height = `${rows * px}px`;
  const ctx = canvas.getContext('2d');
  // Each piece in whole numbers: positions in 1/256ths of a character pixel, time in 40 ms
  // ticks. The step runs too few times to be optimized, and whole numbers, unlike decimals,
  // are never boxed, so a tick allocates nothing.
  const TICK = 0.04, SUB = 256, perTick = TICK * SUB / px;
  const X = new Int32Array(count), Y = new Int32Array(count), VX = new Int32Array(count), VY = new Int32Array(count);
  const AGE = new Uint16Array(count), LIFE = new Uint16Array(count), CH = new Uint8Array(count);
  const G = Math.round(g * TICK * perTick);
  const SET = [];
  for (let k = 0; k < count; k++) {
    SET.push(colors[k % colors.length]);
    CH[k] = k % PETSCII.length;
    X[k] = Math.round((x0 + r.width / 2 + (Math.random() - 0.5) * r.width * 0.8 - size / 2) / px * SUB);
    Y[k] = Math.round((y0 + r.height / 2 - size / 2) / px * SUB);
    VX[k] = Math.round((Math.random() - 0.5) * r.width * 1.6 * perTick);
    VY[k] = Math.round(-Math.min(r.height * (2.5 + Math.random() * 4), throwUp * (0.55 + Math.random() * 0.45)) * perTick);
    LIFE[k] = Math.round((1.3 + Math.random() * 0.8) / TICK);
  }
  const half = SUB >> 1;
  const draw = () => {
    ctx.clearRect(0, 0, cols, rows);
    for (let k = 0; k < count; k++) {
      if (AGE[k] >= LIFE[k]) continue;
      ctx.drawImage(SET[k][CH[k]], (X[k] + half) >> 8, (Y[k] + half) >> 8);
    }
  };
  const clock = new Float64Array(2);   // [the last frame's time, time not yet stepped]
  clock[0] = performance.now();
  let alive = count;
  const step = (now) => {
    if (!canvas.isConnected) return;
    clock[1] += (now - clock[0]) / 1000;
    clock[0] = now;
    const ticks = Math.floor(clock[1] / TICK);
    if (ticks > 0) {
      clock[1] -= ticks * TICK;
      for (let t = 0; t < ticks; t++) {
        alive = 0;
        for (let k = 0; k < count; k++) {
          if (AGE[k] >= LIFE[k]) continue;
          AGE[k]++; VY[k] += G; VX[k] = (VX[k] * 252) >> 8; X[k] += VX[k]; Y[k] += VY[k];
          if (AGE[k] >= LIFE[k]) continue;
          alive++;
          // Now and then a character turns into the next one.
          if ((AGE[k] + k * 7) % 25 === 0) CH[k] = (CH[k] + 1) % PETSCII.length;
        }
      }
      draw();
    }
    if (alive) requestAnimationFrame(step);
    else canvas.remove();
  };
  draw();
  requestAnimationFrame(step);
}

// The full celebration: an optional coin spin, then a punch that holds a beat
// at its peak with a flash, and the burst.
function celebrate(el, { spin = false, rings = 1, pieces = 32 } = {}) {
  const hit = () => {
    if (!el.isConnected) return;
    el.animate([{ transform: 'none' }, { transform: 'scale(1.16)', offset: 0.22 }, { transform: 'scale(1.16)', offset: 0.36 }, { transform: 'scale(0.97)', offset: 0.7 }, { transform: 'none' }],
      { duration: 520, easing: 'cubic-bezier(.2,.8,.3,1)' });
    const flash = document.createElement('i');
    flash.className = 'ach-toast-flash';
    el.append(flash);
    flash.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' }).onfinish = () => flash.remove();
    burst(el, { rings, pieces });
  };
  if (!spin) return hit();
  // A coin spin: one full turn showing a gold back while it faces away, then the hit.
  el.animate([{ transform: 'perspective(30em) rotateY(0deg)' }, { transform: 'perspective(30em) rotateY(360deg)' }], { duration: 560 }).onfinish = hit;
  later(140, () => el.classList.add('ach-toast-back'));
  later(420, () => el.classList.remove('ach-toast-back'));
}

/**
 * Thrown off `el` in its colour, or off `from`, a part of it: shockwave rings,
 * a PETSCII shower flung up and falling, and glints around it. The pieces are
 * sized by what they are thrown from.
 */
export function burst(el, { rings = 1, pieces = 32, from = el } = {}) {
  const at = layer(el);
  if (!at) return;
  const r = from.getBoundingClientRect();
  const ink = getComputedStyle(el).getPropertyValue('--ach-ink');
  const x0 = r.left - at.box.left, y0 = r.top - at.box.top;
  for (let k = 0; k < rings; k++) {
    const ring = at.add(document.createElement('i'));
    ring.className += ' ach-toast-ring';
    Object.assign(ring.style, { left: `${x0}px`, top: `${y0}px`, width: `${r.width}px`, height: `${r.height}px`, borderColor: ink });
    ring.animate([{ transform: 'none', opacity: 0.9 }, { transform: 'scale(1.45, 2.2)', opacity: 0 }],
      { duration: 650, delay: k * 140, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'backwards' }).onfinish = () => ring.remove();
  }
  shower(el, at, r, x0, y0, pieces);
  for (let k = 0; k < 7; k++) {
    const g = at.add(document.createElement('i'));
    g.className += ' ach-toast-glint';
    g.style.setProperty('--glow', ink);
    const edge = Math.random() < 0.5;
    g.style.left = `${x0 + (edge ? (Math.random() < 0.5 ? -0.03 : 0.97) : Math.random()) * r.width}px`;
    g.style.top = `${y0 + (edge ? Math.random() : (Math.random() < 0.5 ? -0.15 : 0.9)) * r.height}px`;
    g.animate([{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1) rotate(45deg)', offset: 0.4 }, { opacity: 0, transform: 'scale(0.2) rotate(90deg)' }],
      { duration: 700, delay: 250 + k * 170, easing: 'ease-out', fill: 'backwards' }).onfinish = () => g.remove();
  }
}
