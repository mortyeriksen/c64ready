// Spec tests for the Foggy Spotlight floor model (public/models/spotlight_real.glb) and
// its scene: the file carries the markers and baked floor the scene reads, and
// nothing that would light the floor twice.

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'public/models/spotlight_real.glb');
if (!fs.existsSync(file)) {
  console.log('# SKIP public/models/spotlight_real.glb is not present');
  process.exit(0);
}
const glb = fs.readFileSync(file);
assert.equal(glb.readUInt32LE(0), 0x46546c67, 'the floor model is a binary glTF ("glTF" magic)');
assert.equal(glb.readUInt32LE(4), 2, 'the floor model is glTF 2.0');
assert.equal(glb.readUInt32LE(8), glb.length, 'the GLB header length matches the file');
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));

const node = (name) => json.nodes.find((n) => n.name === name);
for (const name of ['Floor', 'Light Key', 'Light Key Target']) assert.ok(node(name), `the floor model has the "${name}" node the scene reads`);
const x = node('Light Key').extras || {};
assert.ok(x.intensity > 0, 'the key light marker carries a positive intensity (candela)');
assert.ok(x.angle > 0 && x.angle < Math.PI / 2, 'the key light marker carries a spot half-angle under 90 degrees');
assert.ok(x.penumbra >= 0 && x.penumbra <= 1, 'the key light marker carries a penumbra in [0, 1] (three.js SpotLight range)');
assert.ok(Array.isArray(x.color) && x.color.length === 3, 'the key light marker carries an RGB colour');
const used = json.extensionsUsed || [];
assert.ok(!used.includes('KHR_lights_punctual'), 'the floor model carries no lights (the scene adds its own)');
assert.ok(!json.cameras, 'the floor model carries no cameras');
assert.ok(!used.includes('KHR_draco_mesh_compression') && !used.includes('EXT_meshopt_compression'), 'the floor model needs no mesh decoder (the scene gives its loader none)');

// The baked light is the floor's only diffuse term: black base colour, light in the emissive map.
const floor = json.meshes[node('Floor').mesh];
for (const prim of floor.primitives) {
  const m = json.materials[prim.material];
  const base = m.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
  assert.deepEqual(base.slice(0, 3), [0, 0, 0], 'the floor is black, so the live lamp adds no second pool on top of the baked one');
  assert.ok(m.emissiveTexture, 'the floor carries its baked light in the emissive map');
  assert.ok(m.normalTexture && m.pbrMetallicRoughness?.metallicRoughnessTexture, 'the floor carries roughness and normal maps for the live glints');
}
assert.ok(glb.length < 512 * 1024, 'the floor model stays under 512 KiB (the detail is a tile, only the light is unique)');
// The floor's detail maps repeat a seamless tile; the baked light does not.
{
  const m = json.materials.find((x) => x.emissiveTexture);
  const repeat = (t) => t?.extensions?.KHR_texture_transform?.scale || [1, 1];
  assert.ok(repeat(m.normalTexture)[0] > 1 && repeat(m.pbrMetallicRoughness.metallicRoughnessTexture)[0] > 1, 'the floor\'s normal and roughness maps are tiles repeated across it');
  assert.deepEqual(repeat(m.emissiveTexture), [1, 1], 'the baked light covers the floor once');
  assert.ok((json.samplers || []).every((s) => (s.wrapS ?? 10497) === 10497 && (s.wrapT ?? 10497) === 10497), 'the tiles wrap (REPEAT)');
}
assert.ok(node('Lamp Fixture'), 'the floor model carries the hanging lamp');

// Every texture points at an image in the file (an export with a missing
// source image leaves a texture with none, and GLTFLoader then fails the file).
const texturesComplete = (j) => (j.textures || []).every((t) => {
  const src = t.extensions?.EXT_texture_webp?.source ?? t.source;
  return Number.isInteger(src) && src >= 0 && src < (j.images || []).length;
});
assert.ok(texturesComplete(json), 'every texture in the floor model has its image');

// The phone build: the same nodes, lighter maps.
const small = path.join(root, 'public/models/spotlight_real_small.glb');
assert.ok(fs.existsSync(small), 'the phone build public/models/spotlight_real_small.glb ships with the floor model');
const sj = JSON.parse(fs.readFileSync(small).subarray(20, 20 + fs.readFileSync(small).readUInt32LE(12)).toString('utf8'));
for (const name of ['Floor', 'Light Key', 'Light Key Target', 'Lamp Fixture']) assert.ok(sj.nodes.some((n) => n.name === name), `the phone build has the "${name}" node too`);
assert.ok(fs.statSync(small).size < glb.length, 'the phone build is lighter than the full one');
assert.ok(texturesComplete(sj), 'every texture in the phone build has its image');

// The light probe: a Radiance HDR equirect, the scene's environment, one for both builds.
for (const [name, width] of [['spotlight_real_env.hdr', 512]]) {
  const probe = path.join(root, 'public/models', name);
  assert.ok(fs.existsSync(probe), `the light probe public/models/${name} ships with the floor model`);
  const head = fs.readFileSync(probe).subarray(0, 512).toString('latin1');
  assert.match(head, /^#\?(RADIANCE|RGBE)/, `${name} is a Radiance HDR file (what HDRLoader reads)`);
  const size = head.match(/-Y (\d+) \+X (\d+)/);
  assert.ok(size && Number(size[2]) === 2 * Number(size[1]) && Number(size[2]) === width, `${name} is a ${width} px 2:1 equirect`);
}
const sw = fs.readFileSync(path.join(root, 'src/sw.js'), 'utf8');
assert.match(sw, /url\.pathname\.startsWith\('\/models\/'\)/, 'the service worker caches everything under /models/, the light probes included, with the models');

const viewer = fs.readFileSync(path.join(root, 'src/vibes/retrovibes.js'), 'utf8');
assert.match(viewer, /const SCENES = \[[^\]]*sceneSpotlight, sceneSpotlightReal, sceneIkplus/, 'Foggy Spotlight follows Spotlight in the scene list');

// Smoke: the scene asks for it, and the pass sizes and scales itself to the model.
const sceneSrc = fs.readFileSync(path.join(root, 'src/vibes/vibes-scene-spotlight-real.js'), 'utf8');
assert.match(sceneSrc, /volume: \{[^}]*density/, 'Foggy Spotlight asks the viewer for smoke in its beam');
assert.match(sceneSrc, /userData\.volumeLight = key/, 'Foggy Spotlight hands the smoke pass its key light');
assert.match(viewer, /target\.depthTexture = new THREE\.DepthTexture/, 'the composer keeps the scene depth the smoke stops at');
const { VolumePass } = await import('../src/vibes/vibes-volume-pass.js');
const vol = new VolumePass();
vol.setSize(1280, 800);
assert.deepEqual([vol.target.width, vol.target.height], [640, 400], 'the smoke marches at half resolution');
vol.setSize(2560, 1600);
assert.deepEqual([vol.target.width, vol.target.height], [800, 500], 'the smoke march is never wider than 800 px, whatever the pixel density');
vol.configure({ density: 0.03, scale: 0.06, steps: 200, ground: 2.5, groundHeight: 0.5 }, 10, -1);
assert.ok(Math.abs(vol.uniforms.uSigma.value - 0.003) < 1e-12, 'smoke density is per model radius');
assert.ok(Math.abs(vol.uniforms.uGroundH.value - 5) < 1e-12, 'the settling layer height is per model radius');
assert.equal(vol.uniforms.uFloorY.value, -1, 'the settling layer starts at the floor');
assert.equal(vol.uniforms.uSteps.value, 64, 'the march is capped at the shader loop bound of 64 steps');
assert.equal(vol.screenGlow, 1, 'the screen lights the smoke at its physical share unless a scene asks for more');
vol.configure({ density: 0.03, screenGlow: 4 }, 10, 0);
assert.equal(vol.screenGlow, 4, 'a scene can strengthen the screen\'s glow in the smoke');
assert.match(viewer, /_volPass\.screen = this\._sceneGroup\?\.userData\.crtGlow/, 'the viewer hands the smoke pass the scene\'s screen light');
vol.dispose();

console.log('ok  - spotlight real: markers, black baked floor, no lights/cameras/decoders, lamp, phone build, light probes, smoke, after Spotlight in the scene list');
