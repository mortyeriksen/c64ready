// Colour themes: the c64ready-theme/1 format, the built-in themes, and the
// stored theme the page applies before first paint.
//
// Rules checked:
//   1. A theme is accepted only in the documented shape: the format id, a name,
//      one or both modes, known tokens, plain colours. Each rejection says why.
//   2. Nothing but a colour reaches the page: no url(), no expression, no
//      declaration break-out.
//   3. A theme with one mode pins the appearance to it.
//   4. The generated rules outrank the stylesheet's (one :root more).
//   5. Stored themes are re-validated; broken entries are dropped.
//   6. Export is complete: every token in every mode the theme has.
//   7. THEME_TOKENS is exactly the token list of styles-theme.css.
//   8. The built-in themes (GEOS, Breadbin, Phosphor, Out Run,
//      Commando) are valid, have both modes, and
//      their text colours reach 4.5:1 on the panels they sit on.
//   9. The inline pre-paint script puts the stored theme in place and pins its mode.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import {
  THEME_FORMAT, THEME_TOKENS, THEME_CSS_KEY, THEME_MODES_KEY, MAX_THEME_BYTES,
  parseTheme, validateTheme, themeModes, themeCss, parseStoredThemes, exportTheme, isThemeColour,
} from '../src/ui/themes.js';
import { GEOS_THEME } from '../src/ui/themes/geos.js';
import { BREADBIN_THEME } from '../src/ui/themes/breadbin.js';
import { PHOSPHOR_THEME } from '../src/ui/themes/phosphor.js';
import { OUTRUN_THEME } from '../src/ui/themes/outrun.js';
import { COMMANDO_THEME } from '../src/ui/themes/commando.js';
import { resolveMode } from '../src/ui/appearance.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = (modes, extra = {}) => JSON.stringify({ format: THEME_FORMAT, name: 'Test', modes, ...extra });
const rejects = (text, why, msg) => {
  const r = parseTheme(text);
  expect(r.error && r.error.includes(why), `${msg} (got ${JSON.stringify(r)})`);
};

// 1. The shape.
expect(parseTheme(T({ dark: { text: '#fff' } })).theme, 'a minimal theme: format, name, one mode, one token');
rejects('{nope', 'not valid JSON', 'broken JSON is refused');
rejects('[]', 'JSON object', 'an array is not a theme');
rejects(JSON.stringify({ name: 'X', modes: { dark: {} } }), THEME_FORMAT, 'the format id is required');
rejects(JSON.stringify({ format: THEME_FORMAT, modes: { dark: {} } }), '"name"', 'a name is required');
rejects(T({ dark: {} }, { name: 'x'.repeat(41) }), 'too long', 'a name has a length limit');
rejects(T({ dark: {} }, { name: 'classic' }), 'built-in', "Classic's name is taken");
rejects(T({}), 'at least one mode', 'a theme needs a mode');
rejects(T({ dusk: {} }), 'Unknown mode', 'only dark and light are modes');
rejects(T({ dark: { 'not-a-token': '#fff' } }), 'Unknown colour "not-a-token"', 'unknown tokens are refused, by name');
rejects('x'.repeat(MAX_THEME_BYTES + 1), 'too large', 'a size limit applies');

// 2. Only colours get through.
for (const ok of ['#fff', '#ffff', '#a1b2c3', '#a1b2c3d4', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgba(1, 2, 3, 50%)', 'rgb(10%, 20%, 30%)']) {
  expect(isThemeColour(ok), `"${ok}" is a colour`);
}
for (const bad of ['red', 'url(http://x/y.png)', '#fff; } body { display: none', 'var(--text)', 'expression(1)',
  'rgb(1,2,3) url(x)', 'linear-gradient(#fff, #000)', '#ggg', '', 7, null]) {
  expect(!isThemeColour(bad), `${JSON.stringify(bad)} is refused`);
  if (typeof bad === 'string') rejects(T({ dark: { text: bad } }), 'not a colour', `"${bad}" never reaches the page`);
}

// 3. Modes.
const darkOnly = parseTheme(T({ dark: { text: '#fff' } })).theme;
const both = parseTheme(T({ dark: { text: '#fff' }, light: { text: '#000' } })).theme;
expect(themeModes(darkOnly) === 'dark' && themeModes(both) === 'both' && themeModes(null) === 'both', 'a one-mode theme reports its mode');
expect(resolveMode('light', false, 'dark') === 'dark' && resolveMode('system', false, 'dark') === 'dark',
  'a dark-only theme pins dark whatever the setting');
expect(resolveMode('dark', true, 'light') === 'light', 'a light-only theme pins light');
expect(resolveMode('light', true, 'both') === 'light', 'a two-mode theme leaves the setting in charge');

// 4. The rules.
const css = themeCss(both);
expect(css.includes(':root:root[data-mode="dark"], :root:root .c64-monitor.mode-dark { --text: #fff; }') && css.includes(':root:root[data-mode="light"] { --text: #000; }'),
  `each mode's colours under its own selector, dark also for the monitor (${css})`);
expect(themeCss(null) === '', 'Classic injects nothing');

// 5. Stored themes.
const stored = JSON.stringify([
  { id: 'user:good', theme: { name: 'Good', modes: { light: { text: '#000' } } } },
  { id: 'user:bad', theme: { name: 'Bad', modes: { light: { text: 'url(x)' } } } },
  { id: 'geos', theme: { name: 'Fake', modes: { light: {} } } },
  'junk',
]);
const kept = parseStoredThemes(stored);
expect(kept.length === 1 && kept[0].id === 'user:good', 'stored themes are re-validated; only good imported ones survive');
expect(parseStoredThemes('{').length === 0 && parseStoredThemes(null).length === 0, 'broken storage is nothing');
const renamed = parseStoredThemes(JSON.stringify([{ id: 'user:old', theme: { name: 'Old', modes: { dark: { text: '#fff', 'gone-token': '#000' } } } }]));
expect(renamed.length === 1 && renamed[0].theme.modes.dark.text === '#fff' && !('gone-token' in renamed[0].theme.modes.dark),
  'a stored theme with a colour this build no longer has keeps the rest, rather than being dropped');
rejects(T({ dark: { 'gone-token': '#000' } }), 'Unknown colour', 'an import is still strict about unknown colours');

// 6. Export.
const classic = { dark: {}, light: {} };
for (const t of THEME_TOKENS) { classic.dark[t] = '#111111'; classic.light[t] = '#eeeeee'; }
const exported = exportTheme({ name: 'Test', theme: darkOnly }, classic);
expect(exported.format === THEME_FORMAT && Object.keys(exported.modes).join() === 'dark', 'export keeps the modes the theme has');
expect(Object.keys(exported.modes.dark).length === THEME_TOKENS.length && exported.modes.dark.text === '#fff' && exported.modes.dark.border === '#111111',
  "export fills every token, the theme's own over Classic's");
expect(parseTheme(JSON.stringify(exported)).theme, 'an exported theme imports again');
const classicExport = exportTheme({ name: 'Classic', theme: null }, classic);
expect(classicExport.modes.dark && classicExport.modes.light, 'Classic exports both modes, as the template for new themes');

// 7. The token list is the stylesheet's.
const themeSheet = fs.readFileSync(path.join(root, 'src', 'styles', 'styles-theme.css'), 'utf8');
const darkBlock = themeSheet.slice(themeSheet.indexOf(':root,\n.mode-dark {'), themeSheet.indexOf(':root[data-mode="light"]'));
const sheetTokens = [...darkBlock.matchAll(/\n {2}--([a-z0-9-]+):/g)].map((m) => m[1]);
expect(sheetTokens.join() === THEME_TOKENS.join(), `THEME_TOKENS matches styles-theme.css (sheet has ${sheetTokens.length}, list ${THEME_TOKENS.length})`);

// 8. The built-in themes.
const lum = (h) => {
  const c = h.slice(1).match(/../g).map((x) => { const v = parseInt(x, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const [label, source] of [['GEOS', GEOS_THEME], ['Breadbin', BREADBIN_THEME], ['Phosphor', PHOSPHOR_THEME], ['Out Run', OUTRUN_THEME], ['Commando', COMMANDO_THEME]]) {
  const v = validateTheme(source);
  expect(v.theme && themeModes(v.theme) === 'both', `the built-in ${label} theme is valid with both modes (${v.error})`);
  for (const [mode, m] of Object.entries(v.theme.modes)) {
    for (const fg of ['text', 'dim', 'text-dim', 'accent', 'green', 'amber', 'red', 'info']) {
      if (!m[fg] || !m['panel-bg']) continue;
      const r = contrast(m[fg], m['panel-bg']);
      expect(r >= 4.5, `${label} ${mode}: ${fg} on panel-bg is ${r.toFixed(2)}:1, under 4.5`);
    }
  }
}

// 9. The pre-paint script.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes(THEME_CSS_KEY));
expect(script, `index.html's pre-paint script reads ${THEME_CSS_KEY}`);
expect(script.includes(`'${THEME_MODES_KEY}'`), `and ${THEME_MODES_KEY}`);
for (const [storedCss, pinned, osDark, appearance, wantMode] of [
  [css, null, true, null, 'dark'], [themeCss(darkOnly), 'dark', false, 'light', 'dark'], [null, null, false, null, 'light'],
]) {
  const attrs = {}; const appended = [];
  const store = { 'c64emu.appearance': appearance, [THEME_CSS_KEY]: storedCss, [THEME_MODES_KEY]: pinned };
  const sandbox = {
    localStorage: { getItem: (k) => store[k] ?? null },
    window: { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: dark)' && osDark }) },
    document: {
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, style: {} },
      createElement: () => ({}),
      head: { appendChild: (el) => appended.push(el) },
    },
  };
  vm.runInNewContext(script, sandbox);
  expect(attrs['data-mode'] === wantMode, `pre-paint: theme ${pinned || 'both'}, appearance ${appearance}, OS ${osDark ? 'dark' : 'light'} → ${wantMode} (got ${attrs['data-mode']})`);
  expect(storedCss ? appended.length === 1 && appended[0].id === 'c64-theme' && appended[0].textContent === storedCss : appended.length === 0,
    'pre-paint: the stored theme is put in place, and nothing when none is stored');
  expect(!pinned || attrs['data-theme-modes'] === pinned, 'pre-paint: a one-mode theme is marked as such');
}

console.log(`ok - themes: format, colours only, modes, rules, storage, export, ${THEME_TOKENS.length} tokens, built-in themes, pre-paint`);
