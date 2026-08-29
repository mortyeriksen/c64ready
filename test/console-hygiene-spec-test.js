// Nothing in the app may log to the console on a path an ordinary user reaches.
//
// The debug helpers are a feature, not leftovers: `c64Trace` / `c64Vic` /
// `c64Bus` print their findings, and stripping console.* at build time would
// quietly turn them into functions that compute a result and throw it away — on
// exactly the deployed build where you want a user to run one. So the guarantee
// is enforced here instead: every `console.log` in src/ is either invoked from
// DevTools or sits behind a debug flag, and this test pins that inventory.
//
// A NEW `console.log` fails this test. That is the point. Two ways to fix it:
//   1. Gate it — `if (window.c64Trace?.somethingDiag) { … }`, the idiom
//      recorder.js and main.js use — and add it below with that gate named.
//   2. If it really should print unprompted, add it below with the reason.
// Either way it becomes a decision someone made, not one that slipped in.
//
// console.warn / console.error are deliberately NOT covered: a warning about a
// failed remux or a missing ROM is a diagnostic for the person hitting it, and
// should always reach them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The console API itself — its whole job is printing, and every entry point is
// something you type into DevTools.
const EXEMPT_FILES = new Set(['debug.js']);

// Reviewed log sites: file → tag → why it cannot fire on its own.
// The tag is the bracketed prefix of the message, so moving code around doesn't
// break this; changing what a line says does, which is when it's worth a look.
const ALLOWED = {
  'av-marker.js': {
    '[avmarker]': 'A/V clapper. main.js only constructs the marker when avMarkerEnabled().',
  },
  'machine.js': {
    '[sid-trace]': 'sidTraceStart/sidTraceDump — reachable only via c64Trace.sidStart().',
    '(none)': 'continuation of the [sid-trace] dump above; same DevTools-only entry point.',
  },
  'main.js': {
    '[sid]': 'SID cycle-sync diagnostics, behind `if (!window.c64Trace?.sidDiag) return;`.',
  },
  'recorder.js': {
    '[recorder]': 'remux/index statistics, behind `if (window.c64Trace?.recorderDiag)`.',
  },
};

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// The bracketed prefix a log opens with, e.g. "[recorder] indexed …" → "[recorder]".
function tagOf(text) {
  const m = /^[^)]{0,80}?\[([a-z0-9 _-]+)\]/i.exec(text);
  return m ? `[${m[1]}]` : '(none)';
}

const found = [];
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file);
  if (EXEMPT_FILES.has(path.basename(file))) continue;
  const src = fs.readFileSync(file, 'utf8');
  const re = /console\.log\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    found.push({
      file: rel,
      line: src.slice(0, m.index).split('\n').length,
      tag: tagOf(src.slice(m.index + m[0].length, m.index + m[0].length + 90)),
    });
  }
}

// ── Every site found must be one we have reviewed ────────────────────────────
const unreviewed = found.filter((f) => !ALLOWED[f.file]?.[f.tag]);
expect(unreviewed.length === 0,
  'console.log that nothing gates:\n' +
  unreviewed.map((f) => `    ${f.file}:${f.line}  ${f.tag}`).join('\n') +
  '\n  Gate it behind a c64Trace flag, or add it to ALLOWED in this test with the reason.');

// ── And every entry in the list must still exist ─────────────────────────────
// Otherwise the inventory rots into a list of places logs used to be, and stops
// meaning anything.
const stale = [];
for (const [file, tags] of Object.entries(ALLOWED)) {
  for (const tag of Object.keys(tags)) {
    if (!found.some((f) => f.file === file && f.tag === tag)) stale.push(`${file} ${tag}`);
  }
}
expect(stale.length === 0,
  `ALLOWED lists sites that no longer exist — delete them:\n    ${stale.join('\n    ')}`);

// ── The build must not be stripping console.* behind our backs ───────────────
// If someone adds esbuild.drop / terser drop_console later, the gates above stop
// being what decides, and the DevTools helpers go silent in production.
const viteConfig = fs.readFileSync(path.join(SRC, '..', 'vite.config.js'), 'utf8');
expect(!/drop_console|drop:\s*\[[^\]]*['"]console/.test(viteConfig),
  'vite.config.js strips console.* at build time — that silences the c64Trace / c64Vic / c64Bus '
  + 'helpers in production builds, which is where they are most needed.');

console.log(`console hygiene spec: PASS (${found.length} reviewed log sites, none ungated)`);
