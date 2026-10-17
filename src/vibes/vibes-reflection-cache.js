// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Wave shading runs at display cadence; the offscreen scene refreshes at 30 Hz.
// XR and projection changes require a fresh reflection for the current camera.
// Works for three's Water and Reflector alike (only Water has an eye uniform).
//
// prerender() refreshes before the main render instead of inside it. three
// keeps a light state per render nesting depth, so a mirror drawn inside the
// main render makes every lit material look stale and rebuild its program
// parameters on each switch. At depth 0 both passes share one light state.
export function cacheWaterReflection(water, excluded) {
  const render = water.onBeforeRender;
  const visibility = new Array(excluded.length);
  const state = { time: 0, lastTime: -Infinity, camera: null, projection: new Float64Array(16), prerender };
  const due = (renderer, camera) => {
    if (state.camera !== camera || renderer.xr.isPresenting) return true;
    const projection = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (state.projection[i] !== projection[i]) return true;
    }
    const elapsed = state.time - state.lastTime;
    return !(elapsed >= 0 && elapsed < 1 / 30 - 1e-9);
  };
  const refresh = (renderer, scene, camera) => {
    state.camera = camera;
    state.projection.set(camera.projectionMatrix.elements);
    state.lastTime = state.time;
    for (let i = 0; i < excluded.length; i++) {
      visibility[i] = excluded[i].visible;
      excluded[i].visible = false;
    }
    try {
      render.call(water, renderer, scene, camera);
    } finally {
      for (let i = 0; i < excluded.length; i++) excluded[i].visible = visibility[i];
    }
  };
  water.onBeforeRender = function (renderer, scene, camera) {
    if (due(renderer, camera)) { refresh(renderer, scene, camera); return; }
    const eye = water.material.uniforms.eye;
    if (eye) eye.value.setFromMatrixPosition(camera.matrixWorld);
  };
  // The mirror reads its own and the camera's world matrices, which the main
  // render has not updated yet this frame.
  function prerender(renderer, scene, camera) {
    if (renderer.xr.isPresenting || !due(renderer, camera)) return;
    camera.updateWorldMatrix(true, false);
    water.updateWorldMatrix(true, false);
    refresh(renderer, scene, camera);
  }
  return state;
}
