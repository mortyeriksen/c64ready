// Load State dialog: per-slot Rename button.
//
// Source-scrape spec (the statelibrary IndexedDB layer is exercised manually in
// the browser, like the rest of it). Asserts the storage API exists and is
// metadata-only + blank-refusing, and that the dialog renders a rename control
// and wires it to a prompt → stateRename → re-render.

import fs from 'fs';

const lib   = fs.readFileSync(new URL('../src/statelibrary.js', import.meta.url), 'utf8');
const media = fs.readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');
const css   = fs.readFileSync(new URL('../src/styles-dialogs.css', import.meta.url), 'utf8');

let failures = 0;
function expect(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

// ── Storage API ──────────────────────────────────────────────────────────────
expect(/export async function stateRename\(id, newName\)/.test(lib),
  'statelibrary exports stateRename(id, newName)');
expect(/const name = newName && String\(newName\)\.trim\(\);\s*\n\s*if \(!name\) return false;/.test(lib),
  'stateRename trims the new name and refuses a blank one');
expect(/stateRename[\s\S]*?_run\(db, \[META_STORE\], 'readwrite'/.test(lib),
  'stateRename writes metadata only (no blob rewrite)');
expect(/stateRename[\s\S]*?meta\.name = name;\s*\n\s*store\.put\(meta\);/.test(lib),
  'stateRename reads the meta then puts it back in the same transaction');

// ── Dialog wiring ──────────────────────────────────────────────────────────────
expect(/import \{[^}]*\bstateRename\b[^}]*\} from '\.\/statelibrary\.js';/.test(media),
  'media.js imports stateRename');
expect(/data-rename="\$\{_libEscapeHtml\(e\.id\)\}"[^>]*aria-label="Rename"/.test(media),
  'each save-state row renders a Rename button');
expect(media.includes("const ren = e.target.closest('[data-rename]');"),
  'the list click handler routes the Rename button');
expect(/promptDialog\('Rename this save state:'/.test(media),
  'Rename opens a prompt to enter the new name');
expect(/defaultValue: current/.test(media) && media.includes(".querySelector('.lib-name')?.textContent"),
  'the rename prompt is prefilled with the slot’s current name');
expect(/if \(next === null \|\| next === '' \|\| next === current\) return;/.test(media),
  'rename is a no-op on cancel, a blank name, or an unchanged name');
expect(/await stateRename\(id, next\);[\s\S]*?await _renderStateList\(\);/.test(media),
  'a successful rename persists then re-renders the list');

// ── Styling ────────────────────────────────────────────────────────────────────
expect(/\.lib-rename:hover/.test(css),
  'the Rename button has an accent (non-destructive) hover style');

if (failures) {
  console.log(`\n${failures} state-rename spec failure(s)`);
  process.exit(1);
}

console.log('ok  - Load State dialog can rename a save state');
