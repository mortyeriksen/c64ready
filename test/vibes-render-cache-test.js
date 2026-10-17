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
  assert.equal(cache.update(), true, 'vertex changes such as keycap presses invalidate shadows');
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

console.log('ok  - Retro Vibes render caches');
