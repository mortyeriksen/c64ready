import fs from 'fs';
import {
  parseSavedLayout, resolveLayout, isDefaultLayout, parseHiddenKeys, initPanelOrder,
  PANEL_ORDER_KEY, PANEL_HIDDEN_KEY,
} from '../src/panel-order.js';
import { handleEscape, escapeLayerCount } from '../src/escape-stack.js';
import { installMiniDom, fire } from './_mini-dom.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Mirrors the authored layout in index.html, so the fixture reads like the real
// thing. Only its shape matters to the assertions, not the particular keys.
const DEFAULT = [
  ['status', 'controls', 'ports'],
  ['media', 'drive8', 'drive9', 'cartridge', 'datasette'],
];

// ── parseSavedLayout: storage holds whatever a hand-edit or an older build left ──

expect(parseSavedLayout(null) === null, 'a missing entry parses to null, not a throw');
expect(parseSavedLayout('{ not json') === null, 'corrupt JSON parses to null');
expect(parseSavedLayout('{"a":1}') === null, 'a JSON object is rejected — a layout is an array');
expect(parseSavedLayout('[1,2]') === null, 'an array of non-arrays is rejected');
expect(
  parseSavedLayout('["status","controls"]') === null,
  'the older flat-array format is rejected rather than half-read as one column',
);
expect(parseSavedLayout('[["a",null],[]]') === null, 'one non-string member rejects the layout');
expect(same(parseSavedLayout('[[],[]]'), [[], []]), 'two empty columns are a valid layout');
expect(
  same(parseSavedLayout('[["drive8"],["status"]]'), [['drive8'], ['status']]),
  'a well-formed layout parses through unchanged',
);

// ── resolveLayout: reconcile what was saved against the cards that exist ──

expect(
  same(resolveLayout(DEFAULT, null), DEFAULT),
  'no saved layout leaves the authored arrangement untouched',
);

const swapped = [
  ['datasette', 'drive8'],
  ['status', 'controls', 'media', 'ports', 'drive9', 'cartridge'],
];
expect(
  same(resolveLayout(DEFAULT, swapped), swapped),
  'a saved layout naming every card is applied verbatim, columns and all',
);

// The whole point of the feature: one column may hold everything.
const allLeft = [['status', 'controls', 'media', 'ports', 'drive8', 'drive9', 'cartridge', 'datasette'], []];
expect(
  same(resolveLayout(DEFAULT, allLeft), allLeft),
  'every card in one column, the other left empty, survives a reload',
);
const allRight = [[], ['status', 'controls', 'media', 'ports', 'drive8', 'drive9', 'cartridge', 'datasette']];
expect(
  same(resolveLayout(DEFAULT, allRight), allRight),
  'the emptied column can be either one',
);

expect(
  same(
    resolveLayout(DEFAULT, [['gone', 'status', 'controls', 'ports'], ['media', 'drive8', 'drive9', 'cartridge', 'datasette']]),
    DEFAULT,
  ),
  'a saved key for a card that no longer exists is skipped',
);

expect(
  same(
    resolveLayout(DEFAULT, [['status', 'status', 'controls', 'ports'], ['status', 'media', 'drive8', 'drive9', 'cartridge', 'datasette']]),
    DEFAULT,
  ),
  'a key repeated within or across columns is honoured once, at its first mention',
);

// A panel added in a later release is unknown to every existing saved layout —
// the normal case for everyone the release after it lands, never seen in
// development. It goes to the bottom of the last column still in use: dull,
// predictable, and one drag from anywhere else. Threading it back to the column
// and index it was authored at would shuffle the user's own cards to make room.
const withNewCard = [
  ['status', 'controls', 'ports'],
  ['media', 'drive8', 'tuner', 'drive9', 'cartridge', 'datasette'],
];
expect(
  same(
    resolveLayout(withNewCard, DEFAULT),
    [['status', 'controls', 'ports'], ['media', 'drive8', 'drive9', 'cartridge', 'datasette', 'tuner']],
  ),
  'a card the saved layout never heard of lands at the bottom, not at its authored index',
);

expect(
  same(resolveLayout(DEFAULT, [[], []]), DEFAULT),
  'an empty saved layout restores every card where it was authored',
);

// "Last column still in use" is what keeps an emptied column empty. A card the
// user has never seen appearing on its own in a column they deliberately
// cleared would read as a fault, not as a new feature — and this rule avoids it
// without needing a special case for it.
expect(
  same(
    resolveLayout(withNewCard,
      [['status', 'controls', 'media', 'ports', 'drive8', 'drive9', 'cartridge', 'datasette'], []]),
    [['status', 'controls', 'media', 'ports', 'drive8', 'drive9', 'cartridge', 'datasette', 'tuner'], []],
  ),
  'a new card does not resurrect a column the user emptied',
);

expect(
  same(
    resolveLayout([['tuner', 'status'], ['drive8']], [[], ['drive8', 'status']]),
    [[], ['drive8', 'status', 'tuner']],
  ),
  'the emptied column can be the left one, and the newcomer still goes right',
);

// Two newcomers at once keep their authored order relative to each other.
expect(
  same(
    resolveLayout([['a', 'b'], ['c', 'd']], [['a', 'c'], []]),
    [['a', 'c', 'b', 'd'], []],
  ),
  'several new cards append in authored order, all to the column in use',
);

// The realistic upgrade: a user who has already rearranged — moved Datasette to
// the top of the left column and Controls across to the right — meets a build
// that adds a card. Every card they placed stays exactly where they put it.
expect(
  same(
    resolveLayout(withNewCard,
      [['datasette', 'status', 'ports'], ['media', 'drive8', 'controls', 'drive9', 'cartridge']]),
    [['datasette', 'status', 'ports'], ['media', 'drive8', 'controls', 'drive9', 'cartridge', 'tuner']],
  ),
  'an unknown card joins a rearranged layout without displacing anything the user set',
);

// ── isDefaultLayout: what decides whether anything is persisted at all ──

expect(
  isDefaultLayout(DEFAULT, JSON.parse(JSON.stringify(DEFAULT))),
  'an untouched panel reads as the default layout, so nothing is written',
);
expect(
  !isDefaultLayout(DEFAULT, swapped),
  'a rearranged panel reads as non-default',
);
expect(
  !isDefaultLayout(DEFAULT, [['controls', 'status', 'media', 'ports'], ['drive8', 'drive9', 'cartridge', 'datasette']]),
  'a reorder inside one column counts as non-default',
);
expect(
  !isDefaultLayout(DEFAULT, [DEFAULT[0].concat(DEFAULT[1]), []]),
  'the same cards collapsed into one column is not the default layout',
);

// ── Markup contract: a card without a key silently stops being arrangeable ──
//
// initPanelOrder() only sees `.panel-cols > .panel-col > .panel-card[data-panel]`,
// and only injects a handle where there is a `.panel-card-header`. A card added
// later outside a column, or without either, would quietly drop out of the
// layout with nothing to notice it.

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sidePanel = html.slice(html.indexOf('<div class="side-panel">'), html.indexOf('<!-- /.side-panel -->'));

const colMarkup = [...sidePanel.matchAll(/<div class="panel-col" data-col="(\d)">/g)];
expect(colMarkup.length === 2, 'the side panel is built from exactly two card columns');
expect(
  colMarkup.map(m => m[1]).join() === '0,1',
  'the columns are numbered 0 and 1, in order',
);

// Structural only — deliberately not the card count, the key list or the
// authored split. Those are design decisions, and pinning them would just make
// adding a card fail the suite for no defect. What follows is the set of things
// that would silently break a card instead.

// `panel-card` as a whole class, so `panel-card-header` doesn't match.
const CARD_RE = /<div class="panel-card(?: [^"]*)?"[^>]*>/g;
const cards = sidePanel.match(CARD_RE) || [];
expect(cards.length >= 2, 'the side panel has cards to arrange at all');

for (const card of cards) {
  expect(/data-panel="[^"]+"/.test(card), `every card carries a data-panel key: ${card.slice(0, 70)}`);
}

const keys = cards.map(c => c.match(/data-panel="([^"]+)"/)[1]);
expect(new Set(keys).size === keys.length,
  `every data-panel key is unique — got ${keys.join(', ')}`);

// A card outside a .panel-col is invisible to initPanelOrder: no handle, and it
// drops out of the saved layout entirely. Slicing to the column's own closing
// tag is what makes this catch a card parked between the two columns — slicing
// to the end of .panel-cols would count it as inside.
function elementSlice(html, from) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = from;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

const inColumns = colMarkup.reduce((n, m) =>
  n + (elementSlice(sidePanel, m.index).match(CARD_RE) || []).length, 0);
expect(
  inColumns === cards.length,
  `every card sits inside a .panel-col (${inColumns} of ${cards.length} do)`,
);

const headers = sidePanel.match(/<div class="panel-card-header/g) || [];
expect(
  headers.length === cards.length,
  `every card has a .panel-card-header for the drag handle to sit in (${headers.length} of ${cards.length})`,
);

// ── parseHiddenKeys: the drop-to-hide set, same tolerance as the layout ──────
// A hidden card keeps its place in the saved LAYOUT (it is only not drawn), so
// the two are stored separately and a bad hidden set must not cost the order.
expect(parseHiddenKeys(null) === null, 'no stored hidden set reads as null');
expect(parseHiddenKeys('nonsense') === null, 'a non-JSON hidden set reads as null');
expect(parseHiddenKeys('{"a":1}') === null, 'an object is not a hidden set');
expect(parseHiddenKeys('[1,2]') === null, 'numbers are not panel keys');
expect(parseHiddenKeys('["tape","drive9"]').join() === 'tape,drive9', 'a list of keys round-trips');
expect(parseHiddenKeys('[]').length === 0, 'an empty list means nothing is hidden');

// A key for a card that no longer exists is not this function's problem — it is
// intersected against the real cards at startup — but it must parse, or one
// stale key would throw away the whole set.
expect(parseHiddenKeys('["gone","tape"]').length === 2, 'unknown keys still parse');

// The hide target and the hidden-card rule have to exist in the stylesheet the
// drag relies on: the JS only toggles classes.
const displayCss = fs.readFileSync(new URL('../src/styles-display.css', import.meta.url), 'utf8');
expect(/\.panel-card\.is-panel-hidden\s*\{[^}]*display:\s*none/.test(displayCss),
  'a hidden card is not drawn');
expect(/body\.panels-reordering\s+\.panel-hide-target\s*\{[^}]*opacity:\s*1/.test(displayCss),
  'the hide target shows while a card is in flight');
expect(/@keyframes panel-hide-pulse/.test(displayCss), 'and pulses');
expect(/prefers-reduced-motion[\s\S]*?panel-hide-target\s*\{[^}]*animation:\s*none/.test(displayCss),
  'reduced motion stops the pulse');

// Over the Hide target the columns must stop offering a landing place — the
// opened slot and the empty-column target both go quiet, without losing their
// space (so nothing reflows if the card comes back).
expect(/body\.panels-hide-armed \.panel-card\.panel-drag-source\s*\{[^}]*border-color:\s*transparent/.test(displayCss),
  'the opened slot stops reading as a drop target while Hide is armed');
expect(/body\.panels-hide-armed \.panel-col\.is-empty\s*\{[^}]*border-color:\s*transparent/.test(displayCss),
  'and so does an empty column');

// Both corner affordances sit in the same place, so neither may be positioned
// by a breakpoint: one rule, safe-area inset, every device.
for (const cls of ['panel-hide-target', 'panel-restore-btn']) {
  const rule = displayCss.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`));
  expect(!!rule, `.${cls} is styled`);
  expect(/position:\s*fixed/.test(rule[0]) && /right:\s*max\(/.test(rule[0]) &&
         /bottom:\s*max\(/.test(rule[0]),
    `.${cls} is pinned to the lower-right corner with safe-area insets`);
}
// The + only exists while something is hidden — the class the JS toggles.
expect(/\.panel-restore-btn\s*\{[^}]*display:\s*none/.test(displayCss) &&
       /\.panel-restore-btn\.is-shown\s*\{[^}]*display:\s*grid/.test(displayCss),
  'the restore + is hidden until a card is');

// The picker's narrow width has to be declared AFTER .modal-card (width:100%,
// max-width:1066px) or it loses the cascade tie and the dialog spans the page.
const dialogCss = fs.readFileSync(new URL('../src/styles-dialogs.css', import.meta.url), 'utf8');
expect(dialogCss.indexOf('.panel-restore-card') > dialogCss.indexOf('.modal-card {'),
  'the hidden-panels picker overrides .modal-card by source order');
expect(/\.panel-restore-card\s*\{[^}]*max-width:\s*320px/.test(dialogCss),
  'and is narrow');

console.log('ok  - side panel card layout persistence, arranging and drop-to-hide');

// ── The DOM half: handles, dragging, hiding and bringing back ─────────────────
// A stand-in document (test/_mini-dom.js) with two columns of cards. The stub
// does no layout, so every card's rect is pinned once and the pointer positions
// below are chosen against those rects: cards stack 100px apart, columns are
// 200px wide side by side.
{
  const dom = installMiniDom();
  const { document, localStorage } = dom;
  const CARD = (key, title) =>
    `<div class="panel-card" data-panel="${key}"><div class="panel-card-header"><h2>${title}</h2></div><p>body</p></div>`;
  const page = () => {
    document.body.innerHTML =
      '<div class="side-panel"><div class="panel-cols">' +
      `<div class="panel-col" data-col="0">${CARD('status', '<span>Status</span><span class="fps">– fps</span>')}${CARD('controls', 'Controls')}${CARD('ports', 'Ports')}</div>` +
      `<div class="panel-col" data-col="1">${CARD('media', 'Media')}${CARD('drive8', 'Drive 8')}</div>` +
      '</div></div><button id="btn-panel-order-reset"></button>';
    const cols = document.querySelectorAll('.panel-col');
    cols[0]._rect = { left: 0, top: 0, width: 200, height: 600 };
    cols[1]._rect = { left: 200, top: 0, width: 200, height: 600 };
    for (const col of cols) {
      col.querySelectorAll('.panel-card').forEach((c, i) => { c._rect = { left: col._rect.left, top: i * 100, width: 200, height: 90 }; });
    }
    return cols;
  };
  const keysIn = col => [...col.querySelectorAll(':scope > .panel-card')].map(c => c.getAttribute('data-panel'));
  const handleOf = key => document.querySelector(`[data-panel="${key}"] .panel-drag-handle`);
  const panel = () => document.querySelector('.side-panel');
  const live = () => document.querySelector('.panel-order-live').textContent;
  const savedLayout = () => JSON.parse(localStorage.getItem(PANEL_ORDER_KEY)).map(c => c.join()).join('|');
  const down = (key, pointerId, clientX, clientY, button = 0) =>
    fire(handleOf(key), 'pointerdown', { button, pointerId, clientX, clientY });
  const move = (pointerId, clientX, clientY) => fire(panel(), 'pointermove', { pointerId, clientX, clientY });
  const up = (pointerId) => fire(panel(), 'pointerup', { pointerId });

  // Nothing to arrange: a page without two columns, or no panel at all, is left alone.
  document.body.innerHTML = '<div class="side-panel"><div class="panel-cols"><div class="panel-col"></div></div></div>';
  initPanelOrder();
  expect(document.querySelectorAll('.panel-drag-handle').length === 0, 'one column: no handles are injected');
  document.body.innerHTML = '';
  initPanelOrder();

  let cols = page();
  initPanelOrder();
  expect(document.querySelectorAll('.panel-drag-handle').length === 5, 'every card gets a grip handle');
  expect(handleOf('status').getAttribute('aria-label') === 'Reorder Status', 'the handle is named after the card (first span only)');
  expect(handleOf('controls').getAttribute('aria-label') === 'Reorder Controls', 'a bare h2 names the card too');
  let headerClicks = 0;
  document.querySelector('.panel-card-header').addEventListener('click', () => headerClicks++);
  const clickEv = fire(handleOf('status'), 'click');
  expect(headerClicks === 0 && clickEv.defaultPrevented, 'a click on the handle stops at the handle');

  // ── Pointer drag: Status from the top of column 1 into column 2 ──
  down('status', 7, 50, 20);
  move(7, 52, 21);
  expect(!document.body.classList.contains('panels-reordering'), 'a couple of pixels is a click, not a drag');
  move(99, 300, 300);                         // another pointer: not this drag
  move(7, 250, 150);
  expect(document.body.classList.contains('panels-reordering') && document.querySelector('.panel-drag-ghost'),
    'past the threshold a ghost flies and the page marks the drag');
  expect(keysIn(cols[1]).join() === 'media,drive8,status', `the placeholder moves to the pointer's slot (${keysIn(cols[1])})`);
  move(7, 250, 150);                          // same slot: nothing to do
  move(7, 250, 10);
  expect(keysIn(cols[1]).join() === 'status,media,drive8', `and follows it upward (${keysIn(cols[1])})`);
  up(7);
  expect(!document.querySelector('.panel-drag-ghost') && !document.body.classList.contains('panels-reordering'),
    'the drop clears the ghost and the marker');
  expect(savedLayout() === 'controls,ports|status,media,drive8', `the new layout is saved (${savedLayout()})`);
  expect(live() === 'Status moved to position 1 of 3 in column 2', `the move is announced (${live()})`);

  // ── A cancelled drag puts the card back ──
  down('ports', 8, 50, 220);
  move(8, 250, 300);
  expect(keysIn(cols[1]).includes('ports'), 'mid-drag the card sits in the other column');
  fire(panel(), 'pointercancel', { pointerId: 8 });
  expect(keysIn(cols[0]).join() === 'controls,ports' && !keysIn(cols[1]).includes('ports'),
    'a cancelled drag restores the pick-up position');

  // ── Only the primary button drags ──
  down('ports', 9, 50, 220, 2);
  move(9, 250, 300);
  expect(keysIn(cols[0]).join() === 'controls,ports', 'a secondary button is ignored');

  // ── Losing the capture settles the card where it stands ──
  down('ports', 10, 50, 220);
  move(10, 250, 300);
  fire(panel(), 'lostpointercapture', { pointerId: 10 });
  expect(keysIn(cols[1]).at(-1) === 'ports', 'losing the capture commits the current position');
  up(10); fire(panel(), 'pointercancel', { pointerId: 10 }); fire(panel(), 'lostpointercapture', { pointerId: 10 });

  // ── Keyboard arranging ──
  // Column 1 is now [controls]; column 2 is [status, media, drive8, ports].
  const kb = (key, k, extra = {}) => fire(handleOf(key), 'keydown', { key: k, ...extra });
  kb('media', 'ArrowUp');
  expect(keysIn(cols[1]).join() === 'media,status,drive8,ports', 'ArrowUp moves the card up one');
  expect(live() === 'Media moved to position 1 of 4 in column 2', `and says so (${live()})`);
  let ev = kb('media', 'ArrowUp');
  expect(keysIn(cols[1])[0] === 'media' && ev.defaultPrevented, 'at the top, ArrowUp stays put but the key is still claimed');
  kb('media', 'End');
  expect(keysIn(cols[1]).at(-1) === 'media', 'End goes to the bottom');
  kb('media', 'Home');
  expect(keysIn(cols[1])[0] === 'media', 'Home to the top');
  kb('media', 'ArrowDown');
  expect(keysIn(cols[1])[1] === 'media', 'ArrowDown moves it down one');
  kb('media', 'ArrowLeft');
  expect(keysIn(cols[0]).join() === 'controls,media', `ArrowLeft hands it to the other column at the same height (${keysIn(cols[0])})`);
  ev = kb('media', 'ArrowLeft');
  expect(keysIn(cols[0]).join() === 'controls,media' && !ev.defaultPrevented, 'there is no column further left');
  kb('media', 'ArrowRight');
  expect(keysIn(cols[1])[1] === 'media', `ArrowRight hands it back (${keysIn(cols[1])})`);
  ev = kb('media', 'ArrowDown', { ctrlKey: true });
  expect(!ev.defaultPrevented && keysIn(cols[1])[1] === 'media', 'modified keys are left to the browser');
  ev = kb('media', 'Enter');
  expect(!ev.defaultPrevented, 'other keys pass');
  expect(savedLayout() === 'controls|status,media,drive8,ports', `each keyboard move is saved (${savedLayout()})`);
  expect(document.activeElement === handleOf('media'), 'focus stays on the handle');

  // ── Drop-to-hide, and the + that brings a card back ──
  const hideTarget = document.querySelector('.panel-hide-target');
  const restoreBtn = document.querySelector('.panel-restore-btn');
  const dialog = document.querySelector('.panel-restore-modal');
  expect(!restoreBtn.classList.contains('is-shown') && dialog.hidden, 'nothing hidden: no + and no picker');
  fire(restoreBtn, 'click');
  expect(dialog.hidden, 'the + does nothing while nothing is hidden');
  down('ports', 11, 250, 320);
  move(11, 930, 930);
  expect(!hideTarget.classList.contains('is-over'), 'a target with no box cannot be hit');
  fire(panel(), 'pointercancel', { pointerId: 11 });
  hideTarget._rect = { left: 900, top: 900, width: 60, height: 60 };
  down('ports', 12, 250, 320);
  move(12, 250, 10);
  expect(keysIn(cols[1]).indexOf('ports') === 1, `the card follows the pointer before the target is reached (${keysIn(cols[1])})`);
  move(12, 930, 930);
  expect(hideTarget.classList.contains('is-over') && document.body.classList.contains('panels-hide-armed'),
    'over the target the oval lights and the columns stop offering slots');
  expect(document.querySelector('.panel-drag-ghost').classList.contains('is-over-hide'), 'the ghost shows it too');
  move(12, 935, 935);                          // still over: nothing changes
  up(12);
  const ports = document.querySelector('[data-panel="ports"]');
  expect(ports.classList.contains('is-panel-hidden'), 'dropping on the target hides the card');
  expect(keysIn(cols[1]).at(-1) === 'ports', `hidden where it was picked up, not where it flew (${keysIn(cols[1])})`);
  expect(JSON.parse(localStorage.getItem(PANEL_HIDDEN_KEY)).join() === 'ports', 'the hidden set is saved on its own');
  expect(savedLayout() === 'controls|status,media,drive8,ports', 'and the order is unchanged');
  expect(restoreBtn.classList.contains('is-shown') && /Ports hidden/.test(live()), 'the + appears and the hide is announced');

  // A hidden card is not a position: keyboard moves count only what is shown.
  kb('status', 'End');
  expect(keysIn(cols[1]).join() === 'media,drive8,ports,status' && live() === 'Status moved to position 3 of 3 in column 2',
    `End counts shown cards only (${keysIn(cols[1])}; ${live()})`);
  // The picker lists what is hidden and puts it back at the bottom of its column.
  fire(restoreBtn, 'click');
  expect(!dialog.hidden && dialog.querySelectorAll('.panel-restore-item').length === 1
    && dialog.querySelector('.lib-name').textContent === 'Ports', 'the picker opens with the hidden card');
  expect(document.activeElement === dialog.querySelector('.panel-restore-item') && escapeLayerCount() === 1,
    `focus lands in the list and Escape is claimed (${escapeLayerCount()} layers)`);
  fire(dialog, 'click', { target: dialog.querySelector('.panel-restore-hint') });
  expect(!dialog.hidden, 'a click inside the card leaves it open');
  fire(dialog.querySelector('[data-close]'), 'click');
  expect(dialog.hidden && document.activeElement === restoreBtn && escapeLayerCount() === 0, 'the ✕ closes it and focus returns to the +');
  fire(restoreBtn, 'click');
  fire(dialog, 'click');
  expect(dialog.hidden, 'a click on the backdrop closes it');
  fire(restoreBtn, 'click');
  fire(dialog.querySelector('.panel-restore-item'), 'click');
  expect(!ports.classList.contains('is-panel-hidden') && keysIn(cols[1]).at(-1) === 'ports',
    `picking it puts the card back at the bottom of its column (${keysIn(cols[1])})`);
  expect(dialog.hidden && !restoreBtn.classList.contains('is-shown') && localStorage.getItem(PANEL_HIDDEN_KEY) === null,
    'nothing hidden any more: picker closed, + gone, set cleared');
  expect(live() === 'Ports shown again', `and it is announced (${live()})`);

  // Two hidden: picking one keeps the picker open with the other; Escape closes it.
  down('media', 13, 250, 20); move(13, 930, 930); up(13);
  down('drive8', 14, 250, 120); move(14, 930, 930); up(14);
  expect(JSON.parse(localStorage.getItem(PANEL_HIDDEN_KEY)).sort().join() === 'drive8,media', 'two cards hidden');
  fire(restoreBtn, 'click');
  const names = [...dialog.querySelectorAll('.lib-name')].map(n => n.textContent);
  expect(names.join('|') === 'Drive 8|Media', `the picker lists them alphabetically (${names.join('|')})`);
  fire(dialog.querySelectorAll('.panel-restore-item')[1], 'click');
  expect(!dialog.hidden && dialog.querySelectorAll('.panel-restore-item').length === 1, 'with one still hidden the picker stays open');
  expect(handleEscape() === true && dialog.hidden && escapeLayerCount() === 0, 'Escape closes the picker through the shared stack');

  // ── RESET PANELS ──
  fire(document.getElementById('btn-panel-order-reset'), 'click');
  expect(keysIn(cols[0]).join() === 'status,controls,ports' && keysIn(cols[1]).join() === 'media,drive8',
    `RESET PANELS restores the authored order (${keysIn(cols[0])} | ${keysIn(cols[1])})`);
  expect(!document.querySelector('.is-panel-hidden') && localStorage.getItem(PANEL_ORDER_KEY) === null
    && localStorage.getItem(PANEL_HIDDEN_KEY) === null && !restoreBtn.classList.contains('is-shown'),
    'and clears both stores and the +');
  expect(/reset/i.test(live()), 'and says so');

  // ── A saved layout and hidden set are applied at start-up ──
  localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify([['ports'], ['drive8', 'status', 'media', 'controls']]));
  localStorage.setItem(PANEL_HIDDEN_KEY, JSON.stringify(['controls', 'gone']));
  cols = page();
  initPanelOrder();
  expect(keysIn(cols[0]).join() === 'ports' && keysIn(cols[1]).join() === 'drive8,status,media,controls',
    `the saved order is applied (${keysIn(cols[0])} | ${keysIn(cols[1])})`);
  expect(document.querySelector('[data-panel="controls"]').classList.contains('is-panel-hidden')
    && document.querySelector('.panel-restore-btn').classList.contains('is-shown'),
    'the saved hidden set too, with unknown keys dropped');
  kb('ports', 'ArrowRight');
  expect(keysIn(cols[0]).length === 0 && cols[0].classList.contains('is-empty'), 'a column with nothing shown reads as empty');
  down('ports', 15, 250, 20);
  move(15, 50, 300);
  expect(keysIn(cols[0]).join() === 'ports', 'a card can be dragged into an empty column');
  up(15);
  expect(savedLayout() === 'ports|drive8,status,media,controls', `and that is saved (${savedLayout()})`);

  // ── Narrow layout: the columns melt into one flow ──
  cols = page();
  for (const c of cols) c._display = 'contents';
  localStorage.clear();
  initPanelOrder();
  down('status', 16, 50, 20);
  move(16, 60, 150);
  expect(keysIn(cols[0]).join() === 'controls,status,ports', `in one flow the slot is picked across both columns (${keysIn(cols[0])})`);
  move(16, 210, 150);
  expect(keysIn(cols[1]).join() === 'media,drive8,status', `and a slot past the first column lands in the second (${keysIn(cols[1])})`);
  up(16);
  expect(savedLayout() === 'controls,ports|media,drive8,status', `the narrow-layout drop is saved (${savedLayout()})`);

  // A drag begun from a focused handle hands the focus back afterwards.
  handleOf('media').focus();
  down('media', 17, 250, 20); move(17, 250, 180); up(17);
  expect(document.activeElement === handleOf('media'), 'a drag from a focused handle returns the focus');

  console.log('ok  - side panel handles, dragging, hiding and restoring behave (stand-in DOM)');
}
