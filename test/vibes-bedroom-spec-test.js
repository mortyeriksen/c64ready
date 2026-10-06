// Spec tests for the 80s Bedroom room model (public/bedroom.glb)
// and its scene: the file carries what the scene reads, and nothing the viewer
// must not pay for.

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'public/bedroom.glb');
// The room is in the repository (unlike the C64 models); skip if it is missing anyway.
if (!fs.existsSync(file)) {
  console.log('# SKIP public/bedroom.glb is not present');
  process.exit(0);
}
const glb = fs.readFileSync(file);

// GLB container: 12-byte header, then a JSON chunk (glTF 2.0 binary spec).
assert.equal(glb.readUInt32LE(0), 0x46546c67, 'the room model is a binary glTF ("glTF" magic)');
assert.equal(glb.readUInt32LE(4), 2, 'the room model is glTF 2.0');
assert.equal(glb.readUInt32LE(8), glb.length, 'the GLB header length matches the file');
assert.equal(glb.readUInt32LE(16), 0x4e4f534a, 'the first GLB chunk is JSON');
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));

const names = new Set(json.nodes.map((n) => n.name));
for (const marker of ['Room Origin', 'Light Lamp', 'Light Lamp Target', 'Light Moon', 'Light Moon Target', 'Light TV', 'Light Clock', 'Light Lava', 'Beam Start', 'Beam End']) {
  assert.ok(names.has(marker), `the room model has the "${marker}" marker the scene places by`);
}
for (const node of ['TV Screen', 'TV Overlay', 'Outside Sky', 'Lamp Shade', 'Lamp Bulb']) {
  assert.ok(names.has(node), `the room model names "${node}", which the scene treats specially`);
}
const used = json.extensionsUsed || [];
assert.ok(!used.includes('KHR_lights_punctual'), 'the room model carries no lights (the scene adds its own)');
assert.ok(!json.cameras, 'the room model carries no cameras');
assert.ok(!used.includes('KHR_materials_transmission'), 'the room model has no transmission (an extra render pass every frame)');
const sceneSrc = fs.readFileSync(path.join(root, 'src/vibes/vibes-scene-bedroom.js'), 'utf8');
assert.ok(!used.includes('KHR_draco_mesh_compression'), 'the room model needs no Draco decoder (the viewer loads none)');
if (used.includes('EXT_meshopt_compression')) assert.match(sceneSrc, /setMeshoptDecoder\(MeshoptDecoder\)/, 'the scene gives its loader the meshopt decoder the room model needs');
assert.ok(glb.length < 12 * 1024 * 1024, 'the room model stays under 12 MB');

// Baked bounce light: a second UV set on the room's surfaces, and the scale the
// 8-bit lightmap was divided by, stored on the origin marker.
const prims = json.meshes.flatMap((m) => m.primitives);
assert.ok(prims.some((p) => p.attributes.TEXCOORD_1 !== undefined), 'the room model carries lightmap UVs (TEXCOORD_1)');
const scale = json.nodes.find((n) => n.name === 'Room Origin').extras?.lightmapScale;
assert.ok(Number.isFinite(scale) && scale > 0, 'the origin marker records a positive lightmap scale');
for (const f of ['bedroom_light.webp', 'bedroom_small.glb', 'bedroom_light_small.webp']) {
  assert.ok(fs.existsSync(path.join(root, 'public', f)), `public/${f} ships beside the room model`);
}
const small = fs.statSync(path.join(root, 'public/bedroom_small.glb')).size;
assert.ok(small < glb.length, 'the phone room model is smaller than the desktop one');

// Options ▸ Display ▸ 3D MODEL picks the room's files, as it does the C64 model's.
assert.match(sceneSrc, /wantsLargeModels\(\)/, 'the room follows the 3D MODEL setting');
assert.doesNotMatch(sceneSrc, /maxTouchPoints/, 'the room does not pick its files by a touch test of its own');

// The scene is the viewer's 80s Bedroom, last in its list.
const viewer = fs.readFileSync(path.join(root, 'src/vibes/retrovibes.js'), 'utf8');
assert.match(viewer, /import \{ scene as sceneBedroom \} from '\.\/vibes-scene-bedroom\.js'/, 'the viewer takes its 80s Bedroom from vibes-scene-bedroom.js');
assert.match(viewer, /const SCENES = \[[^\]]*sceneIkplus, sceneBedroom\]/, '80s Bedroom is the last scene, after IK+ Sunset');
assert.match(sceneSrc, /name: '80s Bedroom'/, 'the scene is named 80s Bedroom');

console.log('ok  - 80s bedroom: markers, lightmap UVs and scale, small version, no lights/cameras/transmission, follows 3D MODEL, last in the scene list');
