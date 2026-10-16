// Spec tests for the 80s Bedroom room model (public/models/bedroom.glb)
// and its scene: the file carries what the scene reads, and nothing the viewer
// must not pay for.

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'public/models/bedroom.glb');
// The room is in the repository (unlike the C64 models); skip if it is missing anyway.
if (!fs.existsSync(file)) {
  console.log('# SKIP public/models/bedroom.glb is not present');
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
  assert.ok(fs.existsSync(path.join(root, 'public/models', f)), `public/models/${f} ships beside the room model`);
}
const small = fs.statSync(path.join(root, 'public/models/bedroom_small.glb')).size;
assert.ok(small < glb.length, 'the phone room model is smaller than the desktop one');

// Options ▸ Display ▸ 3D MODEL picks the room's files, as it does the C64 model's.
assert.match(sceneSrc, /wantsLargeModels\(\)/, 'the room follows the 3D MODEL setting');
assert.doesNotMatch(sceneSrc, /maxTouchPoints/, 'the room does not pick its files by a touch test of its own');

// The scene is the viewer's 80s Bedroom, last in its list.
// Flat things hung on a wall need real depth between them and it: the depth
// buffer cannot tell a few millimetres apart at room distances (worst after the
// fullscreen framer pulls the near plane in), and the two flicker through each
// other. The world map keeps about 9 mm (0.07 file units at 8.0456 per metre).
{
  const THREE = await import('three');
  const parent = {};
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
  const local = (n) => (n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(
    new THREE.Vector3(...(n.translation || [0, 0, 0])), new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])), new THREE.Vector3(...(n.scale || [1, 1, 1]))));
  const world = (i) => { let m = local(json.nodes[i]); for (let q = parent[i]; q !== undefined; q = parent[q]) m = local(json.nodes[q]).multiply(m); return m; };
  const bounds = (i) => {
    const box = new THREE.Box3();
    for (const prim of json.meshes[json.nodes[i].mesh].primitives) {
      const a = json.accessors[prim.attributes.POSITION];
      const d = a.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 })[a.componentType] : 1;
      box.union(new THREE.Box3(new THREE.Vector3(...a.min.map((x) => x / d)), new THREE.Vector3(...a.max.map((x) => x / d))).applyMatrix4(world(i)));
    }
    return box;
  };
  const mapIndex = json.nodes.findIndex((n) => n.name === 'World Map');
  assert.ok(mapIndex >= 0 && json.nodes[mapIndex].mesh !== undefined, 'the room model has the world map');
  const map = bounds(mapIndex);
  const size = map.getSize(new THREE.Vector3());
  const axis = ['x', 'y', 'z'].reduce((m, k) => (size[k] < size[m] ? k : m), 'x');   // the map's thin axis
  const others = ['x', 'y', 'z'].filter((k) => k !== axis);
  let gap = Infinity;
  json.nodes.forEach((n, i) => {
    if (n.mesh === undefined || i === mapIndex || /^Map Pin/.test(n.name || '')) return;
    const b = bounds(i), bs = b.getSize(new THREE.Vector3());
    if (bs[axis] > 1e-3) return;   // only flat surfaces parallel to the map
    if (!others.every((k) => b.min[k] <= map.min[k] && b.max[k] >= map.max[k])) return;   // covering the map's whole face
    gap = Math.min(gap, Math.abs(b.min[axis] - map.min[axis]));
  });
  assert.ok(gap >= 0.07, `the world map hangs at least 0.07 units (about 9 mm) off its wall, not ${gap.toFixed(3)}`);
}

const viewer = fs.readFileSync(path.join(root, 'src/vibes/retrovibes.js'), 'utf8');
assert.match(viewer, /import \{ scene as sceneBedroom \} from '\.\/vibes-scene-bedroom\.js'/, 'the viewer takes its 80s Bedroom from vibes-scene-bedroom.js');
assert.match(viewer, /const SCENES = \[[^\]]*sceneIkplus, sceneBedroom\]/, '80s Bedroom is the last scene, after IK+ Sunset');
assert.match(sceneSrc, /name: '80s Bedroom'/, 'the scene is named 80s Bedroom');
// The grade's grain changes every frame. Ahead of SMAA it would shift SMAA's edge
// detection frame to frame, so the paper edges of the posters flicker on a still camera.
const order = ['new OutputPass()', 'new SMAAPass()', 'new ShaderPass(GradeShader)'].map((p) => viewer.indexOf(p));
assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'SMAA runs before the grain-adding grade pass, after OutputPass');

console.log('ok  - 80s bedroom: markers, lightmap UVs and scale, small version, no lights/cameras/transmission, follows 3D MODEL, last in the scene list, grain after SMAA');
