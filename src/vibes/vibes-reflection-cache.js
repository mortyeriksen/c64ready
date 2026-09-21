// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Wave shading runs at display cadence; the offscreen scene refreshes at 30 Hz.
// XR and projection changes require a fresh reflection for the current camera.
export function cacheWaterReflection(water, excluded) {
  const render = water.onBeforeRender;
  const visibility = new Array(excluded.length);
  const state = { time: 0, lastTime: -Infinity, camera: null, projection: new Float64Array(16) };
  water.onBeforeRender = function (renderer, scene, camera) {
    let changed = state.camera !== camera;
    const projection = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (state.projection[i] !== projection[i]) changed = true;
    }
    const elapsed = state.time - state.lastTime;
    if (!changed && !renderer.xr.isPresenting && elapsed >= 0 && elapsed < 1 / 30 - 1e-9) {
      water.material.uniforms.eye.value.setFromMatrixPosition(camera.matrixWorld);
      return;
    }
    state.camera = camera;
    state.projection.set(projection);
    state.lastTime = state.time;
    for (let i = 0; i < excluded.length; i++) {
      visibility[i] = excluded[i].visible;
      excluded[i].visible = false;
    }
    try {
      render.call(this, renderer, scene, camera);
    } finally {
      for (let i = 0; i < excluded.length; i++) excluded[i].visible = visibility[i];
    }
  };
  return state;
}
