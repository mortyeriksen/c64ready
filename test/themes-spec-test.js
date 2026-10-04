// Colour themes: the c64ready-theme/2 format, the built-in themes, and the
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
  parseTheme, validateTheme, themeModes, themeCss, parseStoredThemes, exportTheme, isThemeColour, withButtonColours,
  PATTERN_NAMES, CLASSIC_LOOK, patternLayers, colourAlpha, MAX_INK_ALPHA,
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
expect(css.includes(':root:root[data-mode="dark"], :root:root .c64-monitor.mode-dark { --text: #fff;') && css.includes(':root:root[data-mode="light"] { --text: #000;'),
  `each mode's colours under its own selector, dark also for the monitor (${css})`);
// A theme that does not set button colours gets its own general ones on its
// buttons, never Classic's; one that sets them keeps them.
expect(css.includes('--button-text: #fff;') && css.includes('--button-text: #000;'),
  `a button colour the theme leaves out is its own general colour (${css})`);
const parted = themeCss(parseTheme(T({ light: { text: '#000', 'button-text': '#fff', 'control-bg': '#eee', 'button-bg': '#c00' } })).theme);
expect(parted.includes('--button-text: #fff;') && parted.includes('--button-bg: #c00;') && parted.includes('--control-bg: #eee;'),
  `a theme can part buttons from fields (${parted})`);
const primary = themeCss(parseTheme(T({ light: { 'button-bg': '#c00', border: '#111111' } })).theme);
expect(primary.includes('--primary-bg: #c00;') && primary.includes('--primary-border: #111111;'),
  `a primary button colour the theme leaves out is its button colour, the border its border (${primary})`);
expect(!themeCss(parseTheme(T({ light: { border: '#000' } })).theme).includes('--button-'),
  'a button colour whose general colour the theme leaves out stays Classic\'s');
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
const derived = THEME_TOKENS.filter((t) => (t.startsWith('button-') && t !== 'button-ink') || t.startsWith('primary-') || t === 'pattern-ink');
expect(Object.keys(exported.modes.dark).length === THEME_TOKENS.length - derived.length && exported.modes.dark.text === '#fff' && exported.modes.dark.border === '#111111',
  "export fills every token but the derived button ones and the pattern ink, the theme's own over Classic's");
expect(derived.every((t) => !(t in exported.modes.dark)),
  'export leaves out the button and primary colours the theme leaves out, so they keep following their source');
const ownButtons = exportTheme({ name: 'Own', theme: parseTheme(T({ dark: { 'button-bg': '#c00' } })).theme }, classic);
expect(ownButtons.modes.dark['button-bg'] === '#c00' && !('button-text' in ownButtons.modes.dark), 'export keeps a button colour the theme sets itself');
expect(parseTheme(JSON.stringify(exported)).theme, 'an exported theme imports again');
const reimported = parseTheme(JSON.stringify(exported)).theme;
expect(themeCss(reimported) === themeCss(parseTheme(JSON.stringify(exportTheme({ name: 'Test', theme: reimported }, classic))).theme),
  'export and import again gives the same colours');
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
const mixIn = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
// Classic's colours per mode, the fallback for any colour a theme leaves out.
const sheetMode = (block) => Object.fromEntries([...block.matchAll(/\n {2}--([a-z0-9-]+):\s*(#[0-9a-f]{6}|rgba\([^)]*\))/g)].map((m) => [m[1], m[2]]));
const sheetModes = { dark: sheetMode(darkBlock), light: sheetMode(themeSheet.slice(themeSheet.indexOf(':root[data-mode="light"]'))) };
// On hover a button's label turns to the accent over the accent mixed into its
// face (styles-controls.css), or over accent2 for the LOAD-type buttons
// (styles-decks.css); both stay legible, in Classic and in every built-in.
const hoverLegible = (label, mode, own) => {
  const s = { ...sheetModes[mode], ...withButtonColours(own) };
  const face = s['button-bg'], acc = s['button-accent'];
  for (const [name, bg] of [['accent hover', mixIn(face, acc, 0.22)], ['accent2 hover', mixIn(face, s['button-accent2'], 0.22)]]) {
    const r = contrast(acc, bg);
    expect(r >= 4.5, `${label} ${mode}: the label on a button's ${name} is ${r.toFixed(2)}:1, under 4.5`);
  }
};
for (const mode of ['dark', 'light']) hoverLegible('Classic', mode, {});
for (const [label, source] of [['GEOS', GEOS_THEME], ['Breadbin', BREADBIN_THEME], ['Phosphor', PHOSPHOR_THEME], ['Out Run', OUTRUN_THEME], ['Commando', COMMANDO_THEME]]) {
  const v = validateTheme(source);
  expect(v.theme && themeModes(v.theme) === 'both', `the built-in ${label} theme is valid with both modes (${v.error})`);
  for (const [mode, m] of Object.entries(v.theme.modes)) {
    for (const fg of ['text', 'dim', 'text-dim', 'accent', 'green', 'amber', 'red', 'info']) {
      if (!m[fg] || !m['panel-bg']) continue;
      const r = contrast(m[fg], m['panel-bg']);
      expect(r >= 4.5, `${label} ${mode}: ${fg} on panel-bg is ${r.toFixed(2)}:1, under 4.5`);
    }
    hoverLegible(label, mode, m);
    // A theme that gives buttons their own face keeps every button label legible on it.
    if (m['button-bg']) {
      for (const fg of ['button-text', 'button-dim', 'button-accent', 'button-accent2', 'button-green', 'button-amber', 'button-red']) {
        if (!m[fg]) continue;
        const r = contrast(m[fg], m['button-bg']);
        expect(r >= 4.5, `${label} ${mode}: ${fg} on button-bg is ${r.toFixed(2)}:1, under 4.5`);
      }
    }
    // And the same for its primary buttons.
    if (m['primary-bg']) {
      for (const fg of ['primary-text', 'primary-dim', 'primary-accent', 'primary-accent2', 'primary-green', 'primary-amber', 'primary-red']) {
        if (!m[fg]) continue;
        const r = contrast(m[fg], m['primary-bg']);
        expect(r >= 4.5, `${label} ${mode}: ${fg} on primary-bg is ${r.toFixed(2)}:1, under 4.5`);
      }
    }
  }
}

// 8b. Page patterns: a theme's "look" names one per mode from a fixed list; the
// app owns every recipe, so a file carries no CSS, and the ink stays faint.
{
  const L = (look, modes = { dark: { text: '#ffffff' }, light: { text: '#000000' } }) => T(modes, { look });
  const ok = parseTheme(L({ dark: { pattern: 'grid', size: 'large' }, light: { pattern: 'dots' } }));
  expect(ok.theme && ok.theme.look.dark.pattern === 'grid' && ok.theme.look.dark.size === 'large' && ok.theme.look.light.pattern === 'dots',
    `a look with a pattern per mode is kept (${JSON.stringify(ok)})`);
  expect(parseTheme(JSON.stringify({ format: 'c64ready-theme/1', name: 'Old', modes: { dark: { text: '#fff' } } })).theme,
    'a c64ready-theme/1 file still imports');
  rejects(L({ dark: { pattern: 'url(x)' } }), '"pattern"', 'a pattern outside the list is refused');
  rejects(L({ dark: { pattern: 'grid', size: 'huge' } }), '"size"', 'a size outside the list is refused');
  rejects(L({ dark: { pattern: 'grid', css: 'x' } }), 'Unknown setting', 'any other look setting is refused');
  rejects(L({ dim: { pattern: 'grid' } }), 'Unknown mode', 'a look for an unknown mode is refused');
  rejects(L('grid'), '"look"', 'a look that is not an object is refused');
  expect(!parseTheme(L({ light: { pattern: 'grid' } }, { dark: { text: '#fff' } })).theme.look, 'a look for a mode the theme lacks is dropped');
  expect(!parseTheme(L({ dark: { pattern: 'none' } })).theme.look, 'a look of no pattern is no look');
  rejects(T({ dark: { 'pattern-ink': 'rgba(0, 0, 0, 0.5)' } }), 'too strong', 'a strong pattern ink is refused');
  rejects(T({ dark: { 'pattern-ink': '#000000' } }), 'too strong', 'an opaque pattern ink is refused');
  expect(parseTheme(T({ dark: { 'pattern-ink': 'rgba(0, 0, 0, 0.1)' } })).theme, 'a faint pattern ink is fine');
  expect(colourAlpha('#0000001a') < 0.11 && colourAlpha('rgba(1,2,3,10%)') === 0.1 && colourAlpha('#abc') === 1, 'colourAlpha reads hex, rgba and percent alpha');
  const lenient = validateTheme({ format: THEME_FORMAT, name: 'L', modes: { dark: { text: '#fff', 'pattern-ink': '#000' } }, look: { dark: { pattern: 'nope' }, x: 1 } }, { lenient: true });
  expect(lenient.theme && !lenient.theme.look && !('pattern-ink' in lenient.theme.modes.dark), 'a stored theme drops a look or ink it cannot use instead of being dropped');

  const css = themeCss(ok.theme);
  const recipe = patternLayers('grid', 'large');
  expect(css.includes(`--page-pattern: ${recipe.image};`) && css.includes(`--page-pattern-size: ${recipe.size};`),
    `themeCss writes the named recipe for the mode (${css})`);
  expect(css.includes('--pattern-ink: rgba(255, 255, 255, 0.07);'), 'a pattern with no ink is drawn in the theme\'s text colour, faintly');
  const values = [...css.matchAll(/--page-pattern: ([^;]*);/g)].map((m) => m[1]);
  const recipes = new Set(PATTERN_NAMES.flatMap((n) => ['small', 'medium', 'large'].map((s) => patternLayers(n, s)?.image)).filter(Boolean));
  expect(values.length === 2 && values.every((v) => recipes.has(v)), 'themeCss only ever writes recipes from the list');
  expect(themeCss(parseTheme(T({ dark: { text: '#fff' } })).theme).includes('--page-pattern: none;'), 'a theme with no look turns Classic\'s pattern off');
  const base = fs.readFileSync(path.join(root, 'src', 'styles', 'styles-base.css'), 'utf8');
  const classicGrid = patternLayers(CLASSIC_LOOK.dark.pattern, CLASSIC_LOOK.dark.size);
  expect(base.includes(`--page-pattern: ${classicGrid.image};`) && base.includes(`--page-pattern-size: ${classicGrid.size};`),
    "styles-base.css's default pattern is Classic's look");
  expect(exportTheme({ name: 'Classic', theme: null }, classic).look?.light?.pattern === 'grid', "exporting Classic keeps its grid");
  for (const n of PATTERN_NAMES) expect(n === 'none' ? !patternLayers(n) : patternLayers(n).image.split('gradient(').length - 1 === patternLayers(n).size.split(',').length,
    `the ${n} recipe gives one size per layer`);

  const exp = exportTheme({ name: 'P', theme: ok.theme }, classic);
  expect(exp.format === THEME_FORMAT && exp.look?.dark?.pattern === 'grid' && !('pattern-ink' in exp.modes.dark), 'export keeps the look, and leaves a derived ink out');
  expect(themeCss(parseTheme(JSON.stringify(exp)).theme) === themeCss(parseTheme(JSON.stringify(exportTheme({ name: 'P', theme: parseTheme(JSON.stringify(exp)).theme }, classic))).theme),
    'a theme with a look exports and imports again unchanged');

  // Header text sits on the page, over the pattern: it stays legible over the
  // worst of the page (its glow or its base) with the ink laid on top.
  const over = (bg, ink) => {
    const m = ink.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    return m ? mixIn(bg, '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join(''), +m[4]) : bg;
  };
  for (const [label, source] of [['Classic', null], ['GEOS', GEOS_THEME], ['Breadbin', BREADBIN_THEME], ['Phosphor', PHOSPHOR_THEME], ['Out Run', OUTRUN_THEME], ['Commando', COMMANDO_THEME]]) {
    const t = source ? validateTheme(source).theme : { look: CLASSIC_LOOK, modes: { dark: {}, light: {} } };
    expect(t.look && t.look.dark && t.look.light, `${label} has a page pattern in both modes`);
    for (const mode of ['dark', 'light']) {
      const s = { ...sheetModes[mode], ...t.modes[mode] };
      expect(colourAlpha(s['pattern-ink']) <= MAX_INK_ALPHA, `${label} ${mode}: its ink is faint enough`);
      // Dim text sits on the page (the drop hint under the screen); the header
      // links are outlined buttons, labelled in the button accent (the theme's
      // own when it sets none).
      const link = { ...sheetModes[mode], ...withButtonColours(t.modes[mode]) }['button-accent'];
      for (const page of ['crt-bg', 'page-glow']) {
        for (const [fg, colour] of [['text', s.text], ['dim', s.dim], ['link', link]]) {
          for (const [where, bg] of [['between', s[page]], ['over', over(s[page], s['pattern-ink'])]]) {
            const r = contrast(colour, bg);
            expect(r >= 4.5, `${label} ${mode}: ${fg} ${where} its pattern on ${page} is ${r.toFixed(2)}:1, under 4.5`);
          }
        }
      }
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

console.log(`ok - themes: format, colours only, modes, rules, storage, export, ${THEME_TOKENS.length} tokens, built-in themes, page patterns, pre-paint`);
