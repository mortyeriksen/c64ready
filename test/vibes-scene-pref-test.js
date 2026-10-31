// The remembered Retro Vibes scene (src/vibes/vibes-scene-pref.js): stored by
// name, and a position stored by an earlier version still opens the scene it
// meant, though scenes have since been removed and the rest moved up.

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sceneIndexFromStored, LEGACY_SCENE_ORDER } from '../src/vibes/vibes-scene-pref.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = ['Synthwave', 'Starry Plain', 'Foggy Spotlight', 'IK+ Sunset', '80s Bedroom'];

// The order earlier versions stored positions in.
assert.deepEqual(LEGACY_SCENE_ORDER, ['Synthwave', 'Starry Plain', 'Spotlight', 'Foggy Spotlight', 'IK+ Sunset', '80s Bedroom'],
  'the legacy order is the scene list positions were stored against');

// Every stored legacy position opens the scene it named.
const expected = { 0: 'Synthwave', 1: 'Starry Plain', 2: 'Foggy Spotlight', 3: 'Foggy Spotlight', 4: 'IK+ Sunset', 5: '80s Bedroom' };
for (const [pos, name] of Object.entries(expected)) {
  assert.equal(names[sceneIndexFromStored(String(pos), names)], name, `a stored position ${pos} opens ${name}`);
}
assert.equal(names[sceneIndexFromStored('5', names)], '80s Bedroom', 'the last scene, now at a lower position, still opens');
assert.equal(names[sceneIndexFromStored('2', names)], 'Foggy Spotlight', 'the removed Spotlight opens as Foggy Spotlight');
assert.equal(names[sceneIndexFromStored('9', names)], '80s Bedroom', 'a position past the old list opens its last scene');

// Names round-trip, and anything unknown opens the first scene.
for (const n of names) assert.equal(names[sceneIndexFromStored(n, names)], n, `a stored name "${n}" opens that scene`);
assert.equal(sceneIndexFromStored('Spotlight', names), names.indexOf('Foggy Spotlight'), 'the removed Spotlight by name opens as Foggy Spotlight');
for (const v of [null, '', 'No Such Scene', '-1', '1.5']) assert.equal(sceneIndexFromStored(v, names), 0, `"${v}" opens the first scene`);

// The viewer stores names and reads through this.
const viewer = fs.readFileSync(path.join(root, 'src/vibes/retrovibes.js'), 'utf8');
assert.match(viewer, /localStorage\.setItem\(SCENE_KEY, SCENES\[n\]\.name\)/, 'the viewer stores the scene by name');
assert.match(viewer, /sceneIndexFromStored\(localStorage\.getItem\(SCENE_KEY\), SCENES\.map\(\(d\) => d\.name\)\)/, 'the viewer reads the remembered scene through sceneIndexFromStored');
// The current list must match the names used here.
const listed = viewer.match(/const SCENES = \[([^\]]*)\]/)[1].split(',').map((s) => s.trim());
assert.equal(listed.length, names.length, 'the scene list has the scenes this test expects');

// The label the first open shows is a scene label, so a switch made before that
// scene is ready (its compile then never counts) still clears it when its own
// scene is.
assert.match(viewer, /this\._sceneLabelShown = true;\s*this\._setLoading\('LOADING SCENE…'\);\s*this\._readyScene\(\)\.then\(\(current\) => \{ if \(current\) this\._disarmSceneLabel\(\); \}\);/,
  'the first scene\'s LOADING SCENE label is cleared by whichever scene becomes ready');

console.log('ok  - vibes scene memory: by name, legacy positions map to the scenes they meant, removed Spotlight opens Foggy Spotlight, a quick first switch clears the loading label');
