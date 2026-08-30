// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// ── Paused / power-off attract-mode vector demo ──────────────────────────────
// A small Three.js "90s vector demo" that loops on the black CRT area whenever
// the C64 is powered off. It is deliberately self-contained: main.js only ever
// calls start() / stop(). The demo paints to its own WebGL <canvas> overlaid on
// top of the (black) #screen 2D canvas inside .crt-bezel — a single <canvas>
// can't host both a 2D and a WebGL context, so we use a sibling overlay.
//
// The overlay sits at z-index 5: above #screen (z auto) but below the CRT
// scanline ::after (z 10) and shine/roll overlays, so the monitor's scanlines
// and vignette render over the vectors for the period look. pointer-events are
// disabled so file drops / clicks pass straight through to the monitor beneath.
//
// Early-90s look: the scene is rendered into a small fixed-size buffer
// (RENDER_W×RENDER_H) and upscaled with nearest-neighbour (image-rendering:
// pixelated) — chunky pixels, no antialiasing — the way an Amiga / VGA vector
// demo of the era looked. The cubes are flat-shaded solid polygons ("glenz"
// vectors); the starfield is plotted points that dim with distance.
//
// Timeline (loops forever, ~58 s) — each sweeps in from the left and out to
// the right while spinning:
//   Act 1  a single flat-shaded cube
//   Act 2  a flat-shaded cube + a wobbling jello cube, orbiting each other
//   Act 3  a transparent flat-shaded cube + solid core (which casts a shadow)
//   Act 4  a cube textured with a different retro graphic on each face
//   Act 5  a classic neon wireframe globe
//   Act 6  a classic neon wireframe torus
// A depth-shaded starfield flies toward the camera underneath all acts.

import * as THREE from 'three';
import { frameRateVerdict } from './frame-rate-guard.js';

// Internal resolution (4:3) upscaled to the bezel. Kept low for the chunky
// pixel look, but at 640×480 (was 320×240) so the centred "PRESS POWER TO BOOT
// C64" banner stays legible when the bezel is large (2X / fullscreen) — the
// banner texture is sized from RENDER_H, so it sharpens with the buffer.
const RENDER_W = 640;
const RENDER_H = 480;

// How far an object travels: it starts off-screen left at -SWEEP and ends
// off-screen right at +SWEEP over the course of its act.
const SWEEP = 9;

// Render layers carrying per-act private lighting (an act's objects + its own
// lights live on its layer so the shading doesn't touch the other acts).
const ACT4_LAYER = 1; // Act 4's directional shading
const ACT3_LAYER = 2; // Act 3's shadow-casting rig

// Vector palette: the solid flat-shaded cube surface colours — the C64's own
// Colodore VIC-II hues, so the glenz cubes read as authentic C64 colours. The
// white key light still dominates, so lit facets show the true hue while the
// shadowed/rim sides cool toward the blue ambient.
const COL = {
  faceCyan:    0x75cec8, // Colodore cyan       (VIC #3)
  faceMagenta: 0x8e3c97, // Colodore purple     (VIC #4)
  faceGreen:   0x56ac4d, // Colodore green      (VIC #5)
  faceGlass:   0x706deb, // Colodore light blue (VIC #14)
  faceDarkRed: 0x813338, // Colodore red        (VIC #2)
};

// Scale an 0xRRGGBB colour's channels by `f` (in sRGB byte space) — used to dim
// the cubes' surface colour / texture tint. f=0.7 ≈ 30% darker.
const darken = (hex, f) => {
  const r = Math.round(((hex >> 16) & 0xff) * f);
  const g = Math.round(((hex >> 8) & 0xff) * f);
  const b = Math.round((hex & 0xff) * f);
  return (r << 16) | (g << 8) | b;
};
const CUBE_DIM = 0.7;   // surface albedo: 30% darker for all cubes (solid + textured)
// The cube light rigs were bright enough to saturate the lit faces (albedo×light
// clipped to white), so dimming albedo alone didn't read as darker. Bring the
// lighting down too — this un-saturates the faces so the colours actually deepen.
const LIGHT_DIM = 0.6;

// Pixel-art bitmaps for two of Act 4's retro graphics ('1' = lit pixel).
const INVADER = [
  '00100000100',
  '00010001000',
  '00111111100',
  '01101110110',
  '11111111111',
  '10111111101',
  '10100000101',
  '00011011000',
];
const SMILEY = [
  '00111100',
  '01111110',
  '11111111',
  '11011011',
  '11111111',
  '11000011',
  '01111110',
  '00111100',
];
const HEART = [
  '01100110',
  '11111111',
  '11111111',
  '11111111',
  '01111110',
  '00111100',
  '00011000',
  '00000000',
];
const SKULL = [
  '00111100',
  '01111110',
  '11111111',
  '11011011',
  '11111111',
  '01111110',
  '01010100',
  '00100100',
];

// Act table: duration in seconds + the cross-fade ramp at each edge. The loop
// length is the sum of the durations.
const ACTS = [
  { dur: 9 },   // 0: single cube
  { dur: 10 },  // 1: twin cubes
  { dur: 10 },  // 2: glass cube + core
  { dur: 11 },  // 3: retro-graphics cube
  { dur: 9 },   // 4: wireframe globe
  { dur: 9 },   // 5: wireframe torus
  { dur: 12 },  // 6: dark-red solid morphing cube → sphere → cube
];
const LOOP_LEN = ACTS.reduce((s, a) => s + a.dur, 0);
const FADE = 1.3; // seconds of fade-in / fade-out at each act boundary

// Software WebGL (SwiftShader, llvmpipe, Microsoft Basic Render) runs this on
// the CPU. Nothing here is worth that, so the demo never starts. Firefox masks
// the string and returns '' — unknown means "let the frame-rate guard below
// decide", which is the honest answer for a GPU we can't identify.
function _softwareRenderer(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch { return false; }
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export class PauseDemo {
  /** @param {HTMLElement} container  the .crt-bezel element to overlay. */
  constructor(container) {
    this.container = container;
    this.running = false;
    this.supported = false;
    this._raf = null;
    this._last = 0;
    this._t = 0; // master timeline clock (seconds)
    // When true, render ONLY the pulsing "PRESS POWER TO BOOT" banner — the
    // starfield + vector acts are hidden. Used as the powered-off screen when
    // the user turns Attract Mode off (Settings ▸ Display). Initialised here so
    // start({bannerOnly}) never adds a property post-construction.
    this._bannerOnly = false;
    // Set by main.js: called once if the frame-rate guard gives up, so the
    // powered-off screen can fall back to the static banner and remember it.
    this.onTooSlow = null;
    this._frames = [];      // recent frame times (ms), collected after warm-up
    this._guarded = false;  // the guard runs once per page, not once per start()
    try {
      this._init();
      this.supported = true;
    } catch (err) {
      // No WebGL (or context creation failed): degrade to a no-op. The black
      // #screen canvas beneath simply stays black.
      console.warn('PauseDemo: no hardware WebGL — vector demo disabled.', err);
    }
  }

  _init() {
    const renderer = new THREE.WebGLRenderer({
      antialias: false, // hard, jaggy edges — no AA, like the era's hardware
      alpha: false,
      powerPreference: 'low-power',
    });
    if (_softwareRenderer(renderer.getContext())) {
      try { renderer.forceContextLoss(); } catch { /* not fatal */ }
      renderer.dispose();
      throw new Error('software WebGL renderer');
    }
    // Render at a fixed low resolution (set in _resize) and let CSS upscale it,
    // so pixel ratio stays 1 regardless of the display's DPR.
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 1);
    // Shadow maps — used only by Act 3 (the inner cube casts onto the
    // transparent outer shell). No other light casts, so this costs nothing
    // while the other acts are on screen. PCFShadowMap (PCFSoftShadowMap was
    // deprecated in recent three.js and now just aliases to this).
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const el = renderer.domElement;
    el.className = 'pause-demo-canvas';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'none',
      pointerEvents: 'none',
      zIndex: '5',
    });
    // image-rendering + the CRT preset filters live in CSS (.pause-demo-canvas
    // and the body.crt-* rules) so the demo gets the same look as #screen.
    this.container.appendChild(el);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 300);
    camera.position.set(0, 0, 7);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    // Lighting for the flat-shaded cubes: a strong white key from the upper
    // right gives each facet a distinct tone, a dim blue rim from the opposite
    // side picks out the silhouette, and a low ambient keeps shadowed faces
    // from going fully black.
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6 * LIGHT_DIM);
    keyLight.position.set(4, 5, 6);
    const rimLight = new THREE.DirectionalLight(0x706deb, 0.7 * LIGHT_DIM); // Colodore light blue
    rimLight.position.set(-5, -3, -4);
    const ambient = new THREE.AmbientLight(0x2e2c9b, 1.0 * LIGHT_DIM); // Colodore blue (cool fill)
    scene.add(keyLight, rimLight, ambient);

    // Act 4 has its own lighting rig on a dedicated render layer so its textured
    // cube gets real directional shading without spilling onto the other acts.
    // The cube enables this layer (see _buildActs); these lights live only on it
    // and the camera renders it. A low white ambient keeps shadowed faces' pixel
    // art legible.
    camera.layers.enable(ACT4_LAYER);
    const a4Key = new THREE.DirectionalLight(0xffffff, 1.2 * LIGHT_DIM);
    a4Key.position.set(3, 4, 5);
    a4Key.layers.set(ACT4_LAYER);
    const a4Ambient = new THREE.AmbientLight(0xffffff, 0.28 * LIGHT_DIM);
    a4Ambient.layers.set(ACT4_LAYER);
    scene.add(a4Key, a4Ambient);

    // Act 3 has its own rig on a dedicated layer too: a shadow-casting key light
    // from above so the inner cube throws a shadow onto the lower interior walls
    // of the transparent outer cube, plus a cool ambient fill (kept moderate so
    // the shadow stays readable). The light tracks the cube each frame (see
    // _animate) so the shadow stays tight as the cube sweeps across.
    camera.layers.enable(ACT3_LAYER);
    const a3Key = new THREE.DirectionalLight(0xffffff, 1.7 * LIGHT_DIM);
    a3Key.position.set(2.5, 8, 4);
    a3Key.castShadow = true;
    a3Key.shadow.mapSize.set(1024, 1024);
    a3Key.shadow.camera.near = 0.5;
    a3Key.shadow.camera.far = 22;
    a3Key.shadow.camera.left = -3.2;
    a3Key.shadow.camera.right = 3.2;
    a3Key.shadow.camera.top = 3.2;
    a3Key.shadow.camera.bottom = -3.2;
    a3Key.shadow.bias = -0.0018;
    a3Key.layers.set(ACT3_LAYER);
    const a3Ambient = new THREE.AmbientLight(0x2e2c9b, 0.7 * LIGHT_DIM); // Colodore blue (cool fill)
    a3Ambient.layers.set(ACT3_LAYER);
    scene.add(a3Key, a3Key.target, a3Ambient);
    this._a3Key = a3Key;

    this._buildStarfield();
    this._buildActs();
    this._buildText();

    this._loop = this._loop.bind(this);

    // The drawing buffer is a fixed low resolution and CSS upscales it to
    // whatever size the bezel is (1X/2X toggle, fullscreen, window resize all
    // just restretch the same pixels), so no resize observer is needed.
    this._resize();
  }

  // ── Starfield ──────────────────────────────────────────────────────────────
  // A soft round sprite for the star points so they read as glowing particles
  // rather than the hard squares a bare PointsMaterial draws. White radial
  // falloff; the per-star vertex color tints/dims it by depth, additively.
  _makeStarTexture() {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0.0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ── Retro face textures (Act 4's cube) ───────────────────────────────────────
  // Build a 128² texture by running `draw(g, S)`. Nearest-filtered and
  // mipmap-free to keep the pixel art chunky, matching the rest of the look.
  _makeFaceTexture(draw) {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    draw(cv.getContext('2d'), S);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  // Draw a centred 1-bit pixel-art bitmap (`rows` of '0'/'1') in `color` on `bg`.
  _drawBitmapTile(g, S, rows, color, bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, S, S);
    const h = rows.length;
    const w = rows[0].length;
    const cell = Math.floor(Math.min(S / w, S / h));
    const gx = (S - cell * w) / 2;
    const gy = (S - cell * h) / 2;
    g.fillStyle = color;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rows[y][x] === '1') g.fillRect(gx + x * cell, gy + y * cell, cell, cell);
      }
    }
  }

  _drawCheckerTile(g, S) {
    const n = 8;
    const c = S / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        g.fillStyle = (x + y) & 1 ? '#8e3c97' : '#12001f'; // Colodore purple checker
        g.fillRect(x * c, y * c, c, c);
      }
    }
  }

  _drawPacmanTile(g, S) {
    g.fillStyle = '#140d00';
    g.fillRect(0, 0, S, S);
    const cx = S / 2;
    const cy = S / 2;
    const r = S * 0.38;
    g.fillStyle = '#edf171'; // Colodore yellow
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, 0.30 * Math.PI, 1.70 * Math.PI); // wedge mouth opens right
    g.closePath();
    g.fill();
    g.fillStyle = '#140d00'; // eye
    g.beginPath();
    g.arc(cx, cy - r * 0.45, r * 0.13, 0, 2 * Math.PI);
    g.fill();
  }

  _buildStarfield() {
    const N = 900;
    const SPREAD_X = 60;
    const SPREAD_Y = 45;
    const DEPTH = 170; // stars spawn this far behind the origin
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3); // per-star brightness, set each frame
    for (let i = 0; i < N; i++) {
      pos[i * 3]     = (Math.random() * 2 - 1) * SPREAD_X;
      pos[i * 3 + 1] = (Math.random() * 2 - 1) * SPREAD_Y;
      pos[i * 3 + 2] = -Math.random() * DEPTH;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      map: this._makeStarTexture(), // soft round particle, not a hard square
      size: 0.8,
      sizeAttenuation: true,
      vertexColors: true, // each star shaded individually by its depth
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.stars = { points, pos, col, N, DEPTH, SPREAD_X, SPREAD_Y };
  }

  _updateStars(dt) {
    const { pos, col, N, DEPTH, SPREAD_X, SPREAD_Y, points } = this.stars;
    const step = 14 * dt;     // travel speed toward the camera
    const NEAR = 9;           // z at which a star reaches / passes the camera
    const range = NEAR - (-DEPTH);
    for (let i = 0; i < N; i++) {
      let z = pos[i * 3 + 2] + step;
      if (z > NEAR) {
        // Passed the camera — respawn far behind with a fresh x/y.
        z = -DEPTH;
        pos[i * 3]     = (Math.random() * 2 - 1) * SPREAD_X;
        pos[i * 3 + 1] = (Math.random() * 2 - 1) * SPREAD_Y;
      }
      pos[i * 3 + 2] = z;
      // Shade by depth: distant stars are dim, near ones bright. Squared ramp
      // keeps the far field dark so close stars really pop as they rush in.
      let b = (z + DEPTH) / range; // 0 (far) .. 1 (near)
      b = b * b;
      // Tint toward a cool blue-white (~0x9fd8ff) scaled by brightness.
      col[i * 3]     = 0.62 * b;
      col[i * 3 + 1] = 0.85 * b;
      col[i * 3 + 2] = 1.0 * b;
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.geometry.attributes.color.needsUpdate = true;
  }

  // ── Geometry helpers ─────────────────────────────────────────────────────────
  // A flat-shaded solid cube (faceted "glenz" vector look), no edge outline.
  // `opacity` < 1 makes it translucent (and double-sided so the back faces show
  // through). userData.mats holds the fadeable material with its full-on
  // opacity for the cross-fades.
  _flatCube(size, faceColor, opacity = 1) {
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshStandardMaterial({
      color: darken(faceColor, CUBE_DIM),   // 30% darker surface (Acts 1-3)
      flatShading: true, // per-face normals → hard faceted shading, no Gouraud
      metalness: 0.1,
      roughness: 0.55,
      transparent: true,
      opacity,
      side: opacity < 1 ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: opacity >= 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { mats: [{ mat, base: opacity }] };
    return mesh;
  }

  // A parametric "solid vector" object (Acts 5 & 6): a square-celled wireframe
  // over solid BLACK faces, so the back of the cage is hidden — the classic
  // hidden-line look. Built by hand from a (su × sv) parametric grid so the
  // cells are quads (no triangulation diagonals). The black faces are pushed
  // back a hair with polygonOffset so the coincident front edges win the depth
  // test (and the rear edges lose it, getting occluded). Returns a Group.
  //   kind: 'sphere' | 'torus'; a = radius / ring radius, b = tube radius.
  _vectorGrid(kind, su, sv, color, a, b) {
    const P = (u, v) => {
      if (kind === 'sphere') {
        const th = u * Math.PI * 2;
        const ph = v * Math.PI;
        const s = Math.sin(ph);
        return [a * s * Math.cos(th), a * Math.cos(ph), a * s * Math.sin(th)];
      }
      const ar = u * Math.PI * 2;
      const br = v * Math.PI * 2;
      const rr = a + b * Math.cos(br);
      return [rr * Math.cos(ar), rr * Math.sin(ar), b * Math.sin(br)];
    };
    const cols = su + 1;
    const rows = sv + 1;
    const pos = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) pos.push(...P(i / su, j / sv));
    }
    const posAttr = new THREE.BufferAttribute(new Float32Array(pos), 3);
    const at = (i, j) => i * rows + j;

    // Solid black faces (two triangles per quad cell).
    const tri = [];
    for (let i = 0; i < su; i++) {
      for (let j = 0; j < sv; j++) {
        const p0 = at(i, j);
        const p1 = at(i + 1, j);
        const p2 = at(i + 1, j + 1);
        const p3 = at(i, j + 1);
        tri.push(p0, p1, p3, p1, p2, p3);
      }
    }
    const faceGeo = new THREE.BufferGeometry();
    faceGeo.setAttribute('position', posAttr);
    faceGeo.setIndex(tri);
    const faceMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const faces = new THREE.Mesh(faceGeo, faceMat);

    // Square-cell grid lines: every column edge and every row edge, once.
    const li = [];
    for (let i = 0; i < su; i++) {
      for (let j = 0; j < rows; j++) li.push(at(i, j), at(i + 1, j));
    }
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < sv; j++) li.push(at(i, j), at(i, j + 1));
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', posAttr);
    lineGeo.setIndex(li);
    const lineMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.renderOrder = 1; // after the black faces

    const grp = new THREE.Group();
    grp.add(faces, lines);
    grp.userData = { mats: [{ mat: lineMat, base: 1 }] };
    return grp;
  }

  // A wobbly soft-body "jello" cube (Act 2's second cube). A finely subdivided
  // box is bulged toward a sphere for rounded corners, smooth-shaded, and its
  // vertices ripple every frame (see _animate) so it jiggles like jelly. Its
  // flat base positions are stashed so the wobble is always relative to rest.
  _buildJelloCube(size) {
    const seg = 9;
    const geo = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    const half = size / 2;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const sphere = v.clone().normalize().multiplyScalar(half * 1.08);
      v.lerp(sphere, 0.22); // blend cube→sphere → soft rounded corners
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2e2c9b, // Colodore blue jello (VIC #6)
      metalness: 0.0,
      roughness: 0.5,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = {
      mats: [{ mat, base: 1 }],
      basePos: pos.array.slice(),
    };
    return mesh;
  }

  // A morphing solid for the final act: one subdivided-cube mesh whose vertices
  // are lerped between two precomputed target shapes — the cube itself and a
  // sphere — driven by a 0..1 morph parameter (cube → sphere → back to cube).
  // The material is flatShading so the facets (and the crisp cube faces) come
  // straight from the triangle geometry, no per-frame normal recompute.
  //   cube  : the base box positions (corners at ±R)
  //   sphere: each vertex pushed to radius R along its direction
  _buildMorphShape(R, seg, faceColor) {
    const geo = new THREE.BoxGeometry(R * 2, R * 2, R * 2, seg, seg, seg);
    const src = geo.attributes.position.array;
    const n = geo.attributes.position.count;
    const cube = new Float32Array(src);     // cube state = the box vertices
    const sphere = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = cube[i * 3], y = cube[i * 3 + 1], z = cube[i * 3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      sphere[i * 3] = (x / len) * R;
      sphere[i * 3 + 1] = (y / len) * R;
      sphere[i * 3 + 2] = (z / len) * R;
    }
    const mat = new THREE.MeshStandardMaterial({
      color: faceColor,
      flatShading: true,
      metalness: 0.1,
      roughness: 0.55,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { mats: [{ mat, base: 1 }] };
    return { mesh, geo, cube, sphere, n };
  }

  // Lerp the morph mesh cube → sphere → cube for morph parameter p∈[0,1]:
  // hold cube, ease to sphere, hold sphere, ease back to cube, hold cube.
  _setMorph(p) {
    const m = this.actMorph.userData.morph;
    const s1 = smoothstep(0.18, 0.40, p);   // cube → sphere
    const s2 = smoothstep(0.58, 0.80, p);   // sphere → cube (back)
    const arr = m.geo.attributes.position.array;
    const { cube, sphere } = m;
    for (let i = 0, N = m.n * 3; i < N; i++) {
      const cs = cube[i] + (sphere[i] - cube[i]) * s1;
      arr[i] = cs + (cube[i] - cs) * s2;
    }
    m.geo.attributes.position.needsUpdate = true;
  }

  // ── Acts ────────────────────────────────────────────────────────────────────
  // Each act is a Group, hidden until its window in the timeline. Its
  // userData.mats aggregates the fadeable materials of every cube it contains
  // so _setFade() can scale them together for the cross-fades.
  _buildActs() {
    // Act 1 — a single flat-shaded cube.
    {
      const g = new THREE.Group();
      g.visible = false;
      const cube = this._flatCube(2.4, COL.faceCyan, 1);
      g.add(cube);
      g.userData = { mats: cube.userData.mats };
      this.scene.add(g);
      this.actSingle = g;
    }

    // Act 2 — two cubes orbiting / interleaving on a rotating pivot.
    {
      const g = new THREE.Group();
      g.visible = false;
      const a = this._flatCube(1.8, COL.faceMagenta, 1);
      const b = this._buildJelloCube(1.9);
      g.add(a, b);
      g.userData = { a, b, mats: [...a.userData.mats, ...b.userData.mats] };
      this.scene.add(g);
      this.actTwins = g;
    }

    // Act 3 — a transparent flat-shaded cube with a smaller SOLID cube nested
    // inside it, visible through the translucent shell.
    {
      const g = new THREE.Group();
      g.visible = false;
      const glass = this._flatCube(3.0, COL.faceGlass, 0.45);
      const core = this._flatCube(1.4, COL.faceDarkRed, 1);
      // Draw the solid core first (it writes depth) and the translucent shell
      // after, so the shell's near faces blend over the core while its far
      // faces are correctly occluded behind it.
      core.renderOrder = 1;
      glass.renderOrder = 2;
      // Move both onto Act 3's lighting layer and wire up shadows: the solid
      // core casts, the transparent shell receives (but doesn't cast, so the
      // key light passes through it to land the core's shadow on the lower
      // interior walls).
      core.layers.set(ACT3_LAYER);
      glass.layers.set(ACT3_LAYER);
      core.castShadow = true;
      core.receiveShadow = false;
      glass.castShadow = false;
      glass.receiveShadow = true;
      g.add(core, glass);
      g.userData = { core, mats: [...glass.userData.mats, ...core.userData.mats] };
      this.scene.add(g);
      this.actGlass = g;
    }

    // Act 4 — a cube whose six faces are each a different retro graphic. The
    // materials are unlit (MeshBasic) so the pixel art stays flat and bright.
    {
      const g = new THREE.Group();
      g.visible = false;
      const S = 128;
      const faces = [
        (x) => this._drawBitmapTile(x, S, INVADER, '#75cec8', '#001018'), // Colodore cyan
        (x) => this._drawBitmapTile(x, S, SMILEY, '#edf171', '#1a1400'),  // Colodore yellow
        (x) => this._drawCheckerTile(x, S),
        (x) => this._drawBitmapTile(x, S, HEART, '#c46c71', '#1a000a'), // Colodore light red
        (x) => this._drawPacmanTile(x, S),
        (x) => this._drawBitmapTile(x, S, SKULL, '#b2b2b2', '#0a0a14'), // Colodore light grey
      ];
      // Lit material (not MeshBasic) so Act 4's dedicated light actually shades
      // the faces; metalness low / roughness high keeps the texture colours true.
      const mats = faces.map((fn) => new THREE.MeshStandardMaterial({
        map: this._makeFaceTexture(fn),
        color: darken(0xffffff, CUBE_DIM),   // tint the texture 30% darker (Act 4)
        metalness: 0.15,
        roughness: 0.7,
        transparent: true,
        opacity: 1,
      }));
      const cube = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6), mats);
      // Move the cube onto Act 4's lighting layer (only its lights illuminate it,
      // and the camera renders this layer too — see _init).
      cube.layers.set(ACT4_LAYER);
      g.add(cube);
      g.userData = { mats: mats.map((m) => ({ mat: m, base: 1 })) };
      this.scene.add(g);
      this.actTexCube = g;
    }

    // Act 5 — a globe: square-celled wireframe over solid black faces.
    {
      const g = this._vectorGrid('sphere', 9, 6, 0x75cec8, 1.7, 0); // Colodore cyan
      g.visible = false;
      this.scene.add(g);
      this.actGlobe = g;
    }

    // Act 6 — a torus, same solid-vector treatment.
    {
      const g = this._vectorGrid('torus', 12, 6, 0x706deb, 1.35, 0.55); // Colodore light blue
      g.visible = false;
      this.scene.add(g);
      this.actTorus = g;
    }

    // Act 7 — a dark-red solid that morphs cube → sphere → cube. Uses the
    // default lighting rig (key/rim/ambient) like the Act 1/2 flat-shaded cubes.
    {
      const g = new THREE.Group();
      g.visible = false;
      const morph = this._buildMorphShape(1.45, 10, darken(COL.faceDarkRed, CUBE_DIM));
      g.add(morph.mesh);
      g.userData = { mats: morph.mesh.userData.mats, morph };
      this.scene.add(g);
      this.actMorph = g;
    }
  }

  // ── Centre prompt ────────────────────────────────────────────────────────────
  // A glowing "PRESS POWER TO BOOT" banner pinned to screen centre, in front of
  // everything (depthTest off), pulsing the whole time the demo runs.
  // Stroke the standard power symbol (a ring with a gap at the top and a
  // vertical bar through it) centred at (cx, cy).
  _drawPowerIcon(g, cx, cy, r) {
    const gap = 0.45; // half-angle of the opening at the top (radians)
    g.lineWidth = r * 0.26;
    g.lineCap = 'round';
    // Ring: everything except a wedge at the top (top is -PI/2 in canvas space).
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2 + gap, -Math.PI / 2 - gap + 2 * Math.PI);
    g.stroke();
    // Vertical bar from above the ring down to its centre.
    g.beginPath();
    g.moveTo(cx, cy - r * 1.05);
    g.lineTo(cx, cy + r * 0.02);
    g.stroke();
  }

  _buildText() {
    // Rebuilding (e.g. after the web font finishes loading) — drop the old one.
    if (this.textSprite) {
      this.scene.remove(this.textSprite);
      this.textSprite.material.map?.dispose?.();
      this.textSprite.material.dispose?.();
      this.textSprite = null;
    }

    const pre = 'PRESS';
    const post = 'POWER TO BOOT';

    // The banner sprite is worldW units wide and sits at z=3; the 60° camera at
    // z=7 maps that to only ~150 render-buffer pixels. Drawing the text on a
    // ~1000px canvas and letting the GPU minify it 7× with LinearFilter is what
    // made it blurry. Instead, size the canvas to the sprite's on-screen
    // footprint (≈1 texel per buffer pixel) and use NearestFilter — crisp
    // pixel-art text, consistent with the rest of the 320×240 vector demo.
    const worldW = 2.8;
    const camDist = 7 - 3;                              // camera z − sprite z
    const visH = 2 * camDist * Math.tan((60 * Math.PI / 180) / 2);
    const pxPerUnit = RENDER_H / visH;                  // buffer px per world unit
    const texW = Math.round(worldW * pxPerUnit);        // ≈ 146

    // Lay the text out at a comfortable high-res size, then scale the WHOLE
    // canvas down to texW so the font rasterises directly at the target
    // resolution (sharp) rather than being downsampled from a big bitmap.
    const font = '120px "Giana", "Share Tech Mono", "Courier New", monospace';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const pad = 70;
    const iconD = 130;          // icon box diameter
    const iconR = iconD * 0.42; // ring radius (a touch inside the box)
    const spacePre = 72;        // gap between PRESS and the icon
    const spacePost = 34;       // gap between the icon and POWER
    const preW = probe.measureText(pre).width;
    const postW = probe.measureText(post).width;
    const fullW = preW + spacePre + iconD + spacePost + postW + pad * 2;
    const fullH = 220;
    const S = texW / fullW;     // downscale factor (≈ 0.15)

    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(fullW * S));
    cv.height = Math.max(1, Math.round(fullH * S));
    const g = cv.getContext('2d');
    g.scale(S, S);              // draw with full-res coords → sharp at low res

    const cy = fullH / 2;
    const x0 = pad;
    const iconCx = x0 + preW + spacePre + iconD / 2;
    const postX = x0 + preW + spacePre + iconD + spacePost;

    // Two passes: a faint cyan glow, then a crisp white core on top — applied to
    // the text and the icon alike. Blur is in full-res units; g.scale shrinks it
    // to ~1px at the target resolution, so the halo stays subtle.
    const draw = (color, blur) => {
      g.font = font;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.shadowColor = 'rgba(112,109,235,0.5)'; // Colodore light blue glow
      g.shadowBlur = blur;
      g.fillStyle = color;
      g.strokeStyle = color;
      g.fillText(pre, x0, cy);
      g.fillText(post, postX, cy);
      this._drawPowerIcon(g, iconCx, cy, iconR);
    };
    draw('#706deb', 6);   // Colodore light-blue halo
    draw('#ffffff', 0);   // white core

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;   // crisp upscale, no linear blur
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,  // always drawn on top of the vectors
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, 0, 3); // between the camera and the action
    sprite.scale.set(worldW, (worldW * cv.height) / cv.width, 1);
    sprite.renderOrder = 999;
    this.scene.add(sprite);
    this.textSprite = sprite;

    // The banner is rasterised to a canvas, so it bakes in whatever font is
    // available right now. On a cold load Giana may not have arrived yet — it
    // falls back to Share Tech Mono / Courier, which is why the banner looked
    // wrong until a refresh. Re-rasterise once the real font loads, exactly once.
    if (!this._bannerFontReady && typeof document !== 'undefined' && document.fonts) {
      if (document.fonts.check('16px "Giana"')) {
        this._bannerFontReady = true;     // already loaded → first draw is correct
      } else {
        document.fonts.load('16px "Giana"').then(() => {
          if (this._bannerFontReady || !this.textSprite) return;
          this._bannerFontReady = true;
          this._buildText();              // redraw with the real font
        }).catch(() => {});
      }
    }
  }

  // Apply a 0..1 fade to an act group: hide it entirely at 0, else scale every
  // fadeable material's opacity by `fade`.
  _setFade(group, fade) {
    if (fade <= 0.001) {
      group.visible = false;
      return;
    }
    group.visible = true;
    for (const { mat, base } of group.userData.mats) {
      mat.opacity = base * fade;
    }
  }

  // ── Per-frame animation ──────────────────────────────────────────────────────
  _animate(dt) {
    this._t += dt;

    // Banner-only mode: hide the starfield + every vector act and render just
    // the pulsing "PRESS POWER TO BOOT" banner (same text/font as the full
    // attract demo). _setFade(act, 0) hides each act via .visible — the full
    // path re-shows the active one, so toggling back is seamless.
    if (this._bannerOnly) {
      if (this.stars && this.stars.points) this.stars.points.visible = false;
      this._setFade(this.actSingle, 0); this._setFade(this.actTwins, 0);
      this._setFade(this.actGlass, 0);  this._setFade(this.actTexCube, 0);
      this._setFade(this.actGlobe, 0);  this._setFade(this.actTorus, 0);
      this._setFade(this.actMorph, 0);
      if (this.textSprite) {
        this.textSprite.material.opacity = 0.7 + 0.3 * Math.sin(this._t * 2.0);
      }
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.stars && this.stars.points) this.stars.points.visible = true;

    this._updateStars(dt);

    // Locate the active act and the time elapsed within it.
    let tt = this._t % LOOP_LEN;
    let acc = 0;
    let idx = 0;
    let localT = tt;
    for (let i = 0; i < ACTS.length; i++) {
      if (tt < acc + ACTS[i].dur) {
        idx = i;
        localT = tt - acc;
        break;
      }
      acc += ACTS[i].dur;
    }
    const dur = ACTS[idx].dur;
    // Triangular fade window: ramp up over FADE, hold, ramp down over FADE.
    const fade =
      smoothstep(0, FADE, localT) * smoothstep(0, FADE, dur - localT);

    // Progress 0..1 across the act → a left-to-right sweep. The object starts
    // off-screen left (-SWEEP) and ends off-screen right (+SWEEP); a sine arc
    // on z brings it nearer the camera mid-crossing for depth.
    const p = localT / dur;
    const x = -SWEEP + 2 * SWEEP * p;
    const arc = Math.sin(Math.PI * p);

    // Drive each act; only the active one is visible.
    this._setFade(this.actSingle, idx === 0 ? fade : 0);
    this._setFade(this.actTwins,  idx === 1 ? fade : 0);
    this._setFade(this.actGlass,  idx === 2 ? fade : 0);
    this._setFade(this.actTexCube, idx === 3 ? fade : 0);
    this._setFade(this.actGlobe,  idx === 4 ? fade : 0);
    this._setFade(this.actTorus,  idx === 5 ? fade : 0);
    this._setFade(this.actMorph,  idx === 6 ? fade : 0);

    if (idx === 0) {
      // Single cube sweeps left→right, spinning on all three axes. Sits a bit
      // further back than the other acts so it reads a touch smaller.
      const g = this.actSingle;
      g.position.set(x, 0, -2.5 + 3 * arc);
      g.rotation.set(localT * 0.7, localT * 0.9, localT * 0.45);
    } else if (idx === 1) {
      // The whole pair sweeps left→right; meanwhile the pivot rotates on Y and
      // Z so the two cubes weave in front of / behind one another, each cube
      // spins on its own, and the orbit radius breathes.
      const g = this.actTwins;
      const { a, b } = g.userData;
      g.position.set(x, 0, -1 + 2.5 * arc);
      g.rotation.set(localT * 0.5, localT * 0.7, localT * 0.4);
      const r = 2.2 + 0.6 * Math.sin(localT * 0.9);
      a.position.set(r, 0, 0);
      b.position.set(-r, 0, 0);
      a.rotation.set(localT * 1.1, localT * 0.8, 0);
      b.rotation.set(-localT * 0.9, localT * 1.2, 0);
      // Cube b is jello: ripple its vertices with travelling sine waves (one per
      // axis, driven by the other axes) so it wobbles and jiggles, then rebuild
      // normals so the soft shading tracks the deformation.
      const posAttr = b.geometry.attributes.position;
      const bp = b.userData.basePos;
      const arr = posAttr.array;
      const A = 0.16; // wobble amplitude
      const t = this._t;
      for (let i = 0; i < posAttr.count; i++) {
        const bx = bp[i * 3];
        const by = bp[i * 3 + 1];
        const bz = bp[i * 3 + 2];
        arr[i * 3]     = bx + A * Math.sin(by * 2.6 + t * 5.0);
        arr[i * 3 + 1] = by + A * Math.sin(bz * 2.6 + t * 5.3);
        arr[i * 3 + 2] = bz + A * Math.sin(bx * 2.6 + t * 4.7);
      }
      posAttr.needsUpdate = true;
      b.geometry.computeVertexNormals();
    } else if (idx === 2) {
      // Transparent cube sweeps left→right with a deeper depth arc so it flies
      // in toward the viewer mid-crossing, tumbling all the while; the solid
      // core cube counter-rotates inside it.
      const g = this.actGlass;
      g.position.set(x, 0, -4 + 4 * arc);
      g.rotation.set(localT * 0.55, localT * 0.7, localT * 0.3);
      g.userData.core.rotation.set(-localT * 0.9, localT * 0.5, -localT * 0.7);
      // Keep the shadow-casting key light above the cube as it sweeps, so the
      // shadow camera stays centred on it and the shadow doesn't clip.
      const k = this._a3Key;
      k.position.set(g.position.x + 2.5, g.position.y + 8, g.position.z + 4);
      k.target.position.copy(g.position);
      k.target.updateMatrixWorld();
    } else if (idx === 3) {
      // Retro-textured cube sweeps left→right, tumbling fast to show off its
      // faces (spins quicker than the other acts).
      const g = this.actTexCube;
      g.position.set(x, 0, -3.5 + 3 * arc);
      g.rotation.set(localT * 1.1, localT * 1.45, localT * 0.7);
    } else if (idx === 4) {
      // Wireframe globe sweeps left→right, spinning on its axis with a slight
      // tilt. Sits well back so it reads smaller and stays behind the prompt.
      const g = this.actGlobe;
      g.position.set(x, 0, -4.5 + 3 * arc);
      g.rotation.set(0.4, localT * 0.9, localT * 0.15);
    } else if (idx === 5) {
      // Wireframe torus tumbles end-over-end as it sweeps left→right, set well
      // back like the globe.
      const g = this.actTorus;
      g.position.set(x, 0, -4.5 + 3 * arc);
      g.rotation.set(localT * 0.8, localT * 1.0, localT * 0.4);
    } else {
      // Dark-red solid sweeps left→right, tumbling, while it morphs cube →
      // sphere → cube across the act (p drives the vertex blend).
      const g = this.actMorph;
      g.position.set(x, 0, -3 + 3 * arc);
      g.rotation.set(localT * 0.6, localT * 0.8, localT * 0.35);
      this._setMorph(p);
    }

    // "PRESS POWER TO BOOT" pulses in the centre over everything, the whole
    // time the demo runs. Floor kept high (0.4) so it stays clearly readable on
    // top of even the bright wireframe acts.
    if (this.textSprite) {
      this.textSprite.material.opacity = 0.7 + 0.3 * Math.sin(this._t * 2.0);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _loop(now) {
    if (!this.running) return;
    if (!this._last) this._last = now;
    const dtMs = now - this._last;
    let dt = dtMs / 1000;
    this._last = now;
    if (dt > 0.05) dt = 0.05; // clamp after tab-switch / long stalls
    this._animate(dt);
    if (!this._guarded && !this._checkFrameRate(dtMs)) return;   // gave up; stopped
    this._raf = requestAnimationFrame(this._loop);
  }

  // One frame's worth of the guard (see frame-rate-guard.js for the decision).
  // Returns false once it has given up on this GPU, having already stopped.
  _checkFrameRate(dtMs) {
    this._frames.push(dtMs);
    const verdict = frameRateVerdict(this._frames);
    if (verdict === 'wait') return true;
    this._guarded = true;                 // decided; never asked again this page
    if (verdict === 'ok') return true;
    const sorted = [...this._frames].sort((a, b) => a - b);
    this.stop();
    this.onTooSlow?.(Math.round(sorted[sorted.length >> 1]));
    return false;
  }

  _resize() {
    if (!this.renderer) return;
    // The drawing buffer is a fixed low resolution; CSS (width/height 100% +
    // image-rendering: pixelated) upscales it to fill the 4:3 bezel. So there's
    // nothing to recompute per resize — the buffer and camera aspect are
    // constant — but we still set them once here at startup.
    this.renderer.setSize(RENDER_W, RENDER_H, false);
    this.camera.aspect = RENDER_W / RENDER_H;
    this.camera.updateProjectionMatrix();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  // Show the overlay and start the animation loop. Called on initial load and
  // on every POWER OFF.
  start({ bannerOnly = false } = {}) {
    this._bannerOnly = !!bannerOnly;
    if (!this.supported || this.running) return;
    this.running = true;
    this._last = 0;
    if (!this._guarded) this._frames = [];   // fresh sample per attempt
    this.renderer.domElement.style.display = 'block';
    this._raf = requestAnimationFrame(this._loop);
  }

  // Hide the overlay (revealing the live #screen) and go fully idle. Called on
  // every POWER ON. Cancelling the render loop is the whole story: with no RAF
  // scheduled the demo does zero CPU/GPU work while the machine runs. The WebGL
  // context and the (few KB of) static geometry stay resident so the next
  // POWER OFF resumes instantly without rebuilding the scene.
  stop() {
    if (!this.supported) return;
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this.renderer.domElement.style.display = 'none';
  }
}
