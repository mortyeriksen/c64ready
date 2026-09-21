import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShadowCache } from '../src/vibes/vibes-shadow-cache.js';
import { cacheWaterReflection } from '../src/vibes/vibes-reflection-cache.js';
import { scene as starry } from '../src/vibes/vibes-scene-starry.js';

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

console.log('ok  - Retro Vibes render caches');
