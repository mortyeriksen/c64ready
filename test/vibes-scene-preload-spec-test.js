// A Retro Vibes scene's preload() (src/vibes/vibes-scene-*.js) fetches the
// scene's files and decodes nothing. The viewer waits for it before it swaps
// scenes, with the machine still running, so that the files are in when the
// swap pauses it. Decoding a GLB holds the main thread, which starves the
// sound: it belongs inside that pause, in build().
//
//   1. preload() fetches the scene's model file and parses no GLB.
//   2. build() then parses it, from the bytes already fetched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// The page's files, served from public/. three's loaders ask through a
// Request, which outside a page needs a whole URL: a made-up origin stands in.
const ORIGIN = 'http://vibes.test';
const PageRequest = globalThis.Request;
globalThis.Request = class extends PageRequest { constructor(url, init) { super(new URL(url, ORIGIN), init); } };
globalThis.ProgressEvent ??= class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const fetches = [];
globalThis.fetch = async (url) => {
  const name = new URL(String(url?.url ?? url), ORIGIN).pathname;
  fetches.push(name);
  const file = path.join(root, 'public', name);
  return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
};
let parses = 0;
const parse = GLTFLoader.prototype.parse;
GLTFLoader.prototype.parse = function (...args) { parses++; return parse.apply(this, args); };
const quiet = console.warn;
console.warn = () => {};   // a scene says so when a file it can do without is missing

const scenes = [
  ['Synthwave', '../src/vibes/vibes-scene-synthwave.js', 'synthwave.glb'],
  ['80s Bedroom', '../src/vibes/vibes-scene-bedroom.js', 'bedroom_small.glb'],
  ['Foggy Spotlight', '../src/vibes/vibes-scene-spotlight-real.js', 'spotlight_real_small.glb'],
];
let testNo = 0;
for (const [name, file, glb] of scenes) {
  const { scene } = await import(file);
  assert.equal(scene.name, name);
  fetches.length = 0; parses = 0;
  await scene.preload();
  assert.ok(fetches.some((u) => u.endsWith(glb)), `${name}: preload fetches ${glb} (${fetches.join(', ')})`);
  assert.equal(parses, 0, `${name}: preload parses no GLB`);
  const fetched = fetches.filter((u) => u.endsWith(glb)).length;
  await scene.preload();
  assert.equal(fetches.filter((u) => u.endsWith(glb)).length, fetched, `${name}: a second preload fetches nothing again`);
  console.log(`ok  - test ${++testNo}: ${name} preloads its files without decoding them`);
}

// build() decodes what preload() fetched. Synthwave builds without a page.
{
  const { scene } = await import('../src/vibes/vibes-scene-synthwave.js');
  const g = new THREE.Group(), parent = new THREE.Group(); parent.add(g);
  fetches.length = 0; parses = 0;
  await scene.build(g, { sphere: new THREE.Sphere(new THREE.Vector3(0, 2, -1), 7.7), box: new THREE.Box3(new THREE.Vector3(-5.5, 0, -6.2), new THREE.Vector3(5.2, 3.8, 4.3)), screen: null, lowPower: true });
  assert.equal(parses, 1, 'build parses the GLB');
  assert.equal(fetches.filter((u) => u.endsWith('synthwave.glb')).length, 0, 'from the bytes preload fetched');
  console.log(`ok  - test ${++testNo}: build decodes the preloaded file`);
}

console.warn = quiet;
console.log(`\nok - vibes scene preload: ${testNo} checks`);
