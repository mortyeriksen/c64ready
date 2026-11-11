// The Retro Vibes view's last image stage (src/vibes/vibes-grade.js): the
// grade (aberration, vignette, split tone, grain), on its own after three's
// OutputPass, or merged with tone mapping and the colour space conversion in
// one fullscreen pass for a low-power device, where LeanComposer draws the
// scene once into one multisampled target and that pass onto the canvas.
//
//   1. The merged pass maps tone and colour space exactly as three's
//      OutputPass does, for every tone mapping the renderer can be set to.
//   2. Both shaders run one and the same grade.
//   3. LeanComposer draws the scene into its target, then the canvas, and
//      nothing else. Its target is multisampled and sized by the pixel ratio.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { OutputShader } from 'three/examples/jsm/shaders/OutputShader.js';
import { GradeShader, GRADE_BODY, OutputGradePass, LeanComposer } from '../src/vibes/vibes-grade.js';

// A renderer that records what it is asked to draw, and into what.
function recorder() {
  const r = {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    target: null, draws: [],
    getRenderTarget() { return this.target; },
    setRenderTarget(t) { this.target = t; },
    render(object) { this.draws.push({ target: this.target, object }); },
    clear() {},
  };
  return r;
}

// ── 1. Tone mapping and colour space, as OutputPass ──────────────────────────
{
  const tones = ['NoToneMapping', 'LinearToneMapping', 'ReinhardToneMapping', 'CineonToneMapping', 'ACESFilmicToneMapping', 'AgXToneMapping', 'NeutralToneMapping'];
  for (const tone of tones) {
    for (const space of [THREE.SRGBColorSpace, THREE.LinearSRGBColorSpace]) {
      const r = recorder();
      r.toneMapping = THREE[tone]; r.outputColorSpace = space; r.toneMappingExposure = 1.2;
      const theirs = new OutputPass(), ours = new OutputGradePass();
      const read = { texture: new THREE.Texture() };
      theirs.renderToScreen = true; theirs.render(r, null, read);
      ours.render(r, read);
      assert.deepEqual(ours.material.defines, theirs.material.defines, `${tone} in ${space}: the same shader switches as OutputPass`);
      assert.equal(ours.uniforms.toneMappingExposure.value, 1.2, `${tone}: the renderer's exposure`);
      assert.equal(ours.uniforms.tDiffuse.value, read.texture, `${tone}: reads the buffer it is given`);
    }
  }
  // Every switch three's shader knows is one the merged shader acts on.
  const switches = [...new Set(OutputShader.fragmentShader.match(/\b[A-Z_]+_TONE_MAPPING\b|\bSRGB_TRANSFER\b/g))];
  assert.ok(switches.length >= 7, 'three\'s output shader names its switches');
  for (const name of switches) assert.ok(new OutputGradePass().material.fragmentShader.includes(name), `the merged shader handles ${name}`);
  console.log('ok  - test 1: the merged pass maps tone and colour space as OutputPass does');
}

// ── 2. One grade ─────────────────────────────────────────────────────────────
{
  const merged = new OutputGradePass();
  assert.ok(GRADE_BODY.length > 100, 'the grade is a body of shader code');
  assert.ok(GradeShader.fragmentShader.includes(GRADE_BODY), 'the grade pass runs it');
  assert.ok(merged.material.fragmentShader.includes(GRADE_BODY), 'the merged pass runs the same');
  for (const name of Object.keys(GradeShader.uniforms)) {
    assert.ok(name in merged.uniforms, `the merged pass takes the grade's ${name}`);
  }
  merged.uniforms.uSplitShadow.value.set(0.5, 0.5, 0.5);
  assert.deepEqual(GradeShader.uniforms.uSplitShadow.value.toArray(), [1, 1, 1], 'each pass owns its uniform values');
  console.log('ok  - test 2: the grade pass and the merged pass share one grade');
}

// ── 3. LeanComposer ──────────────────────────────────────────────────────────
{
  const r = recorder();
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const lean = new LeanComposer(r, scene, camera);
  lean.setPixelRatio(1.5);
  lean.setSize(400, 300);
  assert.equal(lean.readBuffer.samples, 4, 'the scene is drawn multisampled');
  assert.equal(lean.readBuffer.texture.type, THREE.HalfFloatType, 'in a buffer that holds light above 1.0 until it is tone mapped');
  assert.ok(lean.readBuffer.depthBuffer, 'with depth');
  assert.equal(lean.readBuffer.width, 600, 'sized by the pixel ratio');
  assert.equal(lean.readBuffer.height, 450);

  const outer = {};
  r.target = outer;
  lean.render();
  assert.equal(r.draws.length, 2, 'a frame is two draws');
  assert.equal(r.draws[0].object, scene, 'the scene');
  assert.equal(r.draws[0].target, lean.readBuffer, 'into the buffer');
  assert.equal(r.draws[1].target, null, 'then the canvas');
  assert.equal(r.draws[1].object.material, lean.grade.material, 'through the merged pass');
  assert.equal(lean.grade.uniforms.tDiffuse.value, lean.readBuffer.texture, 'which reads the buffer');
  assert.equal(r.target, outer, 'and the renderer is left drawing where it was');

  assert.ok(Array.isArray(lean.passes) && lean.passes.includes(lean.grade), 'its one pass is listed, for whoever frees passes');
  let freed = 0;
  lean.readBuffer.addEventListener('dispose', () => freed++);
  lean.grade.material.addEventListener('dispose', () => freed++);
  lean.dispose(); lean.grade.dispose();
  assert.equal(freed, 2, 'the buffer and the pass material are freed');
  console.log('ok  - test 3: LeanComposer draws the scene once and the canvas once');
}

console.log('\nok - vibes grade: 3 checks');
