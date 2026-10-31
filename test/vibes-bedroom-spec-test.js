// Spec tests for the 80s Bedroom room model (public/models/bedroom.glb)
// and its scene: the file carries what the scene reads, and nothing the viewer
// must not pay for.

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'bedroom';
const file = path.join(root, `public/models/${MODEL}.glb`);
// The room is in the repository (unlike the C64 models); skip if it is missing anyway.
if (!fs.existsSync(file)) {
  console.log(`# SKIP public/models/${MODEL}.glb is not present`);
  process.exit(0);
}
const glb = fs.readFileSync(file);

// GLB container: 12-byte header, then a JSON chunk (glTF 2.0 binary spec).
assert.equal(glb.readUInt32LE(0), 0x46546c67, 'the room model is a binary glTF ("glTF" magic)');
assert.equal(glb.readUInt32LE(4), 2, 'the room model is glTF 2.0');
assert.equal(glb.readUInt32LE(8), glb.length, 'the GLB header length matches the file');
assert.equal(glb.readUInt32LE(16), 0x4e4f534a, 'the first GLB chunk is JSON');
const jsonLength = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
const bin = glb.subarray(28 + jsonLength, 28 + jsonLength + glb.readUInt32LE(20 + jsonLength));

// The scene goes by tags (node extras), never by node names.
const extras = (key) => json.nodes.filter((n) => n.extras && n.extras[key] !== undefined);
const markers = new Map(extras('marker').map((n) => [n.extras.marker, n]));
for (const marker of ['room-origin', 'lamp', 'lamp-target', 'moon', 'moon-target', 'tv', 'clock', 'lava', 'beam-start', 'beam-end']) {
  assert.ok(markers.has(marker), `the room model has the "${marker}" marker the scene places by`);
}
assert.equal(extras('marker').length, markers.size, 'each marker appears once');
assert.equal(extras('tvScreen').filter((n) => n.mesh !== undefined).length, 1, 'one mesh is tagged as the TV picture');
assert.ok(extras('castShadow').length > 0 && extras('castShadow').every((n) => n.extras.castShadow === false), 'shadow opt-outs are tagged castShadow: false');
assert.ok(extras('receiveShadow').length > 0 && extras('receiveShadow').every((n) => n.extras.receiveShadow === false), 'shadow opt-outs are tagged receiveShadow: false');
const sceneSrc = fs.readFileSync(path.join(root, 'src/vibes/vibes-scene-bedroom.js'), 'utf8');
assert.doesNotMatch(sceneSrc, /getObjectByName|\.name\.startsWith|\.test\(o\.name\)/, 'the scene finds nothing in the room by name');

const used = json.extensionsUsed || [];
assert.ok(!used.includes('KHR_lights_punctual'), 'the room model carries no lights (the scene adds its own)');
assert.ok(!json.cameras, 'the room model carries no cameras');
assert.ok(!used.includes('KHR_materials_transmission'), 'the room model has no transmission (an extra render pass every frame)');
assert.ok(!used.includes('KHR_draco_mesh_compression'), 'the room model needs no Draco decoder (the viewer loads none)');
if (used.includes('EXT_meshopt_compression')) assert.match(sceneSrc, /setMeshoptDecoder\(MeshoptDecoder\)/, 'the scene gives its loader the meshopt decoder the room model needs');
assert.ok(glb.length < 12 * 1024 * 1024, 'the room model stays under 12 MB');

// Baked bounce light: a second UV set on the room's surfaces, and the scale the
// 8-bit lightmap was divided by, stored on the origin marker.
const prims = json.meshes.flatMap((m) => m.primitives);
assert.ok(prims.some((p) => p.attributes.TEXCOORD_1 !== undefined), 'the room model carries lightmap UVs (TEXCOORD_1)');
const scale = markers.get('room-origin').extras.lightmapScale;
assert.ok(Number.isFinite(scale) && scale > 0, 'the origin marker records a positive lightmap scale');
for (const f of [`${MODEL}_light.webp`, `${MODEL}_small.glb`, `${MODEL}_light_small.webp`]) {
  assert.ok(fs.existsSync(path.join(root, 'public/models', f)), `public/models/${f} ships beside the room model`);
  assert.ok(sceneSrc.includes(`'${f}'`), `the scene loads public/models/${f}`);
}
assert.ok(sceneSrc.includes(`'${MODEL}.glb'`), `the scene loads public/models/${MODEL}.glb`);
const small = fs.statSync(path.join(root, `public/models/${MODEL}_small.glb`)).size;
assert.ok(small < glb.length, 'the phone room model is smaller than the desktop one');

// Options ▸ Display ▸ 3D MODEL picks the room's files, as it does the C64 model's.
assert.match(sceneSrc, /wantsLargeModels\(\)/, 'the room follows the 3D MODEL setting');
assert.doesNotMatch(sceneSrc, /maxTouchPoints/, 'the room does not pick its files by a touch test of its own');

// Geometry checks work on the decoded triangles in file space, so they hold however
// the export merges meshes.
const THREE = await import('three');
const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
await MeshoptDecoder.ready;
const UNITS_PER_M = 8.0456;   // the file's scale (FILE_UNITS_PER_M in the scene)
assert.match(sceneSrc, /FILE_UNITS_PER_M = 8\.0456\b/, 'the scene reads the file at 8.0456 units per metre');
const parent = {};
json.nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
const local = (n) => (n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(
  new THREE.Vector3(...(n.translation || [0, 0, 0])), new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])), new THREE.Vector3(...(n.scale || [1, 1, 1]))));
const world = (i) => { let m = local(json.nodes[i]); for (let q = parent[i]; q !== undefined; q = parent[q]) m = local(json.nodes[q]).multiply(m); return m; };
const views = new Map();
const viewBytes = (v) => {
  if (!views.has(v)) {
    const bv = json.bufferViews[v], mo = bv.extensions?.EXT_meshopt_compression;
    let bytes;
    if (mo) {
      bytes = new Uint8Array(mo.count * mo.byteStride);
      MeshoptDecoder.decodeGltfBuffer(bytes, mo.count, mo.byteStride, new Uint8Array(bin.buffer, bin.byteOffset + (mo.byteOffset || 0), mo.byteLength), mo.mode, mo.filter || 'NONE');
    } else {
      bytes = new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset || 0), bv.byteLength);
    }
    views.set(v, bytes);
  }
  return views.get(v);
};
const COMPONENT = { 5120: [Int8Array, 127], 5121: [Uint8Array, 255], 5122: [Int16Array, 32767], 5123: [Uint16Array, 65535], 5125: [Uint32Array, 1], 5126: [Float32Array, 1] };
const readAccessor = (i) => {
  const a = json.accessors[i], [Type, max] = COMPONENT[a.componentType];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const bytes = viewBytes(a.bufferView), bv = json.bufferViews[a.bufferView];
  const stride = (bv.extensions?.EXT_meshopt_compression?.byteStride || bv.byteStride || size * Type.BYTES_PER_ELEMENT) / Type.BYTES_PER_ELEMENT;
  const arr = new Type(bytes.buffer, bytes.byteOffset + (a.byteOffset || 0), (a.count - 1) * stride + size);
  return (k, c) => { const v = arr[k * stride + c]; return a.normalized ? Math.max(v / max, -1) : v; };
};
// The transforms a node draws its mesh with: one, or one per GPU instance.
const placements = (i) => {
  const base = world(i), inst = json.nodes[i].extensions?.EXT_mesh_gpu_instancing?.attributes;
  if (!inst) return [base];
  const read = (k) => (inst[k] === undefined ? null : readAccessor(inst[k]));
  const t = read('TRANSLATION'), r = read('ROTATION'), s = read('SCALE');
  const n = json.accessors[inst.TRANSLATION ?? inst.ROTATION ?? inst.SCALE].count;
  return Array.from({ length: n }, (_, k) => base.clone().multiply(new THREE.Matrix4().compose(
    t ? new THREE.Vector3(t(k, 0), t(k, 1), t(k, 2)) : new THREE.Vector3(),
    r ? new THREE.Quaternion(r(k, 0), r(k, 1), r(k, 2), r(k, 3)).normalize() : new THREE.Quaternion(),
    s ? new THREE.Vector3(s(k, 0), s(k, 1), s(k, 2)) : new THREE.Vector3(1, 1, 1))));
};
// Every triangle of a node, in file space.
const triangles = (i) => {
  const out = [];
  for (const m of placements(i)) for (const p of json.meshes[json.nodes[i].mesh].primitives) {
    const pos = readAccessor(p.attributes.POSITION), count = json.accessors[p.attributes.POSITION].count;
    const v = Array.from({ length: count }, (_, k) => new THREE.Vector3(pos(k, 0), pos(k, 1), pos(k, 2)).applyMatrix4(m));
    if (p.indices === undefined) { for (let k = 0; k + 2 < count; k += 3) out.push([v[k], v[k + 1], v[k + 2]]); continue; }
    const idx = readAccessor(p.indices), n = json.accessors[p.indices].count;
    for (let k = 0; k + 2 < n; k += 3) out.push([v[idx(k, 0)], v[idx(k + 1, 0)], v[idx(k + 2, 0)]]);
  }
  return out;
};
const meshNodes = json.nodes.map((n, i) => i).filter((i) => json.nodes[i].mesh !== undefined);
const allTriangles = meshNodes.flatMap((i) => triangles(i));
const origin = new THREE.Vector3(...(markers.get('room-origin').translation || [0, 0, 0]));
assert.ok(markers.get('room-origin').children === undefined && parent[json.nodes.indexOf(markers.get('room-origin'))] === undefined,
  'the room origin is a root node, so its translation is its place in the file');

// The viewer stands the computer on the desk: it puts the room origin (the carpet
// centre) 0.72 m below the computer and 6 cm behind its centre. So the desk top
// must be a level surface 0.72 m above the origin across the computer's footprint
// (about 40 by 20 cm around that centre), and nothing may rise through it there.
{
  const height = (x, z) => {
    let best = null;
    for (const [a, b, c] of allTriangles) {
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.length() === 0) continue;
      n.normalize();
      if (Math.abs(n.y) < 0.9) continue;   // level surfaces only
      const d = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
      const u = ((b.x - x) * (c.z - z) - (c.x - x) * (b.z - z)) / d, w = ((c.x - x) * (a.z - z) - (a.x - x) * (c.z - z)) / d;
      if (u < 0 || w < 0 || u + w > 1) continue;
      const y = u * a.y + w * b.y + (1 - u - w) * c.y;
      const above = (y - origin.y) / UNITS_PER_M;
      if (above > 0.3 && above < 1.2 && n.y > 0 && (best === null || y > best)) best = y;
    }
    return best === null ? null : (best - origin.y) / UNITS_PER_M;
  };
  const cz = origin.z + 0.06 * UNITS_PER_M;
  for (const [dx, dz] of [[0, 0], [-0.2, -0.1], [0.2, -0.1], [-0.2, 0.1], [0.2, 0.1]]) {
    const h = height(origin.x + dx * UNITS_PER_M, cz + dz * UNITS_PER_M);
    assert.ok(h !== null && Math.abs(h - 0.72) <= 0.01,
      `the desk top is 0.72 m above the room origin under the computer (at ${dx * 100} cm, ${dz * 100} cm from its centre: ${h === null ? 'no surface' : `${h.toFixed(3)} m`})`);
  }
}

// Flat things hung on a wall need real depth between them and it: the depth
// buffer cannot tell a few millimetres apart at room distances (worst after the
// fullscreen framer pulls the near plane in), and the two flicker through each
// other. The world map keeps about 9 mm (0.07 file units at 8.0456 per metre)
// from any surface behind it at least as large as the map.
{
  const mapNode = json.nodes.findIndex((n) => n.name === 'World Map');
  assert.ok(mapNode >= 0 && json.nodes[mapNode].mesh !== undefined, 'the room model has the world map');
  const mapTris = triangles(mapNode);
  const map = new THREE.Box3(); for (const t of mapTris) for (const v of t) map.expandByPoint(v);
  const size = map.getSize(new THREE.Vector3());
  const axis = ['x', 'y', 'z'].reduce((m, k) => (size[k] < size[m] ? k : m), 'x');   // the map's thin axis
  const others = ['x', 'y', 'z'].filter((k) => k !== axis);
  const mapArea = size[others[0]] * size[others[1]];
  let gap = Infinity;
  for (const t of allTriangles) {
    const box = new THREE.Box3().setFromPoints(t), bs = box.getSize(new THREE.Vector3());
    if (bs[axis] > 1e-3) continue;                                                     // parallel to the map
    if (bs[others[0]] * bs[others[1]] / 2 < mapArea / 2) continue;                     // a large surface (a wall), not a pin or a label
    if (!others.every((k) => box.min[k] < map.max[k] && box.max[k] > map.min[k])) continue;   // behind the map's face
    const plane = box.min[axis];
    if (plane >= map.min[axis] - 1e-4 && plane <= map.max[axis] + 1e-4) continue;    // the map's own faces
    gap = Math.min(gap, Math.min(Math.abs(plane - map.min[axis]), Math.abs(plane - map.max[axis])));
  }
  assert.ok(Number.isFinite(gap), 'a wall stands behind the world map');
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

console.log('ok  - 80s bedroom: tagged markers and shadow opt-outs, no name lookups, desk at 0.72 m under the computer, lightmap UVs and scale, small version, no lights/cameras/transmission, follows 3D MODEL, last in the scene list, grain after SMAA');
