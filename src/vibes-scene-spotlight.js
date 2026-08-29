// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { overheadSpot, floorPlane, canvasTexture, markShared } from './vibes-scene-common.js';

RectAreaLightUniformsLib.init();

let _floorRoughness = null;
function floorRoughness() {
  if (_floorRoughness) return _floorRoughness;
  const tex = canvasTexture(128, (ctx, size) => {
    const image = ctx.createImageData(size, size);
    let seed = 0x51f15e;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = 222 + ((seed >>> 27) & 25);
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, 18, 18);
  if (tex) tex.colorSpace = THREE.NoColorSpace;
  _floorRoughness = markShared(tex);
  return _floorRoughness;
}

function addBeamDust(g, spot, sphere) {
  const count = 64, positions = new Float32Array(count * 3), seeds = new Float32Array(count);
  const direction = spot.target.position.clone().sub(spot.position);
  const length = direction.length(); direction.normalize();
  const side = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 0, 1)).normalize();
  const across = new THREE.Vector3().crossVectors(direction, side).normalize();
  let seed = 0x5f3759df;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let i = 0; i < count; i++) {
    const t = 0.12 + random() * 0.82;
    const radius = Math.tan(spot.angle * 0.72) * length * t * Math.sqrt(random());
    const angle = random() * Math.PI * 2;
    const p = spot.position.clone().addScaledVector(direction, length * t)
      .addScaledVector(side, Math.cos(angle) * radius)
      .addScaledVector(across, Math.sin(angle) * radius);
    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
    seeds[i] = random() * 20;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uTime: { value: 0 }, uSize: { value: sphere.radius * 0.010 } },
    vertexShader: `attribute float aSeed; uniform float uTime,uSize; varying float vAlpha;
      void main(){
        vec3 p=position;
        p.x+=sin(uTime*0.19+aSeed)*uSize*2.5;
        p.z+=cos(uTime*0.13+aSeed*1.7)*uSize*2.0;
        vec4 mv=modelViewMatrix*vec4(p,1.0);
        gl_PointSize=clamp(uSize*520.0/max(0.2,-mv.z),1.0,4.0);
        vAlpha=0.08+0.08*sin(aSeed*3.1);
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: `varying float vAlpha; void main(){
      float d=length(gl_PointCoord-0.5);
      float a=(1.0-smoothstep(0.12,0.5,d))*vAlpha;
      gl_FragColor=vec4(1.0,0.88,0.70,a);
    }`,
  });
  const dust = new THREE.Points(geometry, material);
  dust.frustumCulled = false;
  g.add(dust); g.userData.spotDust = dust;
}

export const scene = {
    name: 'Spotlight', css: 'scene-spotlight', envInt: 0.0,
    bg: [[0, '#0b0b10'], [0.55, '#060608'], [1, '#000000']],
    bloom: { strength: 0.12, radius: 0.5, threshold: 0.9 },   // near-off: the screen must not glow
    build(g, { sphere, box, screen }) {
      // The faint fill represents bounce from the one overhead source, not a
      // second visible light; it keeps shadow faces from collapsing to black.
      g.add(new THREE.HemisphereLight(0x161722, 0x120d08, 0.055));
      const key = overheadSpot(0xfff0d8, 3.6, sphere, 0.86);
      g.add(key, key.target);
      addBeamDust(g, key, sphere);

      const floor = floorPlane(sphere, box, 0x111114, 0.94, 0);
      floor.material.roughnessMap = floorRoughness();
      g.add(floor);
      // A transparent receiver doubles only the cast-shadow contribution,
      // preserving the matte floor while giving feet and cables firmer contact.
      const contact = new THREE.Mesh(
        new THREE.PlaneGeometry(sphere.radius * 20, sphere.radius * 20),
        new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.24 }),
      );
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(sphere.center.x, box.min.y + sphere.radius * 0.0015, sphere.center.z);
      contact.receiveShadow = true; g.add(contact);

      // The CRT is an area emitter facing out from the glass. Its colour and
      // luminance track a coarse linear-light sample of the actual VIC picture.
      if (screen) {
        const glow = new THREE.RectAreaLight(0xffffff, 0, screen.width * 1.02, screen.height * 0.94);
        glow.position.copy(screen.center).addScaledVector(screen.normal, -screen.height * 0.035);
        glow.lookAt(screen.center.clone().add(screen.normal));
        g.add(glow);
        g.userData.crtGlow = glow;
        g.userData.crtColorTarget = new THREE.Color(1, 1, 1);
        g.userData.crtLastTime = 0;
      }
    },
    animate(g, t, powered, screenLight) {
      const dust = g.userData.spotDust;
      if (dust) dust.material.uniforms.uTime.value = t;
      const l = g.userData.crtGlow;
      if (!l) return;
      const dt = Math.min(0.1, Math.max(0, t - (g.userData.crtLastTime || t)));
      g.userData.crtLastTime = t;
      const active = powered && screenLight && screenLight.active;
      const peak = active ? Math.max(screenLight.r, screenLight.g, screenLight.b) : 0;
      const targetIntensity = active ? 0.02 + Math.sqrt(screenLight.luminance) * 2.8 : 0;
      if (peak > 1e-6) {
        // A small neutral component models scattering in the glass and keeps a
        // saturated VIC colour from producing unnaturally laser-like light.
        const wash = 0.10, c = g.userData.crtColorTarget;
        c.setRGB(
          wash + (1 - wash) * screenLight.r / peak,
          wash + (1 - wash) * screenLight.g / peak,
          wash + (1 - wash) * screenLight.b / peak,
        );
      }
      const a = 1 - Math.exp(-dt * 7);
      l.color.lerp(g.userData.crtColorTarget, a);
      l.intensity += (targetIntensity - l.intensity) * a;
    },
};
