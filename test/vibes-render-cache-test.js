import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShadowCache, ShadowThrottle } from '../src/vibes/vibes-shadow-cache.js';
import { cacheWaterReflection } from '../src/vibes/vibes-reflection-cache.js';
import { scene as starry } from '../src/vibes/vibes-scene-starry.js';
import { mergeStatic } from '../src/vibes/vibes-scene-common.js';

{
  const scene = new THREE.Scene(), parent = new THREE.Group();
  const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  caster.castShadow = true; parent.add(caster); scene.add(parent);
  const light = new THREE.SpotLight(); light.castShadow = true; scene.add(light, light.target);
  const dust = new THREE.Points(), camera = new THREE.PerspectiveCamera(); scene.add(dust, camera);
  const cache = new ShadowCache(scene);
  assert.equal(cache.update(), true, 'freshly built scenes require shadow maps');
  assert.equal(cache.update(), false, 'unchanged geometry reuses shadow maps');
  dust.position.x++; camera.position.z++; light.intensity++;
  assert.equal(cache.update(), false, 'camera, non-casting effects and light intensity do not change shadow geometry');
  caster.position.y++;
  assert.equal(cache.update(), true, 'moving a caster invalidates its shadows');
  assert.equal(cache.update(), false, 'stationary casters settle back to cached shadows');
  parent.rotation.z += 0.1;
  assert.equal(cache.update(), true, 'moving a caster ancestor invalidates shadows');
  caster.geometry.attributes.position.needsUpdate = true;
  assert.equal(cache.update(), true, 'vertex changes invalidate shadows');
  // A mesh whose vertices move too little to show in its shadow says so
  // (the keyboard's caps sink by a few hundredths of a unit).
  caster.userData.steadyShadow = true;
  cache.update();
  caster.geometry.attributes.position.needsUpdate = true;
  assert.equal(cache.update(), false, 'vertex changes on a mesh with a steady shadow keep the cached maps');
  caster.position.x++;
  assert.equal(cache.update(), true, 'moving such a mesh still invalidates them');
  caster.userData.steadyShadow = false;
  cache.update();
  light.target.position.z++;
  assert.equal(cache.update(), true, 'moving the shadow light target invalidates shadows');
  light.position.y++;
  assert.equal(cache.update(), true, 'moving a shadow light invalidates shadows');
  caster.visible = false;
  assert.equal(cache.update(), true, 'hiding geometry clears its shadow');
  caster.geometry = new THREE.BoxGeometry(2, 2, 2);
  assert.equal(cache.update(), true, 'replacing geometry invalidates shadows');
  const newParent = new THREE.Group(); scene.add(newParent); newParent.add(caster);
  assert.equal(cache.update(), true, 'reparenting geometry rebuilds shadow dependencies');
  cache.update();
  newParent.position.z++;
  assert.equal(cache.update(), true, 'a new caster ancestor remains tracked');
  parent.removeFromParent();
  scene.remove(newParent);
  assert.equal(cache.update(), true, 'removing casting geometry clears its shadow');
}

{
  const camera = new THREE.PerspectiveCamera(), renderer = { xr: { isPresenting: false } };
  const hidden = { visible: false }, visible = { visible: true };
  let renders = 0;
  const water = { material: { uniforms: { eye: { value: new THREE.Vector3() } } }, onBeforeRender() {
    assert.equal(visible.visible, false, 'excluded sky geometry stays out of the reflection');
    renders++;
  } };
  const state = cacheWaterReflection(water, [hidden, visible]);
  for (let i = 0; i < 60; i++) {
    state.time = i / 60;
    water.onBeforeRender(renderer, null, camera);
  }
  assert.equal(renders, 30, 'a 60 Hz display refreshes water reflections at 30 Hz');
  camera.position.set(2, 3, 4); camera.updateMatrixWorld();
  water.onBeforeRender(renderer, null, camera);
  assert.ok(water.material.uniforms.eye.value.equals(camera.position), 'water shading follows camera movement between reflection updates');
  assert.equal(hidden.visible, false, 'reflection rendering preserves already hidden geometry');
  assert.equal(visible.visible, true, 'reflection rendering restores visible geometry');
  camera.aspect = 2; camera.updateProjectionMatrix();
  water.onBeforeRender(renderer, null, camera);
  assert.equal(renders, 31, 'projection changes invalidate the reflection immediately');
  renderer.xr.isPresenting = true;
  water.onBeforeRender(renderer, null, camera); water.onBeforeRender(renderer, null, camera);
  assert.equal(renders, 33, 'XR refreshes reflections for each eye render');
  renderer.xr.isPresenting = false; state.time = 0;
  water.onBeforeRender(renderer, null, camera);
  assert.equal(renders, 34, 'restarting the scene clock refreshes the reflection');
}

{
  // prerender: the refresh runs before the main render (three's depth-0 light
  // state), and the in-render hook then has nothing left to do that frame.
  const camera = new THREE.PerspectiveCamera(), renderer = { xr: { isPresenting: false } };
  let renders = 0, inside = false;
  const water = new THREE.Object3D();
  water.material = { uniforms: {} };
  water.onBeforeRender = () => { renders++; if (inside) assert.fail('the mirror refreshes before the main render, not inside it'); };
  const state = cacheWaterReflection(water, []);
  camera.position.set(1, 2, 3);
  for (let i = 0; i < 60; i++) {
    state.time = i / 60;
    state.prerender(renderer, null, camera);
    inside = true; water.onBeforeRender(renderer, null, camera); inside = false;
  }
  assert.equal(renders, 30, 'prerendered reflections still refresh at 30 Hz');
  assert.ok(camera.matrixWorld.elements[13] === 2, 'prerender brings the camera\'s world matrix up to date first');
  renderer.xr.isPresenting = true;
  state.prerender(renderer, null, camera);
  assert.equal(renders, 30, 'XR leaves the refresh to each eye\'s render');
}

{
  const group = new THREE.Group();
  starry.build(group, { sphere: new THREE.Sphere(new THREE.Vector3(), 2), box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) });
  const d = group.userData.starry, m = d.meteor, geometry = m.obj.geometry, material = m.mat;
  let disposals = 0;
  geometry.addEventListener('dispose', () => disposals++); material.addEventListener('dispose', () => disposals++);
  const children = m.obj.parent.children.length;
  for (let n = 0; n < 20; n++) {
    d.spawn();
    assert.equal(m.obj.visible, true, 'pooled meteors become visible on spawn');
    assert.equal(m.life, 0, 'respawn resets meteor age');
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const radius = Math.hypot(...geometry.attributes.position.array.subarray(i * 3, i * 3 + 3));
      assert.ok(radius <= geometry.boundingSphere.radius, 'the pooled tail stays inside its culling sphere');
    }
    d.nextMeteor = 100;
    for (let i = 0; i < 120; i++) starry.animate(group, n * 2 + i / 60);
    assert.equal(m.obj.visible, false, 'expired meteors return to the hidden pool');
  }
  assert.equal(m.obj.geometry, geometry, 'meteor spawns reuse their vertex buffer');
  assert.equal(m.obj.material, material, 'meteor spawns reuse their material');
  assert.equal(disposals, 0, 'meteor lifetimes do not churn GPU resources');
  assert.equal(m.obj.parent.children.length, children, 'meteor lifetimes do not churn scene membership');
}

{
  // mergeStatic: still, opaque meshes fold into one draw per material and
  // shadow setup, in place; whatever animates or blends stays its own mesh.
  const root = new THREE.Group(); root.position.set(5, 0, 0); root.scale.setScalar(2);
  const stone = new THREE.MeshStandardMaterial(), glass = new THREE.MeshBasicMaterial({ transparent: true });
  const box = (m, x, y = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(), m); b.position.set(x, y, 0); return b; };
  const sub = new THREE.Group(); sub.position.y = 3; sub.rotation.z = 0.4;
  const a = box(stone, 0), b = box(stone, 2), c = box(stone, 4), deep = box(stone, 1); sub.add(deep);
  const caster = box(stone, 6); caster.castShadow = true;
  const pane = box(glass, 8), bird = box(stone, 10), wing = box(stone, 1); bird.add(wing);
  root.add(a, b, c, sub, caster, pane, bird);
  const world = new THREE.Box3();
  for (const m of [a, b, c, deep]) { m.updateWorldMatrix(true, false); world.union(new THREE.Box3().setFromObject(m, true)); }
  assert.equal(mergeStatic(root, [bird]), 4, 'four still stone meshes in one shadow setup merge');
  const meshes = []; root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const merged = meshes.filter((m) => m.geometry.attributes.position.count === 4 * 24);
  assert.equal(merged.length, 1, 'one draw per material and shadow setup');
  merged[0].updateWorldMatrix(true, false);
  const got = new THREE.Box3().setFromObject(merged[0], true);
  assert.ok(got.min.distanceTo(world.min) < 1e-5 && got.max.distanceTo(world.max) < 1e-5, 'merged geometry keeps every mesh where it was, nested transforms included (to float32 precision)');
  assert.ok(meshes.includes(caster) && caster.castShadow, 'a different shadow setup stays apart');
  assert.ok(meshes.includes(pane), 'transparent meshes keep their own draw, for sorting');
  assert.ok(meshes.includes(bird) && meshes.includes(wing), 'animated objects and their children stay as they are');
  assert.equal(merged[0].material, stone, 'the merged mesh shares the original material');
}

{
  // ShadowThrottle: slow casters refresh their shadow maps at a fixed rate.
  const throttle = new ShadowThrottle(10);
  let refreshes = 0;
  for (let i = 0; i < 60; i++) if (throttle.update(100 + i / 60)) refreshes++;
  assert.equal(refreshes, 10, 'a 10 Hz throttle refreshes shadows 10 times over 60 frames a second');
  assert.equal(new ShadowThrottle(10).update(0), true, 'the first frame always draws its shadows');
  assert.equal(throttle.update(3), true, 'a clock that runs backwards (scene restart) refreshes at once');
  const ik = (await import('../src/vibes/vibes-scene-ikplus.js')).scene;
  assert.ok(ik.shadowHz > 0 && ik.shadowHz < 60 && !ik.staticShadows, 'IK+ refreshes its shadows below display rate: only the maple sways');
}

{
  // A water mirror may refresh slower than 30 Hz, as IK+ asks on low-power devices.
  const camera = new THREE.PerspectiveCamera(), renderer = { xr: { isPresenting: false } };
  let renders = 0;
  const water = { material: { uniforms: {} }, onBeforeRender() { renders++; } };
  const state = cacheWaterReflection(water, [], 15);
  for (let i = 0; i < 60; i++) { state.time = i / 60; water.onBeforeRender(renderer, null, camera); }
  assert.equal(renders, 15, 'a 15 Hz mirror refreshes 15 times over 60 frames a second');
  const ik = await import('../src/vibes/vibes-scene-ikplus.js');
  const desk = ik.waterMirror({ fine: true, lowPower: false }), phone = ik.waterMirror({ fine: false, lowPower: true });
  assert.deepEqual(desk, { size: 1024, hz: 30 }, 'a computer keeps the sharp 30 Hz water mirror');
  assert.ok(phone.size < desk.size && phone.hz === 15, 'a low-power device gets a smaller mirror, refreshed at 15 Hz');
}

{
  // Keycaps: a press re-uploads only the moved cap's vertices, and the
  // keyboard's shadow is steady while its caps sink.
  const { attachKeycapPresses } = await import('../src/vibes/keycap-press.js');
  const positions = new Float32Array(300 * 3);
  for (let i = 0; i < 300; i++) { positions[i * 3] = 50 + i; positions[i * 3 + 2] = 50; }     // off the keyboard
  for (let i = 120; i < 126; i++) { positions[i * 3] = -0.88; positions[i * 3 + 1] = 1; positions[i * 3 + 2] = 0.83; }   // the "1" key
  for (let i = 200; i < 204; i++) { positions[i * 3] = 2.14; positions[i * 3 + 1] = 1; positions[i * 3 + 2] = 1.22; }    // RETURN
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const keyboard = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const down = new Set();
  const had = globalThis.window;
  globalThis.window = { c64: { isKeyDown: (c, r) => down.has(`${c},${r}`) } };
  try {
    const caps = attachKeycapPresses(keyboard);
    assert.equal(keyboard.userData.steadyShadow, true, 'the keyboard\'s shadow is steady under its moving caps');
    const attr = geometry.attributes.position, v0 = attr.version;
    caps.update();
    assert.equal(attr.version, v0, 'with no key down nothing is uploaded');
    down.add('7,0');
    caps.update();
    assert.ok(attr.version > v0, 'a pressed key moves its cap');
    assert.ok(attr.getY(122) < 1 && attr.getY(0) === 0 && attr.getY(201) === 1, 'and only its cap');
    assert.deepEqual(attr.updateRanges, [{ start: 120 * 3, count: 6 * 3 }], 'only that cap\'s vertices are uploaded');
    attr.clearUpdateRanges();   // as the renderer does once it has uploaded them
    down.add('0,1');
    caps.update();
    assert.deepEqual(attr.updateRanges, [{ start: 120 * 3, count: 6 * 3 }, { start: 200 * 3, count: 4 * 3 }], 'two moving caps upload two ranges');
  } finally { globalThis.window = had; }
}

{
  // Render targets a scene's shaders hold are freed with the scene: three's
  // Water keeps its mirror target to itself, and Starry Plain bakes its sky.
  const { disposeRenderTargets } = await import('../src/vibes/vibes-scene-common.js');
  const { Water } = await import('three/examples/jsm/objects/Water.js');
  const water = new Water(new THREE.PlaneGeometry(1, 1), { textureWidth: 64, textureHeight: 64, waterNormals: new THREE.Texture() });
  const target = water.material.uniforms.mirrorSampler.value.renderTarget;
  assert.ok(target?.isWebGLRenderTarget, 'the water\'s mirror texture leads to its target');
  let freed = 0;
  target.addEventListener('dispose', () => freed++);
  const shared = new THREE.WebGLRenderTarget(4, 4);
  shared.texture._shared = true;
  shared.addEventListener('dispose', () => assert.fail('a shared texture\'s target outlives the scene'));
  water.material.uniforms.keep = { value: shared.texture };
  disposeRenderTargets(water);
  assert.equal(freed, 1, 'the water\'s mirror target is freed');
  disposeRenderTargets(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));   // nothing to free
}

{
  // Starry Plain's Milky Way does not change, so it is drawn once into a
  // texture and looked up from then on.
  const { disposeRenderTargets } = await import('../src/vibes/vibes-scene-common.js');
  const group = new THREE.Group();
  starry.build(group, { sphere: new THREE.Sphere(new THREE.Vector3(), 2), box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) });
  const dome = group.userData.starry.milkyWay;
  assert.ok(dome?.isMesh, 'the scene names its Milky Way dome');
  assert.ok(!/\bfbm\s*\(/.test(dome.material.fragmentShader), 'the dome\'s own shader computes no noise');
  const outer = {}, draws = [];
  const renderer = {
    target: outer, xr: { enabled: true },
    getRenderTarget() { return this.target; }, setRenderTarget(t) { this.target = t; },
    render(object) { draws.push(this.target); }, clear() {},
  };
  const camera = new THREE.PerspectiveCamera();
  dome.onBeforeRender(renderer, null, camera);
  assert.equal(draws.length, 1, 'the first frame draws the sky once');
  const sky = dome.material.uniforms.uSky.value;
  assert.ok(draws[0]?.isWebGLRenderTarget && draws[0].texture === sky, 'into the texture the dome reads');
  assert.equal(renderer.target, outer, 'and leaves the renderer drawing where it was');
  assert.equal(renderer.xr.enabled, true, 'with XR as it was');
  for (let i = 0; i < 5; i++) dome.onBeforeRender(renderer, null, camera);
  assert.equal(draws.length, 1, 'later frames only look it up');
  let freed = 0;
  sky.renderTarget.addEventListener('dispose', () => freed++);
  disposeRenderTargets(dome);
  assert.equal(freed, 1, 'the baked sky is freed with the scene');
}

console.log('ok  - Retro Vibes render caches');
