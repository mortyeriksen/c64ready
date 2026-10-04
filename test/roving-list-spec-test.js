// A list of rows as one Tab stop (src/ui/roving-list.js), the ARIA toolbar /
// grid keyboard model:
//   1. exactly one control in the list is in the Tab order, at first the first;
//   2. ↑ / ↓ move to the same control in the next or previous row (or that
//      row's last one); ← / → move within the row; Home / End go to the first
//      control of the first or last row; nothing moves past an edge;
//   3. the Tab stop follows focus, by key or by Tab / click (focusin);
//   4. a re-rendered list gets its one Tab stop back; disabled controls are
//      skipped;
//   5. modified keys (Ctrl, Alt, Meta, Shift) are left alone;
//   6. a row that is itself a button comes before its own buttons, and Enter or
//      Space on it clicks it.
import { installMiniDom, fire } from './_mini-dom.js';

const dom = installMiniDom();
const { document } = dom;
const { rovingList } = await import('../src/ui/roving-list.js');

let failures = 0;
const expect = (cond, msg) => { if (!cond) { failures++; console.log(`FAIL - ${msg}`); } };
const rowHtml = (n, buttons) => `<div class="row">${buttons.map((b) => `<button id="r${n}${b}">${b}</button>`).join('')}</div>`;
document.body.innerHTML = `<div class="list">${rowHtml(1, ['a', 'b', 'c'])}${rowHtml(2, ['a', 'b'])}${rowHtml(3, ['a', 'b', 'c'])}</div>`;
const list = document.querySelector('.list');
const roving = rovingList(list, '.row');
const $ = (id) => document.getElementById(id);
const stops = () => document.querySelectorAll('button').filter((b) => b.getAttribute('tabindex') === '0').map((b) => b.id);
const key = (id, k, extra = {}) => fire($(id), 'keydown', { key: k, ...extra });

expect(stops().join() === 'r1a', `one Tab stop, the first control (${stops()})`);
key('r1a', 'ArrowRight');
expect(document.activeElement === $('r1b') && stops().join() === 'r1b', '→ moves within the row and the Tab stop follows');
key('r1b', 'ArrowRight'); key('r1c', 'ArrowRight');
expect(document.activeElement === $('r1c'), '→ stops at the end of the row');
key('r1c', 'ArrowDown');
expect(document.activeElement === $('r2b'), '↓ from a third control lands on a shorter row\'s last one');
key('r2b', 'ArrowDown');
expect(document.activeElement === $('r3b'), '↓ keeps the column where the next row has it');
let ev = key('r3b', 'ArrowDown');
expect(document.activeElement === $('r3b') && ev.defaultPrevented, '↓ at the last row stays put, the key still claimed');
key('r3b', 'Home');
expect(document.activeElement === $('r1a'), 'Home goes to the first control of the first row');
key('r1a', 'End');
expect(document.activeElement === $('r3a'), 'End to the first control of the last row');
key('r3a', 'ArrowUp'); key('r2a', 'ArrowLeft');
expect(document.activeElement === $('r2a'), '↑ moves up a row; ← stops at the start of a row');
ev = key('r2a', 'ArrowDown', { ctrlKey: true });
expect(!ev.defaultPrevented && document.activeElement === $('r2a'), 'a modified key is left to the browser');
ev = key('r2a', 'Enter');
expect(!ev.defaultPrevented, 'other keys pass');

fire($('r3c'), 'focusin');
expect(stops().join() === 'r3c', 'focus from Tab or a click moves the Tab stop there');

// A re-render replaces every row: one Tab stop again, disabled controls skipped.
list.innerHTML = `${rowHtml(7, ['a', 'b'])}${rowHtml(8, ['a'])}`;
$('r7a').disabled = true;
roving.sync();
expect(stops().join() === 'r7b', `after a re-render the first enabled control is the Tab stop (${stops()})`);
key('r7b', 'ArrowDown');
expect(document.activeElement === $('r8a'), 'and the arrows work on the new rows');

// A row that is itself the control (role="button") joins the list ahead of its
// own buttons, and Enter or Space on it clicks it.
document.body.innerHTML = '<div class="files"><div class="file" role="button" tabindex="-1" id="f1">A<button id="f1x">x</button></div>'
  + '<div class="file" role="button" tabindex="-1" id="f2">B<button id="f2x">x</button></div></div>';
const files = rovingList(document.querySelector('.files'), '.file');
files.sync();
let clicked = 0;
$('f1').addEventListener('click', () => { clicked++; });
expect(document.querySelectorAll('[tabindex="0"]').map((n) => n.id).join() === 'f1', 'a button row is the list\'s first control');
key('f1', 'ArrowRight');
expect(document.activeElement === $('f1x'), '→ goes from the row to its own button');
key('f1x', 'ArrowDown');
expect(document.activeElement === $('f2x'), '↓ keeps the column: the next row\'s button');
fire($('f1'), 'focusin');
ev = key('f1', 'Enter');
expect(ev.defaultPrevented && clicked === 1, 'Enter on a button row clicks it');
key('f1', ' ');
expect(clicked === 2, 'and so does Space');

if (failures) { console.log(`\n${failures} roving list failure(s)`); process.exit(1); }
console.log('ok  - roving list: one Tab stop, arrows within and between rows, Home / End, re-render');
