// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';

export function makeChevronGeometry(radius, side) {
  const s = side < 0 ? -1 : 1;
  const points = [
    [-0.30, 0.25], [-0.12, 0.25], [0.30, 0],
    [-0.12, -0.25], [-0.30, -0.25], [0.10, 0],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0] * radius * s, points[0][1] * radius);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0] * radius * s, points[i][1] * radius);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: radius * 0.05, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -radius * 0.025);
  return geometry;
}

export const scene = {
    // Clean Outrun composition: the C64 sits on a dark neon highway aimed at a
    // banded sun, with the grid, mountains and palms held to the flanks. Raw
    // tone mapping preserves crisp neon without a post-processing allocation or
    // bloom pass; glow lives in the two backdrop shaders.
    name: 'Synthwave', css: 'scene-synthwave', envInt: 0.2, basic: true, tone: 'none',
    fog: { color: 0x100027, near: 9, far: 52 },
    build(g, { sphere, box }) {
      const R = sphere.radius, cx = sphere.center.x, cy = sphere.center.y, cz = sphere.center.z;
      const gyFloor = box.min.y - R * 0.05;

      // Deep violet dome with a narrow, warm horizon. Most of the sky remains
      // empty so the sun and the two star scales have room to read.
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(R * 72, 32, 18),
        new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false, fog: false,
          vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
          fragmentShader: `varying vec3 vP;
            void main(){
              float h=normalize(vP).y;
              vec3 deep=vec3(0.012,0.0,0.055), mid=vec3(0.13,0.012,0.25), low=vec3(0.72,0.08,0.31);
              vec3 c=mix(mid,deep,smoothstep(0.04,0.62,h));
              c=mix(low,c,smoothstep(-0.025,0.17,h));
              gl_FragColor=vec4(c,1.0);
            }`,
        }),
      );
      sky.position.set(cx, cy, cz); g.add(sky);

      const stars = (n, size, color, minY) => {
        const p = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, r = R * (38 + Math.random() * 25);
          p[i * 3] = cx + Math.cos(a) * r;
          p[i * 3 + 1] = cy + R * (minY + Math.random() * (48 - minY));
          p[i * 3 + 2] = cz + Math.sin(a) * r - R * 15;
        }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
        g.add(new THREE.Points(geo, new THREE.PointsMaterial({ color, size: R * size, transparent: true, opacity: 0.82, fog: false, depthWrite: false })));
      };
      stars(430, 0.085, 0x9fd9ff, 10);
      stars(85, 0.17, 0xf1ddff, 14);

      // Banded sun with a shader halo. Uneven cut widths give it the imperfect
      // raster character of an arcade backdrop without disturbing its shape.
      const sunU = { uTime: { value: 0 } };
      const sun = new THREE.Mesh(new THREE.PlaneGeometry(R * 28, R * 28), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false, uniforms: sunU,
        vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec2 vUv; uniform float uTime;
          float hash(float n){ return fract(sin(n*12.9898)*43758.5453); }
          void main(){
            vec2 p=vUv-0.5; float d=length(p)*2.0, y=vUv.y;
            float disc=1.0-smoothstep(0.595,0.615,d);
            float bands=y*13.0-uTime*0.1, row=floor(bands);
            float edge=0.31-y*0.28+(hash(row)-0.5)*0.075;
            float cuts=smoothstep(0.0,0.045,abs(fract(bands)-0.5)-edge);
            float mask=disc*clamp(cuts+step(0.57,y),0.0,1.0);
            float halo=(1.0-smoothstep(0.62,0.94,d))*(1.0-disc)*0.18;
            vec3 top=vec3(1.0,0.82,0.28), bot=vec3(1.0,0.08,0.48);
            vec3 c=mix(bot,top,y);
            gl_FragColor=vec4(mix(c,vec3(1.0,0.18,0.58),halo*0.35),max(mask,halo));
          }`,
      }));
      sun.position.set(cx, cy + R * 5.2, cz - R * 59); sun.renderOrder = -1; g.add(sun);

      // A single soft horizon bloom, kept in-shader so the scene stays on the
      // basic renderer path.
      const haze = new THREE.Mesh(new THREE.PlaneGeometry(R * 78, R * 11), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec2 vUv; void main(){
          float x=1.0-smoothstep(0.0,0.5,abs(vUv.x-0.5));
          float y=1.0-smoothstep(0.0,0.5,abs(vUv.y-0.5));
          float a=x*y*y*0.18; gl_FragColor=vec4(0.95,0.08,0.45,a);
        }`,
      }));
      haze.position.set(cx, gyFloor + R * 4.1, cz - R * 58); haze.renderOrder = -2; g.add(haze);

      // Hierarchical shoulder grid: subdued minor cells, brighter five-cell
      // majors, and a controlled distance fade. The central road covers it.
      const gridU = {
        uTime: { value: 0 }, uCenter: { value: new THREE.Vector2(cx, cz) },
        uCell: { value: R * 1.15 }, uNear: { value: R * 6 }, uFar: { value: R * 54 },
      };
      const grid = new THREE.Mesh(new THREE.PlaneGeometry(R * 128, R * 128, 1, 96), new THREE.ShaderMaterial({
        uniforms: gridU,
        vertexShader: `varying vec2 vXZ; uniform float uTime,uCell,uNear,uFar; uniform vec2 uCenter;
          void main(){
            vec4 w=modelMatrix*vec4(position,1.0); vXZ=w.xz;
            float reach=smoothstep(uNear*0.7,uFar,abs(w.z-uCenter.y));
            w.y+=sin((w.z-uCenter.y)/(uCell*6.5)+uTime*0.38)*uCell*0.12*reach;
            gl_Position=projectionMatrix*viewMatrix*w;
          }`,
        fragmentShader: `varying vec2 vXZ; uniform float uTime,uCell,uNear,uFar; uniform vec2 uCenter;
          float lineAt(float v,float w){ float f=abs(fract(v)-0.5); return smoothstep(w,0.0,f); }
          void main(){
            vec2 rel=vXZ-uCenter;
            vec2 q=vec2(rel.x/uCell,(rel.y+uTime*uCell*0.58)/uCell);
            float minor=max(lineAt(q.x,0.045),lineAt(q.y,0.045));
            float major=max(lineAt(q.x/5.0,0.022),lineAt(q.y/5.0,0.022));
            float line=max(minor*0.36,major*0.82);
            float fade=max(0.08,smoothstep(uFar,uNear,length(rel)));
            vec3 base=vec3(0.018,0.0,0.052), cyan=vec3(0.02,0.55,0.7), pink=vec3(0.75,0.04,0.48);
            vec3 c=base+mix(pink,cyan,smoothstep(uNear*2.0,uFar,abs(rel.y)))*line*fade;
            gl_FragColor=vec4(c,1.0);
          }`,
      }));
      grid.rotation.x = -Math.PI / 2; grid.position.set(cx, gyFloor, cz); g.add(grid);

      // Dark highway protects the central silhouette. Its two colored edge
      // rails and restrained broken sun trail supply all the extra road detail.
      const road = new THREE.Mesh(new THREE.PlaneGeometry(R * 8.0, R * 124, 1, 96), new THREE.ShaderMaterial({
        fog: false,
        uniforms: { uTime: gridU.uTime, uCell: gridU.uCell, uNear: gridU.uNear, uFar: gridU.uFar, uCenter: gridU.uCenter },
        vertexShader: `varying vec2 vUv; uniform float uTime,uCell,uNear,uFar; uniform vec2 uCenter;
          void main(){
            vUv=uv; vec4 w=modelMatrix*vec4(position,1.0);
            float reach=smoothstep(uNear*0.7,uFar,abs(w.z-uCenter.y));
            w.y+=sin((w.z-uCenter.y)/(uCell*6.5)+uTime*0.38)*uCell*0.12*reach;
            gl_Position=projectionMatrix*viewMatrix*w;
          }`,
        fragmentShader: `varying vec2 vUv; void main(){
          float x=abs(vUv.x-0.5);
          float edge=1.0-step(0.018,abs(x-0.465));
          vec3 rail=mix(vec3(1.0,0.05,0.62),vec3(0.05,0.75,0.9),step(0.5,vUv.x));
          float farMask=smoothstep(0.48,0.94,vUv.y);
          float centre=1.0-smoothstep(0.05,0.24,x);
          float broken=1.0-smoothstep(0.06,0.14,abs(fract(vUv.y*22.0)-0.5));
          float trail=farMask*centre*broken*0.2;
          float dash=(1.0-step(0.018,x))*(1.0-step(0.14,abs(fract(vUv.y*16.0)-0.5)))*0.18;
          vec3 c=vec3(0.012,0.0,0.035)+vec3(0.025,0.002,0.055)*(1.0-x*2.0)*0.35;
          c+=rail*edge*0.56+vec3(1.0,0.16,0.45)*trail+vec3(0.9,0.08,0.48)*dash;
          gl_FragColor=vec4(c,1.0);
        }`,
      }));
      road.rotation.x = -Math.PI / 2; road.position.set(cx, gyFloor + R * 0.018, cz - R * 29); g.add(road);

      // A flat rear range adds one coarse layer of depth while leaving the sun
      // and road opening clear. Its irregular profile is fixed at build time.
      const rearMountainMat = new THREE.MeshBasicMaterial({ color: 0x16002d });
      const rearRange = (side) => {
        const segments = 24, positions = new Float32Array((segments + 1) * 6);
        const indices = new Uint16Array(segments * 6);
        for (let i = 0; i <= segments; i++) {
          const x = (i / segments - 0.5) * R * 48;
          const outward = THREE.MathUtils.clamp((side * x / R + 24) / 48, 0, 1);
          const peak = R * (0.55 + outward * (2.0 + Math.abs(Math.sin(i * 1.73 + side)) * 1.6 + Math.sin(i * 0.51) * 0.3));
          const p = i * 6;
          positions[p] = x; positions[p + 1] = 0; positions[p + 2] = 0;
          positions[p + 3] = x; positions[p + 4] = peak; positions[p + 5] = 0;
          if (i < segments) {
            const q = i * 6, a = i * 2;
            indices[q] = a; indices[q + 1] = a + 2; indices[q + 2] = a + 1;
            indices[q + 3] = a + 1; indices[q + 4] = a + 2; indices[q + 5] = a + 3;
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        const range = new THREE.Mesh(geo, rearMountainMat);
        range.position.set(cx + side * R * 28, gyFloor - R * 0.04, cz - R * 51);
        g.add(range);
      };
      rearRange(-1); rearRange(1);

      // Solid foreground silhouettes with low-density contour meshes confined
      // to the shoulders. No wire crosses the highway or C64 silhouette.
      const mountainSide = (side) => {
        const geo = new THREE.PlaneGeometry(R * 30, R * 62, 14, 18), pa = geo.attributes.position;
        for (let i = 0; i < pa.count; i++) {
          const x = pa.getX(i), y = pa.getY(i);
          const outward = THREE.MathUtils.clamp((side * x / R + 15) / 30, 0, 1);
          const depth = y / (R * 62) + 0.5;
          const noise = Math.sin(x * 0.31 / R + y * 0.17 / R) * 0.55 + Math.sin(x * 0.11 / R - y * 0.36 / R) * 0.35;
          pa.setZ(i, R * (0.25 + outward * 7.4) * (0.62 + depth * 0.42) + noise * R * (0.25 + outward * 0.55));
        }
        geo.computeVertexNormals();
        const grp = new THREE.Group();
        grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x090018 })));
        grp.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x20abc6, transparent: true, opacity: 0.31 })));
        grp.rotation.x = -Math.PI / 2;
        grp.position.set(cx + side * R * 19.5, gyFloor + R * 0.025, cz - R * 27);
        g.add(grp);
      };
      mountainSide(-1); mountainSide(1);

      // Fewer palms, arranged in a deliberate rhythm. Every frond begins at the
      // crown and shares one tapered geometry, avoiding the old detached spikes.
      const palmMat = new THREE.MeshBasicMaterial({ color: 0x020007, side: THREE.DoubleSide });
      const trunkGeo = new THREE.CylinderGeometry(0.08, 0.15, 4, 6);
      const frondGeo = new THREE.PlaneGeometry(0.18, 2.8); frondGeo.translate(0, 1.4, 0);
      const up = new THREE.Vector3(0, 1, 0), frondDir = new THREE.Vector3();
      const palm = (x, z, s, lean, phase) => {
        const grp = new THREE.Group();
        const trunk = new THREE.Mesh(trunkGeo, palmMat); trunk.scale.setScalar(s); trunk.position.y = 2 * s; grp.add(trunk);
        for (let i = 0; i < 6; i++) {
          const a = phase + i / 6 * Math.PI * 2;
          const leaf = new THREE.Mesh(frondGeo, palmMat); leaf.scale.setScalar(s); leaf.position.y = 4 * s;
          frondDir.set(Math.cos(a), -0.26 - (i & 1) * 0.08, Math.sin(a)).normalize();
          leaf.quaternion.setFromUnitVectors(up, frondDir); grp.add(leaf);
        }
        grp.rotation.z = lean; grp.position.set(x, gyFloor, z); return grp;
      };
      const palms = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const z = cz + R * 2 - i * R * 7.8;
        const sL = R * (0.39 + Math.random() * 0.12), sR = R * (0.38 + Math.random() * 0.13);
        palms.add(palm(cx - R * (5.5 + Math.random() * 1.25), z, sL, 0.035 + Math.random() * 0.055, i * 0.37));
        palms.add(palm(cx + R * (5.5 + Math.random() * 1.25), z - R * 3.2, sR, -0.035 - Math.random() * 0.055, i * 0.37 + 0.5));
      }
      g.add(palms);

      // Two chunky chevrons are enough to suggest the arcade road without
      // turning the shoulders into a modern illuminated installation.
      const boardGeo = new THREE.BoxGeometry(R * 0.9, R * 0.58, R * 0.08);
      const boardMat = new THREE.MeshBasicMaterial({ color: 0x090016 });
      const chevronMat = new THREE.MeshBasicMaterial({ color: 0xffe56e });
      const chevron = (side, z) => {
        const sign = new THREE.Group();
        const board = new THREE.Mesh(boardGeo, boardMat); board.position.y = R * 0.78; sign.add(board);
        const arrow = new THREE.Mesh(makeChevronGeometry(R, side), chevronMat);
        arrow.position.set(0, R * 0.78, R * 0.066); sign.add(arrow);
        sign.position.set(cx + side * R * 5.5, gyFloor, z); g.add(sign);
      };
      chevron(-1, cz - R * 18); chevron(1, cz - R * 32);

      // Localized opposing rims integrate the beige hardware without flooding
      // its broad surfaces with neon.
      const pink = new THREE.PointLight(0xff2eaa, 1.65, R * 23, 1.3);
      pink.position.set(cx - R * 4.5, cy + R * 2.2, cz - R * 7); g.add(pink);
      const cyan = new THREE.PointLight(0x28d9ff, 1.25, R * 19, 1.4);
      cyan.position.set(cx + R * 4, cy + R * 1.4, cz + R * 1.5); g.add(cyan);
      g.add(new THREE.AmbientLight(0x120526, 0.72));

      g.userData.sunU = sunU; g.userData.gridU = gridU;
    },
    animate(g, t) {
      if (g.userData.sunU) g.userData.sunU.uTime.value = t;
      if (g.userData.gridU) g.userData.gridU.uTime.value = t;
    },
};
