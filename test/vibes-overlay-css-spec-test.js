// The Retro Vibes overlay's stylesheet (src/vibes/styles-vibes.css), where it
// costs frame time over the 3D view.
//
//   1. Nothing over the view blurs what is behind it. The view changes every
//      frame, so a backdrop-filter there is a blur redone every frame.
//   2. While the view covers the page (body.vibes-open), the page's own
//      animations hold still: nobody can see them, and the ones that animate
//      a background repaint every frame.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(fileURLToPath(new URL('../src/vibes/styles-vibes.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

assert.ok(!/backdrop-filter\s*:/.test(css), 'no rule over the view sets a backdrop-filter');
console.log('ok  - test 1: nothing over the view blurs its backdrop');

const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .find(([, selector, body]) => /body\.vibes-open/.test(selector) && /animation-play-state\s*:\s*paused/.test(body));
assert.ok(rule, 'a body.vibes-open rule pauses animations');
assert.ok(/:not\([^)]*\.model-viewer-overlay/.test(rule[1]), 'and leaves the view\'s own alone');
assert.ok(/::before/.test(rule[1]) && /::after/.test(rule[1]), 'pseudo-elements included, as the page\'s rolling scanlines are one');
console.log('ok  - test 2: the page under the view holds its animations');

console.log('\nok - vibes overlay css: 2 checks');
