// Appearance: dark, light, or follow the system (the default).
//
// Rules checked:
//   1. Only 'dark' and 'light' are explicit choices; anything else in storage
//      (nothing, 'system', junk from an older build) means follow the system.
//   2. 'system' resolves to the OS colour scheme; an explicit choice ignores it.
//   3. The header button cycles from system to the mode the OS is not showing,
//      then the OS's own, then back to system: the first two clicks always
//      change what is on screen.
//   4. The inline script in index.html, which runs before first paint, picks
//      the same mode as resolveMode() for every stored value and OS setting.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { APPEARANCE_KEY, parseAppearance, resolveMode, nextAppearance } from '../src/ui/appearance.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Parsing what storage holds.
expect(parseAppearance(null) === 'system', 'no stored choice means follow the system (the default)');
expect(parseAppearance('dark') === 'dark', "'dark' is an explicit choice");
expect(parseAppearance('light') === 'light', "'light' is an explicit choice");
expect(parseAppearance('system') === 'system', "'system' is the default");
expect(parseAppearance('Dark') === 'system', 'stored values are exact; anything else is the default');
expect(parseAppearance('{"x":1}') === 'system', 'junk from storage is the default');

// 2. Resolving to a mode.
expect(resolveMode('system', true) === 'dark', 'system follows a dark OS');
expect(resolveMode('system', false) === 'light', 'system follows a light OS');
expect(resolveMode('dark', false) === 'dark', 'an explicit dark ignores a light OS');
expect(resolveMode('light', true) === 'light', 'an explicit light ignores a dark OS');
expect(resolveMode('light', false, 'dark') === 'dark', 'a theme with only dark colours pins dark');

// 3. The header button's cycle.
// From the default, the first click shows the mode the OS is not showing, the
// second the OS's own, the third goes back to following the system.
expect(nextAppearance('system', true) === 'light' && nextAppearance('light', true) === 'dark' && nextAppearance('dark', true) === 'system',
  'dark OS: system → light → dark → system');
expect(nextAppearance('system', false) === 'dark' && nextAppearance('dark', false) === 'light' && nextAppearance('light', false) === 'system',
  'light OS: system → dark → light → system');
for (const osDark of [true, false]) {
  const first = nextAppearance('system', osDark), second = nextAppearance(first, osDark);
  expect(resolveMode(first, osDark) !== resolveMode('system', osDark), `the first click always changes the mode (OS ${osDark ? 'dark' : 'light'})`);
  expect(resolveMode(second, osDark) !== resolveMode(first, osDark), `and so does the second (OS ${osDark ? 'dark' : 'light'})`);
}
expect(nextAppearance('junk', true) === 'light', 'an unreadable setting is system, so the next one is the other mode');

// 4. The inline pre-paint script agrees with the module.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes(APPEARANCE_KEY));
expect(script, `index.html has an inline script reading ${APPEARANCE_KEY}`);
expect(html.indexOf(script) < html.indexOf('/src/styles/styles.css'), 'the pre-paint script runs before the stylesheet loads');

for (const stored of [null, 'dark', 'light', 'system', 'junk']) {
  for (const osDark of [true, false]) {
    const attrs = {};
    const sandbox = {
      localStorage: { getItem: (k) => (k === APPEARANCE_KEY ? stored : null) },
      window: { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: dark)' && osDark }) },
      document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, style: {} }, createElement: () => ({}), head: { appendChild() {} } },
    };
    sandbox.document.documentElement.style = sandbox.styleStore = {};
    vm.runInNewContext(script, sandbox);
    const want = resolveMode(parseAppearance(stored), osDark);
    expect(attrs['data-mode'] === want, `pre-paint script: stored ${stored}, OS ${osDark ? 'dark' : 'light'} → ${want} (got ${attrs['data-mode']})`);
    expect(sandbox.styleStore.colorScheme === want, `pre-paint script sets color-scheme to ${want}`);
  }
}

console.log('ok - appearance: parse, resolve, cycle, and the pre-paint script agree');
