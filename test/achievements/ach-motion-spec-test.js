// Spec test for the motion of the achievement toasts and the trophy HUD
// (src/styles/styles-achievements.css): the effects that play over the running
// emulator animate only what the compositor moves without a repaint. A
// keyframe that animates a paint property, such as a box-shadow or a
// background-position, has the page style and paint on the main thread every
// display frame while it plays. So a glow is a painted shadow whose opacity
// animates, and a moving light is an element moved inside one that clips it.

import fs from 'node:fs';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// The properties a compositor animates: the transform, its three parts, and opacity.
const COMPOSITED = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate']);
// The effects over the emulator: a notice's glow, the points chip's pop, the gold
// card's foil, the HUD's sweep and a filled slot's flash.
const EFFECTS = ['ach-toast-glow', 'ach-toast-pop', 'ach-toast-foil', 'ach-hud-sweep', 'ach-hud-flash'];

const css = fs.readFileSync(new URL('../../src/styles/styles-achievements.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every @keyframes rule in the sheet: name → the properties its keyframes set. */
function keyframes(text) {
  const rules = new Map();
  const head = /@keyframes\s+([\w-]+)\s*\{/g;
  for (let m; (m = head.exec(text));) {
    let depth = 1, i = head.lastIndex;
    while (i < text.length && depth) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
    const props = new Set();
    for (const [, block] of text.slice(head.lastIndex, i - 1).matchAll(/\{([^{}]*)\}/g)) {
      for (const decl of block.split(';')) {
        const name = decl.slice(0, decl.indexOf(':')).trim().toLowerCase();
        if (decl.includes(':') && name) props.add(name);
      }
    }
    rules.set(m[1], props);
  }
  return rules;
}

const rules = keyframes(css);
for (const effect of EFFECTS) {
  expect(rules.has(effect), `@keyframes ${effect} is in styles-achievements.css`);
  // The effect's own keyframes, and any named after it for a part of it (ach-toast-pop-glow).
  for (const [name, props] of rules) {
    if (name !== effect && !name.startsWith(`${effect}-`)) continue;
    expect(props.size > 0, `@keyframes ${name} animates something`);
    for (const p of props) expect(COMPOSITED.has(p), `@keyframes ${name} animates ${p}: only transform, opacity, translate, scale and rotate run on the compositor`);
  }
  ok(`${effect} animates only what the compositor moves`);
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - achievement motion: ${testNo} checks`);
