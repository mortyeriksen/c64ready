// The 3D models are a manual download into public/ (README), and are supplied by
// the deployed site. That arrangement only holds while three places agree on the
// same two filenames: the viewer that asks for them, the deployed site's cache
// headers, and the README that tells a developer where to get them. Drift
// between any two is silent — a rename would leave the viewer asking for a name
// nothing serves.
//
// The models are also asserted to be git-ignored. At 113 MB together they must
// never land in a commit by accident, and the README promises they are ignored.
//
// Neither model is asserted to exist on disk — that is the whole point. A fresh
// clone has neither, and the viewer handles their absence.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// The two builds, named once here; everything below must agree.
const MODELS = ['commodore_64.glb', 'commodore_64_4k.glb'];

// ── The viewer asks for both by name, and copes when one is absent ───────────
const viewer = read('src/retrovibes.js');
for (const m of MODELS) expect(viewer.includes(m), `src/retrovibes.js loads ${m}`);
expect(viewer.includes('COULD NOT LOAD MODEL'),
  'and says so when a model is absent, rather than leaving the viewer hanging');

// ── The deployed site serves them immutably; a rename must not lose that ─────
const headers = read('public/_headers');
for (const m of MODELS) expect(headers.includes(`/${m}`), `public/_headers has an entry for /${m}`);

// ── And a developer is told what to do ───────────────────────────────────────
const readme = read('README.md');
for (const m of MODELS) expect(readme.includes(m), `the README names ${m}`);
for (const m of MODELS) expect(readme.includes(`public/${m}`), `and that ${m} goes at the top level of public/`);
expect(readme.includes('skfb.ly/oUKFx'),
  'and sends the reader to the model\'s own source, not to a copy this project serves');
expect(readme.includes('CC BY'), 'and under what licence, since they are third-party');
// Prose wraps, so match against a single-line copy: this is about what the README
// says, not how it happens to be laid out.
const readmeFlat = readme.replace(/\s+/g, ' ');
expect(/`public\/`[^.]*`dist\/`/.test(readmeFlat),
  'and that a build carries whatever is in public/ through to dist/');

// ── And git never picks them up ──────────────────────────────────────────────
const ignoreRules = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
expect(ignoreRules.includes('*.glb'), '.gitignore ignores *.glb');
for (const m of MODELS) expect(!ignoreRules.some((l) => l.startsWith('!') && l.endsWith(m)),
  `and nothing un-ignores ${m}`);
// Inside a checkout, ask git itself — that is what a commit would consult.
if (fs.existsSync(new URL('../.git', import.meta.url))) {
  for (const m of MODELS) {
    const r = spawnSync('git', ['check-ignore', '-q', `public/${m}`],
      { cwd: new URL('..', import.meta.url), stdio: 'ignore' });
    if (r.error) break;   // no git on this machine — the .gitignore checks above stand
    expect(r.status === 0, `git would ignore public/${m}`);
  }
}

// ── Nothing tries to fetch them at build time any more ───────────────────────
expect(!fs.existsSync(new URL('../tools/fetch-model.mjs', import.meta.url)),
  'tools/fetch-model.mjs is gone — the models are a manual download');
const vite = read('vite.config.js');
expect(!/fetchModel/.test(vite), 'and vite.config.js no longer reaches for them at build time');

console.log(`model asset spec: PASS (${MODELS.length} manual downloads)`);
