// Theme tokens: every colour the interface uses comes from src/styles/styles-theme.css,
// so a theme only has to supply that one set of custom properties.
//
// Rules checked:
//   1. Outside styles-theme.css, a stylesheet writes no colour of its own,
//      except in the areas that are deliberately not themed (FIXED below).
//   2. Every custom property a stylesheet reads is defined somewhere: in the
//      theme, or locally for the layout properties that are not colours.
//   3. The theme holds only colours, so a theme file cannot smuggle in layout.
//      Its dark values sit on ":root, .mode-dark" (the .mode-dark areas keep
//      them in light mode); light values on ':root[data-mode="light"]' may only
//      override tokens the dark set defines.
//   4. No gradient has a color-mix() stop. color-mix() yields a modern colour,
//      and one modern stop moves the whole gradient from sRGB to Oklab
//      interpolation (CSS Color 4), which draws it differently. A translucent
//      gradient stop gets its own rgba() token instead.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = 'src/styles/styles-theme.css';
const SHEETS = [
  'src/styles/styles-base.css', 'src/styles/styles-header.css', 'src/styles/styles-display.css', 'src/styles/styles-dialogs.css',
  'src/styles/styles-controls.css', 'src/styles/styles-decks.css', 'src/styles/styles-ports.css', 'src/vibes/styles-vibes.css',
  'src/styles/styles-splash.css', 'src/styles/styles-splash-themes.css', 'src/styles/styles-assembly64.css',
];

// Not themed: the monitor and the CRT looks drawn over the picture, the
// scanline overlays on the logo, the collision badge on the screen, the
// splash's per-theme colours (generated from the themes by tools/splash-themes.mjs,
// kept current by themes-spec-test.js), video frame and scanlines, and the
// Retro Vibes 3D scenes.
const FIXED = [
  /\.c64-monitor(?!.*fullscreen)/, /\.crt-bezel/, /\.crt-shine/, /\.crt-roll/, /#fps-counter/, /#build-stamp/,
  /#collision-indicator/, /\.logo-text( \[data-t\]::after)?$/, /\.logo-text::before/, /^(:root\[data-mode="light"\] )?body\[data-splash-theme="[a-z]+"\] #splash$/, /\.splash-inner::after/, /\.splash-media$/,
  /\.model-viewer/, /\.fs-close-btn/,
];

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black)\b/;

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A small rule walker: enough CSS to see each declaration with its selector.
function declarations(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [];
  const stack = [];
  let buf = '';
  let line = 1;
  let bufLine = 1;
  for (const ch of css) {
    if (ch === '\n') line++;
    if (ch === '{') { stack.push(buf.trim().replace(/\s+/g, ' ')); buf = ''; continue; }
    if (ch === '}' || ch === ';') {
      const text = buf.trim();
      const colon = text.indexOf(':');
      if (colon > 0 && stack.length && !stack[stack.length - 1].startsWith('@')) {
        out.push({ selector: stack[stack.length - 1], prop: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim(), line: bufLine });
      }
      if (ch === '}') stack.pop();
      buf = '';
      continue;
    }
    if (!buf.trim()) bufLine = line;
    buf += ch;
  }
  return out;
}

const theme = declarations(fs.readFileSync(path.join(root, THEME), 'utf8'));
const DARK = ':root, .mode-dark';
const LIGHT = ':root[data-mode="light"]';
const tokens = new Set(theme.filter((d) => d.selector === DARK).map((d) => d.prop));
expect(tokens.size > 50, `the theme defines its tokens on "${DARK}" (found ${tokens.size})`);

for (const d of theme) {
  expect((d.selector === DARK || d.selector === LIGHT) && d.prop.startsWith('--'),
    `${THEME}:${d.line} the theme only sets custom properties, in the dark and light blocks (found "${d.selector}")`);
  expect(d.selector === DARK || tokens.has(d.prop), `${THEME}:${d.line} light mode sets ${d.prop}, which dark mode does not define`);
  expect(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/.test(d.value), `${THEME}:${d.line} ${d.prop} is a colour (got "${d.value}")`);
}

const localDefs = new Set();
const sheets = SHEETS.map((f) => ({ file: f, decls: declarations(fs.readFileSync(path.join(root, f), 'utf8')) }));
for (const { decls } of sheets) for (const d of decls) if (d.prop.startsWith('--')) localDefs.add(d.prop);

let literals = 0;
for (const { file, decls } of sheets) {
  for (const d of decls) {
    const fixedHere = FIXED.some((re) => d.selector.split(',').some((s) => re.test(s.trim())));
    if (d.prop.startsWith('--')) {
      expect(fixedHere || !COLOUR.test(d.value), `${file}:${d.line} ${d.prop} is a colour, so it belongs in ${THEME}`);
      continue;
    }
    if (COLOUR.test(d.value)) {
      const fixed = FIXED.some((re) => d.selector.split(',').some((s) => re.test(s.trim())));
      expect(fixed, `${file}:${d.line} "${d.selector}" { ${d.prop}: ${d.value} } writes a colour; use a token from ${THEME}`);
      literals++;
    }
    expect(!(/gradient\(/.test(d.value) && /color-mix\(/.test(d.value)),
      `${file}:${d.line} "${d.selector}" { ${d.prop} } has a color-mix() gradient stop; use an rgba() token`);
    // A var() with a fallback is always defined (properties set from script,
    // like the logo's CRT tuning, carry one); without one it must be a token
    // or a property some stylesheet sets.
    for (const [, name, fallback] of d.value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
      expect(fallback || tokens.has(name) || localDefs.has(name), `${file}:${d.line} reads ${name}, which nothing defines`);
    }
  }
}

console.log(`ok - ${tokens.size} theme tokens; ${sheets.length} stylesheets use only tokens outside ${literals} fixed-area declarations`);
