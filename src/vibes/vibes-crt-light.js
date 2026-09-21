// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

RectAreaLightUniformsLib.init();

// Area-light intensity describes luminance, so scaling the glass and its
// surroundings together preserves the illumination without an R² multiplier.
export function addCrtLight(group, screen, strength) {
  if (!screen) return;
  const light = new THREE.RectAreaLight(0xffffff, 0, screen.width * 1.02, screen.height * 0.94);
  light.position.copy(screen.center).addScaledVector(screen.normal, -screen.height * 0.035);
  light.lookAt(screen.center.clone().add(screen.normal));
  group.add(light);
  group.userData.crtGlow = light;
  group.userData.crtColorTarget = new THREE.Color(1, 1, 1);
  group.userData.crtStrength = strength;
  group.userData.crtLastTime = null;
}

// Smooth sampled framebuffer changes using elapsed time; all scratch state is
// allocated with the light, keeping scene animation allocation-free.
export function animateCrtLight(group, time, powered, sample) {
  const state = group.userData, light = state.crtGlow;
  if (!light) return;
  const dt = Math.min(0.1, Math.max(0, time - (state.crtLastTime ?? time)));
  state.crtLastTime = time;
  const active = powered && sample?.active;
  const peak = active ? Math.max(sample.r, sample.g, sample.b) : 0;
  const intensity = active ? Math.sqrt(sample.luminance) * state.crtStrength : 0;
  if (peak > 1e-6) {
    // Neutral scattering in the glass softens fully saturated picture colours.
    const wash = 0.10;
    state.crtColorTarget.setRGB(
      wash + (1 - wash) * sample.r / peak,
      wash + (1 - wash) * sample.g / peak,
      wash + (1 - wash) * sample.b / peak,
    );
  }
  const blend = 1 - Math.exp(-dt * 7);
  light.color.lerp(state.crtColorTarget, blend);
  light.intensity += (intensity - light.intensity) * blend;
}
