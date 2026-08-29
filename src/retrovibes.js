// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// ── retrovibes.js — fullscreen 3D "Retro Vibes" model viewer ─────────────────
// Double-clicking "vibes" in the header tagline opens this: a browser-window-
// filling Three.js scene showing public/commodore_64.glb, lit like an 80s
// synthwave demo. Drag to rotate, scroll / two-finger pinch to zoom, Esc or the
// ✕ (top-right) to close.
//
// Self-contained like pausedemo.js: main.js only calls open() / close(). The
// WebGL context + the (18 MB) parsed model are built lazily on the first open
// and kept resident, so re-opening is instant; the render loop only runs while
// the overlay is visible, so it costs nothing when closed.
//
// Backdrop is the CSS synthwave gradient on the overlay (renderer clears with
// alpha 0); a low-intensity RoomEnvironment gives the glossy/clearcoat surfaces
// real reflections while the neon magenta/cyan rig owns the look, and a neon
// floor grid completes the retrowave scene.

import * as THREE from 'three';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { attachKeycapPresses } from './keycap-press.js';   // [removable prototype]
import { hostTouchControls, restoreTouchControls } from './touch-joystick.js';
import { bgTexture } from './vibes-scene-common.js';
import { sampleScreenLight } from './vibes-screen-light.js';
import { scene as sceneSynthwave } from './vibes-scene-synthwave.js';
import { scene as sceneStarry } from './vibes-scene-starry.js';
import { scene as sceneSpotlight } from './vibes-scene-spotlight.js';
import { scene as sceneIkplus } from './vibes-scene-ikplus.js';
import { scene as sceneBedroom } from './vibes-scene-bedroom.js';

// Cinematic grade: subtle vignette + edge chromatic aberration + film grain.
// Runs on the final sRGB image (after OutputPass). Kept gentle so it flavours
// rather than dominates. uTime drives the grain; uAberration/uVignette/uGrain
// scale each effect.
// Is this a device that should skip the expensive pass? Coarse pointer catches
// phones and tablets; the core/memory floors catch the low-end laptops that
// report a fine pointer and still render in software.
function _lowPowerDevice() {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  return (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.0008 },
    uVignette: { value: 0.24 },
    uGrain: { value: 0.025 },
    // Split tone, off by default; a scene opts in through `grade`.
    uSplit: { value: 0.0 },
    uSplitShadow: { value: new THREE.Vector3(1, 1, 1) },
    uSplitHigh: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberration, uVignette, uGrain, uSplit;
    uniform vec3 uSplitShadow, uSplitHigh;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // chromatic aberration grows toward the edges
      vec2 off = d * uAberration * (0.4 + r2 * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // vignette
      col *= 1.0 - uVignette * smoothstep(0.25, 0.9, r2);
      // Per-pixel, so unlike the aberration above this cannot alias anything.
      if (uSplit > 0.0) {
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, col * mix(uSplitShadow, uSplitHigh, smoothstep(0.05, 0.7, l)), uSplit);
      }
      // film grain
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 100.0) - 0.5;
      col += g * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// The 3D model ships in two resolutions: a heavy 4K-texture build (~100 MB) for
// large screens and a lighter build (~19 MB) for phones. Choose once at module
// load by device screen size — the model loads lazily and stays resident, so
// there's no need to react to later resizes. Vite serves public/ at the site
// root; BASE_URL keeps the path correct under a non-root deploy base (guarded so
// a non-Vite context never throws).
const MODEL_BASE = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/');
// Touch devices (phones AND tablets) never get the heavy 4K model: a large
// tablet like an iPad reports a longest dimension >= 1024 but has neither the
// GPU nor the memory headroom the desktop 4K asset assumes.
const IS_TOUCH_DEVICE = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
    || (typeof window !== 'undefined' && 'ontouchstart' in window);
// Whether the AUTOMATIC choice wants the heavy 4K model. A desktop-sized screen is
// a decent proxy for "has the GPU/memory for it": phones (even hi-DPI) report a
// longest CSS dimension well under 1024, and tablets are excluded via the touch
// check above. This is a model selector, not a screen query.
function autoWantsLargeModel() {
  return (typeof window !== 'undefined' && window.screen)
    ? Math.max(window.screen.width, window.screen.height) >= 1024 && !IS_TOUCH_DEVICE
    : true;
}
// User override for the 3D model (Options ▸ Display ▸ 3D MODEL SIZE): 'small'
// (default — the light 18 MB model, safe on every device), 'auto' (pick by
// device: the 4K model on desktop, light on phones/tablets), or 'large' (force
// the 4K model). Read FRESH at load time so changing it and reopening the viewer
// picks up the new choice. Written by main.js.
const VIBES_MODEL_KEY = 'c64emu.vibesModel';
function resolveModelUrl() {
  let pref = 'small';
  try { pref = localStorage.getItem(VIBES_MODEL_KEY) || 'small'; } catch { /* storage off */ }
  const large = pref === 'large' ? true : (pref === 'auto' ? autoWantsLargeModel() : false);
  return MODEL_BASE + (large ? 'commodore_64_4k.glb' : 'commodore_64.glb');
}

// Persisted camera view (position + orbit target) so the scene reopens where
// the user left it.
const CAM_KEY = 'c64emu.modelViewerCamera';
// Persisted scene (lighting/backdrop mood) index — see SCENES below.
const SCENE_KEY = 'c64emu.modelViewerScene';
// Persisted idle-spin (auto-rotate) on/off, so the viewer reopens rotating or
// standstill exactly as the user last left it.
const ROTATE_KEY = 'c64emu.modelViewerAutoRotate';
// Persisted promo mode (Cmd/Ctrl+Shift+P), so the viewer reopens as bare or as
// furnished as it was left — someone shooting a sequence of scenes should not
// have to strip the chrome again on every open.
const PROMO_KEY = 'c64emu.modelViewerPromo';

// ── Scenes ───────────────────────────────────────────────────────────────────
// Each scene keeps the SAME model + camera; only the lighting, surroundings and
// backdrop differ. build(group, ctx) adds this scene's lights/props to `group`
// (removed wholesale on switch); optional animate(group, t) runs each frame;
// `css` is the overlay backdrop class; `envInt` scales the RoomEnvironment IBL;
// optional `fog` = {color, near, far} (near/far ×sphere.radius). ctx = {sphere,box}.
const SCENES = [sceneSynthwave, sceneStarry, sceneSpotlight, sceneIkplus, sceneBedroom];

export class ModelViewer {
  constructor(overlayEl) {
    this.overlay = overlayEl;
    this.stage = overlayEl.querySelector('.model-viewer-stage') || overlayEl;
    this.loadingEl = overlayEl.querySelector('.model-viewer-loading');

    this.running = false;
    this.supported = false;   // set true once GL init succeeds
    this._glReady = false;
    this._modelLoaded = false;
    this._loading = false;

    // Live-screen wiring: a provider (set by main.js) returns the emulator's
    // current framebuffer, which we upload onto the monitor's CRT material.
    this.screenProvider = null;
    this._screenTex = null;
    this._screenDataRef = null;
    this._screenLight = { r: 0, g: 0, b: 0, luminance: 0, active: false };
    this._screenLightSampleAt = -Infinity;
    this._keycap = null;   // [removable prototype] RETURN keycap press animation
    this._leds = [];       // [{mat, source:'power'|'drive', on}] — LED emissive groups baked onto the model meshes
    // Fired on a double-click inside the 3D scene (main.js uses it to power the
    // C64 on when it's off, so the modelled TV lights up).
    this.onDoubleClick = null;
    // State providers (set by main.js), polled each frame to light the modelled
    // LEDs: powerProvider → true while the machine runs (C64 + drive power LEDs);
    // driveActiveProvider → true while the 1541 read/activity LED is lit.
    this.powerProvider = null;
    this.driveActiveProvider = null;
    // The touch joystick normally lives beside the 2D monitor. While this
    // overlay owns browser fullscreen it must be a descendant of the overlay or
    // the fullscreen API will neither display it nor route pointer events to it.
    this.touchControls = null;
    this._touchControlsHome = null;

    // Busy hooks (set by main.js): onBusyStart pauses + mutes the emulator, like
    // the PAUSE button; onBusyEnd resumes it. We hold the machine paused only
    // across the heavy open (GL init + model load + scene build + shader compile)
    // and close (exit-fullscreen + resize) transitions, so those main-thread
    // stalls can't starve the SID worklet's ring and make the audio jerk.
    this.onBusyStart = null;
    this.onBusyEnd = null;
    this._busy = false;
    this._busyExitTimer = null;   // close-side resume timer (see _scheduleBusyExit)
    this._framesSinceOpen = 0;
    this._lastResizeFrame = 0;
    this._sceneReadyFrames = 0;   // frames the current scene has rendered since it was built (counted only after the model loads); gates the busy resume

    this._model = null;           // loaded GLB scene (disposed on close, reloaded on open)

    // Scene (lighting/backdrop mood) state.
    this._sceneGroup = null;      // THREE.Group holding the active scene's lights/props
    this._sceneAnimate = null;    // optional per-frame animator for the active scene
    this._sceneBasic = false;     // scenes flagged basic bypass the composer (plain render)
    this._modelSphere = null;     // model bounds, for scene grids/floors/spotlight
    this._modelBox = null;
    // Post-processing (bloom + grade + SMAA). Null → fall back to plain render.
    this._composer = null;
    this._bloomPass = null;
    this._gradePass = null;
    // A remembered index can point past the end after a scene is removed —
    // clamp so it lands on the nearest scene instead of wrapping to the first.
    this._sceneIndex = (() => {
      try {
        const v = parseInt(localStorage.getItem(SCENE_KEY), 10);
        return Number.isInteger(v) ? Math.min(Math.max(v, 0), SCENES.length - 1) : 0;
      } catch { return 0; }
    })();
    // Promo mode (Cmd/Ctrl+Shift+P): remembered like the scene above.
    this._promoWanted = (() => {
      try { return localStorage.getItem(PROMO_KEY) === '1'; } catch { return false; }
    })();
    this._sceneBtn = overlayEl.querySelector('.model-viewer-scene');
    if (this._sceneBtn) this._sceneBtn.addEventListener('click', () => this.nextScene());

    // Fullscreen framer (⛶, under the scene button): tween to a head-on view
    // that fills the frame with the monitor. _camTween holds the in-flight
    // camera glide (null when idle; driven by _loop).
    this._camTween = null;
    this._fullscreenBtn = overlayEl.querySelector('.model-viewer-fullscreen');
    if (this._fullscreenBtn) this._fullscreenBtn.addEventListener('click', () => this.zoomToScreen());

    // Optional VR (WebXR): the button reveals itself only if the browser reports
    // an immersive-VR device (a real headset or the WebXR emulator extension).
    this._vrBtn = overlayEl.querySelector('.model-viewer-vr');
    this._xrSession = null;
    this._xrPending = false;   // true while a requestSession() is in flight (blocks double-entry)
    this._rig = null;
    this._initVrButton();

    this._loop = this._loop.bind(this);
    this._onResize = this._onResize.bind(this);

    // Exiting native fullscreen (Esc / F11 / browser UI) closes the viewer, so
    // the CSS overlay never lingers once fullscreen is gone.
    document.addEventListener('fullscreenchange', () => {
      // We intentionally leave fullscreen when entering VR (see _toggleVr); don't
      // let that count as a close.
      if (this._suppressFsClose) { this._suppressFsClose = false; return; }
      if (this.isOpen() && !document.fullscreenElement) this.close();
    });
  }

  // main.js calls this with a function returning { data, width, height } for the
  // live emulator framebuffer (or null when the machine isn't up yet). Called
  // every rendered frame while the viewer is open.
  setScreenProvider(fn) { this.screenProvider = fn; }

  // main.js supplies the double-click action (power-on-if-off).
  setOnDoubleClick(fn) { this.onDoubleClick = fn; }

  // main.js supplies a function returning true while the machine is powered on;
  // polled each frame to light the modelled red power LED.
  setPowerProvider(fn) { this.powerProvider = fn; }

  // main.js supplies a function returning true while the 1541 read/activity LED
  // is lit (the device-8 drive indicator); polled each frame for the drive's red LED.
  setDriveActiveProvider(fn) { this.driveActiveProvider = fn; }

  // main.js supplies the existing touch-control element, whose input listeners
  // and state remain intact when it is temporarily hosted by this overlay.
  setTouchControls(element) { this.touchControls = element; }

  // main.js supplies pause/resume actions run around the open/close transitions.
  setBusyHooks(onStart, onEnd) { this.onBusyStart = onStart; this.onBusyEnd = onEnd; }
  // Fired when the overlay goes up / comes down, so the page behind it can drop
  // work nobody can see. Distinct from the busy hooks, which only span the two
  // transitions.
  setVisibilityHooks(onShow, onHide) { this.onShow = onShow; this.onHide = onHide; }

  // ── VR (WebXR) ─────────────────────────────────────────────────────────────
  // Minimal, experimental immersive-VR: renders the scene in stereo with head
  // tracking. The button appears only when the browser reports a headset (a real
  // one, or the WebXR emulator extension) — so it stays invisible on desktop-
  // without-VR and on every phone/tablet. Post-processing (bloom/grade) is
  // skipped in VR (EffectComposer isn't XR-compatible), so the neon look is
  // flatter in the headset than on the 2D view.
  _initVrButton() {
    if (!this._vrBtn) return;
    if (typeof navigator === 'undefined' || !navigator.xr || !navigator.xr.isSessionSupported) return;
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      if (!ok) return;
      this._vrBtn.disabled = !this._modelLoaded;   // enabled once the model is framed (see _loadModel)
      this._vrBtn.hidden = false;
      this._vrBtn.addEventListener('click', () => this._toggleVr());
    }).catch(() => { /* feature-detect failed → button stays hidden */ });
  }

  _toggleVr() {
    if (!this.renderer || !navigator.xr) return;
    if (this.renderer.xr.isPresenting) { if (this._xrSession) this._xrSession.end(); return; }
    if (this._xrPending) return;   // a session request is already in flight — ignore a rapid re-click
    // Don't enter VR before the model is loaded + framed: the rig is seeded from
    // the current camera, so entering at the placeholder view would put VR at a
    // different viewport than the 3D scene (breaking the 1:1 invariant). The
    // button is kept disabled until then, but guard here too.
    if (!this._modelLoaded) return;
    // Leave DOM element-fullscreen for VR: in fullscreen the browser doesn't route
    // pointer events to elements OUTSIDE the fullscreen element, so the emulator's
    // injected page controls are visible but non-interactive. Exiting restores
    // them — and it's harmless on a real headset (the device shows the XR render
    // regardless of page fullscreen). Suppress the fullscreenchange auto-close.
    if (document.fullscreenElement && document.exitFullscreen) {
      this._suppressFsClose = true;
      document.exitFullscreen().catch(() => { this._suppressFsClose = false; });
    }
    // Latch a pending flag + disable the button so a rapid double-click can't fire
    // a second requestSession() before this one resolves.
    this._xrPending = true;
    if (this._vrBtn) this._vrBtn.disabled = true;
    navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })
      .then((session) => {
        // The viewer may have been closed while the headset handshake was in
        // flight (teardown nulled this.camera/scene). Don't present onto a torn-
        // down viewer — end the session so it doesn't dangle.
        if (!this.isOpen() || !this.camera) { try { session.end(); } catch { /* ignore */ } return; }
        this._xrSession = session;
        this.renderer.xr.setReferenceSpaceType('local');
        return this.renderer.xr.setSession(session);
      })
      .catch((err) => {
        console.warn('ModelViewer: could not start VR session.', err);
        // requestSession() can resolve (so _xrSession is assigned) while
        // setSession() then rejects — the session never presents. Don't leave a
        // dangling reference: end it and clear so a retry (or close()) starts clean.
        if (this._xrSession) { try { this._xrSession.end(); } catch { /* ignore */ } this._xrSession = null; }
      })
      .finally(() => {
        this._xrPending = false;
        // On success we're now presenting and the overlay (with the button) is
        // hidden — _onXrEnd re-enables the button on exit. On failure the overlay
        // is still up, so re-enable it here for another attempt.
        if (this._vrBtn && this.renderer && !this.renderer.xr.isPresenting) this._vrBtn.disabled = false;
      });
  }

  _onXrStart() {
    // Defensive: a session can only fire sessionstart after setSession(), which
    // the requestSession guard skips for a closed viewer — but if a session ever
    // starts after teardown, bail before dereferencing the nulled camera/scene.
    if (!this.camera || !this.scene) return;
    // Pause + mute across entry: the first per-eye render compiles new shaders (a
    // main-thread stall). _loop resumes the machine a couple of frames later.
    this._enterBusy();
    if (this.controls) this.controls.enabled = false;
    if (this._vrBtn) this._vrBtn.textContent = '🥽 EXIT VR';
    // Hide our overlay while presenting so it can't cover the WebXR emulator's
    // injected page controls (move/rotate the headset) or its relocated canvas.
    // The render loop keeps running — the WebGL canvas isn't in our overlay.
    this.overlay.style.visibility = 'hidden';
    // Snapshot the full desktop camera state; three overwrites this.camera every
    // VR frame with the headset pose + fov, so we restore these exactly on exit
    // (synchronously, before any save/close can persist the corrupted pose).
    this._preVr = {
      pos: this.camera.position.clone(),
      quat: this.camera.quaternion.clone(),
      fov: this.camera.fov,
      target: this.controls ? this.controls.target.clone() : new THREE.Vector3(),
    };
    // Place the rig at the desktop camera's world pose so VR continues from the
    // normal 3D view (1:1); the headset pose adds on top (navigate via the headset
    // / controllers). _preVr was captured with the rig at identity, so its pos/quat
    // are the desktop WORLD pose.
    if (this._rig) {
      this._rig.position.copy(this._preVr.pos);
      this._rig.quaternion.copy(this._preVr.quat);
      this._rig.scale.set(1, 1, 1);
      this._rig.updateMatrixWorld(true);
    }
    // Neutralise the camera child's own transform while presenting so the rig is
    // the SOLE carrier of the pose. three builds the eye cameras from
    // parent(rig).matrixWorld × head-pose and overwrites this.camera each XR frame
    // (WebXRManager.updateCamera / updateUserCamera), so the steady state is fine
    // either way — but zeroing here keeps any non-XR render during the transition
    // at a single offset instead of doubling it. _restorePreVrCamera() puts the
    // desktop pose back on exit.
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.camera.updateMatrixWorld(true);
    // VR skips the bloom/tone-mapping composer (it isn't XR-compatible), so add a
    // plain fill light so the model reads well — the scenes are lit assuming
    // bloom, and would otherwise be very dark in the headset.
    if (!this._xrFill) this._xrFill = new THREE.HemisphereLight(0xffffff, 0x606080, 3.0);
    this.scene.add(this._xrFill);
  }

  // Return the rig to identity and put this.camera back to the exact pre-VR
  // desktop pose (position, orientation, fov, target). three leaves this.camera at
  // the headset pose while presenting, so calling this synchronously means the 3D
  // view is correct the instant VR ends and no save/close can persist the headset
  // pose as the normal camera. Shared by _onXrEnd and close().
  _restorePreVrCamera() {
    if (this._rig) { this._rig.position.set(0, 0, 0); this._rig.quaternion.identity(); this._rig.updateMatrixWorld(true); }
    if (this._preVr && this.camera) {
      this.camera.position.copy(this._preVr.pos);
      this.camera.quaternion.copy(this._preVr.quat);
      this.camera.fov = this._preVr.fov;
      this.camera.updateProjectionMatrix();
      if (this.controls) this.controls.target.copy(this._preVr.target);
    }
  }

  _onXrEnd() {
    if (this._vrBtn) { this._vrBtn.textContent = '🥽 ENTER VR'; this._vrBtn.disabled = false; }
    this._xrSession = null;
    this.overlay.style.visibility = '';   // reveal the 2D overlay again
    // Back to the fullscreen 3D view — but only if the viewer is still open. When
    // VR is exited by CLOSING the viewer, close() has already restored the camera
    // and torn things down; don't re-grab fullscreen on the now-hidden overlay.
    if (this.isOpen() && this.overlay.requestFullscreen && !document.fullscreenElement) {
      this.overlay.requestFullscreen().catch(() => {});
    }
    if (this._xrFill && this.scene) this.scene.remove(this._xrFill);   // remove the VR fill light
    this._restorePreVrCamera();   // synchronous — 3D view is correct the instant VR ends
    if (this.controls) { this.controls.enabled = true; this.controls.update(); }
    // Defer only the framebuffer resize — setSize warns while still presenting.
    const restore = () => {
      if (!this.renderer) return;
      if (this.renderer.xr && this.renderer.xr.isPresenting) { requestAnimationFrame(restore); return; }
      this._onResize();
    };
    requestAnimationFrame(restore);
  }


  // Freeze + mute the emulator for the duration of a heavy transition (idempotent).
  _enterBusy() {
    // Cancel any pending close-resume + reset the settle counters first, so a
    // reopen landing inside the close window doesn't resume mid-load and still
    // arms _loop's "resize settled" resume.
    if (this._busyExitTimer) { clearTimeout(this._busyExitTimer); this._busyExitTimer = null; }
    this._framesSinceOpen = 0;
    this._lastResizeFrame = 0;   // updated by _onResize; resume waits until resizes stop
    if (this._busy) return;
    this._busy = true;
    try { this.onBusyStart && this.onBusyStart(); } catch { /* ignore */ }
  }
  // Resume the emulator once the transition has settled (idempotent).
  _exitBusy() {
    if (this._busyExitTimer) { clearTimeout(this._busyExitTimer); this._busyExitTimer = null; }
    if (!this._busy) return;
    this._busy = false;
    try { this.onBusyEnd && this.onBusyEnd(); } catch { /* ignore */ }
  }
  // After close(), the render loop is cancelled, so time the resume off a timer.
  // It must outlast the exit-fullscreen + page reflow AND be long enough that
  // audioCtx.suspend() actually engages before we resume — a 3-frame (~50ms)
  // window let suspend/resume cancel out, so no audible pause happened on close.
  _scheduleBusyExit() {
    if (this._busyExitTimer) clearTimeout(this._busyExitTimer);
    this._busyExitTimer = setTimeout(() => { this._busyExitTimer = null; this._exitBusy(); }, 400);
  }

  // One WebGLRenderer + canvas for the app lifetime, reused across every
  // open/close. Only the per-open scene contents (model, textures, render
  // targets) are allocated and freed each cycle; the GL context persists, so
  // teardown must free those explicitly (see _teardownGL / _disposeObject).
  _ensureRenderer() {
    if (this.renderer) return;
    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);            // transparent → CSS gradient shows through
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true;              // scenes cast soft shadows for realism
      renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoftShadowMap is deprecated in r184
      renderer.domElement.className = 'model-viewer-canvas';
      this.stage.appendChild(renderer.domElement);

      // Image-based-lighting cubemap, baked once and reused every open (it never
      // changes). Tagged _shared so disposal skips it; it lives with the context.
      const pmrem = new THREE.PMREMGenerator(renderer);
      this._envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this._envMap._shared = true;
      pmrem.dispose();

      // WebXR: enabling this lets renderer.setAnimationLoop drive the headset's
      // per-eye frame loop while presenting. Session start/end toggle the desktop
      // controls and reposition the viewer.
      renderer.xr.enabled = true;
      renderer.xr.addEventListener('sessionstart', () => this._onXrStart());
      renderer.xr.addEventListener('sessionend', () => this._onXrEnd());

      // Canvas-level input, wired once. Reads this.controls (the current open's
      // controls), so it keeps working across open/close without re-adding.
      // A plain tap/click (no drag) toggles the idle spin; a double-click or
      // double-tap fires onDoubleClick (the host powers the C64 on when off).
      let downX = 0, downY = 0, dragged = false;
      const el = renderer.domElement;
      // Reverse + (re)start the idle spin, or stop it if already spinning.
      const toggleSpin = () => {
        const controls = this.controls;
        if (!controls) return;
        if (controls.autoRotate) {
          controls.autoRotate = false;                          // spinning → stop
        } else {
          controls.autoRotateSpeed = -controls.autoRotateSpeed; // reverse, then…
          controls.autoRotate = true;                           // …start the other way
        }
        this._saveAutoRotate(controls.autoRotate);              // remember spin/standstill
      };
      el.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; dragged = false; });
      el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) dragged = true; });
      // Touch double-tap detection: mobile browsers don't reliably synthesize
      // dblclick, so pair up quick same-spot taps here. The single-tap spin
      // toggle is DEFERRED on touch so a double-tap doesn't also flip the spin.
      // OrbitControls sets touch-action:none on the canvas, so the browser's own
      // double-tap-zoom never competes with this.
      let lastTapAt = 0, lastTapX = 0, lastTapY = 0, tapTimer = null;
      const DBLTAP_MS = 300, DBLTAP_DIST = 32;
      el.addEventListener('pointerup', (e) => {
        if (dragged || !this.controls) return;
        if (e.pointerType !== 'touch') { toggleSpin(); return; }  // mouse/pen: power-on via dblclick below
        if (tapTimer !== null &&
            (e.timeStamp - lastTapAt) < DBLTAP_MS &&
            Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < DBLTAP_DIST) {
          clearTimeout(tapTimer); tapTimer = null; lastTapAt = 0;
          if (this.onDoubleClick) this.onDoubleClick();          // double-tap → power on when off
          return;
        }
        lastTapAt = e.timeStamp; lastTapX = e.clientX; lastTapY = e.clientY;
        if (tapTimer !== null) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { tapTimer = null; lastTapAt = 0; toggleSpin(); }, DBLTAP_MS);
      });
      // Desktop double-click anywhere in the scene → power on when off. Harmless
      // if a touch browser also synthesizes it — onDoubleClick is a no-op once on.
      el.addEventListener('dblclick', () => { if (this.onDoubleClick) this.onDoubleClick(); });

      // Context-loss recovery: the OS can drop the GL context under memory
      // pressure. Stop the loop while it is lost; on restore, rebuild the current
      // open's scene (its GPU resources died with the context).
      el.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();   // signal we will restore (else no restored event)
        if (this.running) { this.running = false; renderer.setAnimationLoop(null); }
      });
      el.addEventListener('webglcontextrestored', () => {
        if (!this.isOpen()) return;   // a closed viewer rebuilds on its next open
        try {
          this._teardownGL();
          this._initGL();
          this._loadModel();
          this._onResize();
          if (!this.running) { this.running = true; renderer.setAnimationLoop(this._loop); }
        } catch (err) {
          console.warn('ModelViewer: WebGL context restore failed.', err);
        }
      });

      this.renderer = renderer;   // assign LAST: a throw above leaves it null so open() can retry
    } catch (err) {
      // Roll back a partial init so the next open() retries from a clean slate.
      if (renderer) {
        try { renderer.dispose(); } catch { /* ignore */ }
        const c = renderer.domElement;
        if (c && c.parentNode) c.parentNode.removeChild(c);
      }
      this._envMap = null;
      this.renderer = null;
      throw err;
    }
  }

  // Deep-dispose a material: free its texture-valued props (map, normalMap, …)
  // then the material itself. Module-cached shared textures (tagged _shared) are
  // left alone — they persist for the app lifetime.
  _disposeMaterial(m) {
    if (!m) return;
    for (const k in m) {
      const v = m[k];
      if (v && v.isTexture && !v._shared) v.dispose();
    }
    if (typeof m.dispose === 'function') m.dispose();
  }

  // Dispose one scene object's GPU resources that geometry+material disposal
  // alone misses. Render-target owners and instanced buffers must be freed
  // explicitly while the GL context persists. (THREE.Water also owns a
  // reflection render target but exposes no handle to it — see _teardownGL.)
  _disposeObject(o) {
    if (o.isReflector && typeof o.dispose === 'function') o.dispose();               // reflection render target
    if (o.isInstancedMesh && typeof o.dispose === 'function') o.dispose();           // instanceMatrix buffer + VAO
    if (o.isLight && o.shadow && typeof o.shadow.dispose === 'function') o.shadow.dispose();   // shadow-map render target
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => this._disposeMaterial(m));
  }

  // ── Lazy WebGL setup (once) ──────────────────────────────────────────────
  _initGL() {
    if (this._glReady) return;

    this._ensureRenderer();          // one-time WebGL context/canvas — reused across open/close
    const renderer = this.renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    // Image-based lighting: the shared PMREM cubemap (_envMap). Its intensity is
    // set per scene (scene.environmentIntensity in _applyScene); per-scene lights
    // are added by _applyScene, not here.
    scene.environment = this._envMap;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 2000);
    camera.position.set(0, 0, 5);
    this.camera = camera;

    // Camera rig: parenting the camera in a group lets VR place the whole viewer
    // by moving the rig (three multiplies the XR camera by parent.matrixWorld).
    // The rig stays at identity on desktop, so OrbitControls and framing are
    // unaffected (camera local space == world space).
    this._rig = new THREE.Group();
    this._rig.add(camera);
    scene.add(this._rig);

    // OrbitControls: left-drag rotate, wheel / two-finger pinch zoom, right-drag
    // pan. Damping gives it inertia; autoRotate adds a slow idle spin that yields
    // to the user the moment they drag.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.autoRotate = this._readSavedAutoRotate();   // reopen in the last spin/standstill state
    controls.autoRotateSpeed = 0.35;
    // Dolly straight along the camera→target axis (target is the monitor, set in
    // _frameModel), so zooming in moves the camera toward the monitor rather than
    // toward the cursor.
    controls.zoomToCursor = false;
    this.controls = controls;

    // Persist the view whenever the user finishes an interaction (drag / zoom /
    // pan). 'end' does NOT fire from autoRotate, so this never spams localStorage.
    controls.addEventListener('end', () => this._saveCamera());
    // (canvas-level pointer/dblclick input is wired once in _ensureRenderer and
    // reads this.controls, which is rebuilt here on each open.)

    // Post-processing: RenderPass → Bloom → OutputPass (tonemap+sRGB) → Grade
    // (vignette/chroma/grain) → SMAA. Wrapped so a failure degrades to plain
    // renderer.render (see _loop). Per-scene bloom params set in _applyScene.
    try {
      const w = window.innerWidth, h = window.innerHeight;
      const composer = new EffectComposer(renderer);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.6, 0.6);
      // Bloom is the only pass with a real per-frame cost — a blur pyramid over
      // the whole frame, resized with the canvas. A phone pays for it in frame
      // rate, so it gets everything else (grade is one fullscreen shader) and
      // not this. EffectComposer skips a pass with `enabled === false`.
      bloom.enabled = !_lowPowerDevice();
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      const grade = new ShaderPass(GradeShader);
      composer.addPass(grade);
      const smaa = new SMAAPass();
      composer.addPass(smaa);
      this._composer = composer;
      this._bloomPass = bloom;
      this._gradePass = grade;
    } catch (err) {
      console.warn('ModelViewer: post-processing unavailable — plain render.', err);
      this._composer = null;
    }

    this._glReady = true;
    this.supported = true;
    this._onResize();
  }

  // ── Load the GLB (once) ──────────────────────────────────────────────────
  _loadModel() {
    if (this._modelLoaded || this._loading) return;
    this._loading = true;
    if (this._vrBtn) this._vrBtn.disabled = true;   // no VR entry until the model is framed
    this._setLoading('LOADING MODEL…');

    const modelUrl = resolveModelUrl();   // honour the Options ▸ Display model override
    new GLTFLoader().load(
      modelUrl,
      (gltf) => {
        // The viewer may have been closed while the (large) model was loading —
        // _teardownGL then nulled this.scene. Drop the late result on the floor.
        if (!this.scene) { this._loading = false; return; }
        this.scene.add(gltf.scene);
        this._model = gltf.scene;           // kept so close() can dispose it
        // Let the model cast + receive shadows (scene lights use shadow maps).
        gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this._wireScreen(gltf.scene);
        this._frameModel(gltf.scene);
        // [removable prototype] find the keyboard mesh and animate the RETURN cap.
        let kb = null;
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          if (mats.some((m) => m && m.name === 'computer_keyboard')) kb = o;
        });
        this._keycap = attachKeycapPresses(kb);
        this._wireLeds(gltf.scene);            // light the C64 + 1541 power/activity LEDs from emulator state
        this._applyScene(this._sceneIndex);   // build the lighting/backdrop mood
        this._modelLoaded = true;
        this._loading = false;
        if (this._vrBtn) this._vrBtn.disabled = false;   // model framed → VR is now 1:1 with the 3D view
        this._setLoading(null);
      },
      (ev) => {
        if (ev && ev.lengthComputable && ev.total) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          this._setLoading(`LOADING MODEL… ${pct}%`);
        } else if (ev && ev.loaded) {
          this._setLoading(`LOADING MODEL… ${(ev.loaded / 1048576).toFixed(1)} MB`);
        }
      },
      (err) => {
        console.error('ModelViewer: failed to load', modelUrl, err);
        this._loading = false;
        this._setLoading('COULD NOT LOAD MODEL');
        this._exitBusy();   // don't leave the machine paused if the model never loads
      },
    );
  }

  // Aim the camera + orbit target at the model's bounding sphere and pull back
  // to a distance that frames it with a small margin, regardless of the GLB's
  // own scale or off-origin placement.
  _frameModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this._modelBox = box;         // kept for scene grids / floors / spotlight aim
    this._modelSphere = sphere;
    const r = sphere.radius || 1;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (r / Math.sin(fov / 2)) * 0.56;   // <1 crops into the bounding sphere so the C64 fills the frame (its flat silhouette leaves margin inside the sphere)

    this.camera.near = Math.max(dist / 1000, 0.001);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = r * 0.2;
    this.controls.maxDistance = dist * 4;

    const saved = this._readSavedCamera();
    if (saved) {
      // Restore the user's last view. Widen the dolly limits if needed so the
      // saved distance isn't clamped away.
      this.camera.position.set(saved.p[0], saved.p[1], saved.p[2]);
      this.controls.target.set(saved.t[0], saved.t[1], saved.t[2]);
      const d = this.camera.position.distanceTo(this.controls.target);
      this.controls.maxDistance = Math.max(this.controls.maxDistance, d * 1.05);
      this.controls.minDistance = Math.min(this.controls.minDistance, d * 0.95);
    } else {
      // Default view: orbit + dolly centred on the MONITOR (the live screen is
      // the star), framed far enough that the whole setup is visible around it.
      const dir = new THREE.Vector3(0.7, 0.4, 1).normalize();
      const target = this._screenMesh
        ? new THREE.Box3().setFromObject(this._screenMesh).getCenter(new THREE.Vector3())
        : sphere.center.clone();
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, dist);
    }
    this.controls.update();
  }

  // Light the modelled power LEDs from the emulator's state. The GLB has no
  // separate LED objects — each lens is baked into a shared mesh — so we recolour
  // just the lens's own triangles: pick the triangles whose base-texture texel is
  // the LED colour (red / green), gated to a small region so we don't grab that
  // colour elsewhere on the mesh, reindex so they form a contiguous group, and
  // give that group its own emissive material. _loop ramps each material's
  // emissiveIntensity 0→on with its signal; at 0 the lens looks essentially
  // untouched. Regions are bounding-box fractions (measured offline against
  // the models):
  //   • C64 case:  red power LED (top, by the badge)      → power state
  //   • 1541 drive: green power LED (front, bottom-left)  → power state
  //   • 1541 drive: red read/activity LED (front, slot)   → drive read indicator
  _wireLeds(root) {
    let details = null, kb = null, body = null, drive = null;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => m && m.name === 'computer_details')) details = o;
      if (mats.some((m) => m && m.name === 'computer_keyboard')) kb = o;
      if (mats.some((m) => m && m.name === 'computer_main_body')) body = o;
      for (let p = o; p; p = p.parent) if (p.name && /1541/i.test(p.name)) { drive = o; break; }   // 1541 drive mesh
    });
    this._leds = [];

    // C64 power LED (red) — on the case top by the commodore badge.
    if (details && kb && body) {
      const caseBox = new THREE.Box3().setFromObject(kb).union(new THREE.Box3().setFromObject(body));
      const sx = caseBox.max.x - caseBox.min.x, sz = caseBox.max.z - caseBox.min.z;
      this._recolorLeds(details, [{
        gx: caseBox.min.x + sx * 0.888, gz: caseBox.min.z + sz * 0.168, gr: sx * 0.0125,
        mode: 'red', paint: 0xff1e00, source: 'power', on: 2.5,
      }]);
    }

    // 1541 drive — green power LED (bottom-left) + red read/activity LED (on the slot).
    if (drive) {
      const b = new THREE.Box3().setFromObject(drive);
      const dW = b.max.x - b.min.x, dD = b.max.z - b.min.z, gr = dW * 0.03;
      this._recolorLeds(drive, [
        { gx: b.min.x + dW * 0.096, gz: b.min.z + dD * 0.983, gr, mode: 'green', paint: 'texture', source: 'power', on: 1.2 },
        { gx: b.min.x + dW * 0.260, gz: b.min.z + dD * 0.997, gr, mode: 'red', paint: 'texture', source: 'drive', on: 1.7 },
      ]);
    }

    this._wireMonitorPowerLed(root);   // 1702 monitor: green POWER lamp (inner lens window)
  }

  // The 1702 monitor's front POWER lamp (commodore wordmark → rainbow stripes →
  // this lens → "POWER") is a moulded lens on the monitor_white body: a raised
  // rounded-rect frame, a recessed moat, then a flat inner window face at the
  // centre. The light is that inner window — we isolate its triangles (the large
  // near-front-facing face bounded by the moat) with a world-space box + a normal
  // test (so we get the flat window, not the moat's angled walls) and give them
  // their own green emissive material as a second geometry group. _loop ramps its
  // emissiveIntensity from the power signal like the other LEDs, so the window
  // glows green when the machine is on and is the plain grey lens when off. The
  // bounds are in the GLB's own world space (the loader applies no extra
  // transform) and the geometry is identical in both GLB builds, so they fit the
  // phone + 4K models alike.
  _wireMonitorPowerLed(root) {
    // monitor_white clads both the body and the small cap; the body carries the
    // branding — pick the mesh with the most triangles.
    let body = null, bestTris = -1;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (!mats.some((m) => m && m.name === 'monitor_white')) return;
      const tris = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
      if (tris > bestTris) { bestTris = tris; body = o; }
    });
    const geo = body && body.geometry;
    if (!geo || !geo.index) return;

    // World-space box around the flat inner light-window face (measured from the
    // GLB); NZMIN keeps only near-front-facing triangles so the moat walls that
    // border the window are left dark.
    const BX0 = 0.397, BX1 = 0.453, BY0 = 0.657, BY1 = 0.672, BZ0 = -0.048, BZ1 = -0.036, NZMIN = 0.85;
    body.updateWorldMatrix(true, true);
    const wm = body.matrixWorld, pos = geo.attributes.position, idx = geo.index;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
    const inside = [], rest = [];
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      A.fromBufferAttribute(pos, a).applyMatrix4(wm);
      B.fromBufferAttribute(pos, b).applyMatrix4(wm);
      C.fromBufferAttribute(pos, c).applyMatrix4(wm);
      const mx = (A.x + B.x + C.x) / 3, my = (A.y + B.y + C.y) / 3, mz = (A.z + B.z + C.z) / 3;
      let hit = mx >= BX0 && mx <= BX1 && my >= BY0 && my <= BY1 && mz >= BZ0 && mz <= BZ1;
      if (hit) { e1.subVectors(B, A); e2.subVectors(C, A); nrm.crossVectors(e1, e2).normalize(); hit = Math.abs(nrm.z) >= NZMIN; }
      (hit ? inside : rest).push(a, b, c);
    }
    if (!inside.length) { console.warn('ModelViewer: monitor power-lens window not found — skipped.'); return; }

    // Reindex so the window triangles form a contiguous second group with their
    // own emissive material; the rest keep the body's original material.
    const base = Array.isArray(body.material) ? body.material[0] : body.material;
    const merged = new Uint32Array(rest.length + inside.length);
    merged.set(rest, 0); merged.set(inside, rest.length);
    geo.setIndex(new THREE.BufferAttribute(merged, 1));
    geo.clearGroups();
    geo.addGroup(0, rest.length, 0);              // untouched body, original material
    geo.addGroup(rest.length, inside.length, 1);  // lens window, green emissive
    const m = base.clone();
    m.emissive = new THREE.Color(0x2fe63a);
    m.emissiveIntensity = 0;             // _loop lights it with the power signal
    m.roughness = 0.5; m.metalness = 0;  // matte → the emissive glows evenly
    m.roughnessMap = m.metalnessMap = null;
    m.name = 'monitor_power_led';
    body.material = [base, m];
    this._leds.push({ mat: m, source: 'power', on: 2.2 });
  }

  // Recolour one or more LED lenses on `mesh`. Each target: { gx, gz, gr (gate
  // centre X/Z + radius), mode 'red'|'green', paint (a hex colour, or 'texture' to
  // use the lens's own most-saturated texel), source 'power'|'drive', on (lit
  // emissiveIntensity) }. Reindexes the mesh so each lens's triangles form a
  // contiguous group with its own emissive material, recorded in this._leds.
  _recolorLeds(mesh, targets) {
    const geo = mesh.geometry, base = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material, map = base && base.map;
    if (!geo.index || !geo.attributes.uv || !map || !map.image) { console.warn('ModelViewer: LED mesh missing index/uv/map — skipped.'); return; }

    // Read the base-colour texture into a pixel buffer (same-origin GLB → not tainted).
    const img = map.image, tw = img.width, th = img.height;
    const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
    const cctx = cv.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(img, 0, 0);
    let px;
    try { px = cctx.getImageData(0, 0, tw, th).data; }
    catch (e) { console.warn('ModelViewer: LED base map not readable — skipped.', e); return; }

    mesh.updateWorldMatrix(true, true);
    const wm = mesh.matrixWorld, pos = geo.attributes.position, uv = geo.attributes.uv, idx = geo.index, v = new THREE.Vector3();
    const at = (i) => v.fromBufferAttribute(pos, i).applyMatrix4(wm);   // reused — read .x/.z immediately
    const texel = (a, b, c) => {
      const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, w = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
      const wy = map.flipY ? 1 - w : w;
      const spx = Math.min(tw - 1, Math.max(0, ((u % 1 + 1) % 1 * tw) | 0));
      const spy = Math.min(th - 1, Math.max(0, ((wy % 1 + 1) % 1 * th) | 0));
      const k = (spy * tw + spx) * 4;
      return [px[k], px[k + 1], px[k + 2]];
    };
    const isHue = (mode, r, g, bl) => mode === 'green' ? (g > 80 && g > r * 1.3 && g > bl * 1.3) : (r > 90 && r > g * 1.5 && r > bl * 1.5);
    const sat = (mode, r, g, bl) => mode === 'green' ? g - Math.max(r, bl) : r - Math.max(g, bl);

    const rest = [], buckets = targets.map(() => []), best = targets.map(() => ({ s: -1, col: [200, 200, 200] }));
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      const ax = at(a).x, az = v.z, bx = at(b).x, bz = v.z, cx3 = at(c).x, cz3 = v.z;
      const mx = (ax + bx + cx3) / 3, mz = (az + bz + cz3) / 3;
      let placed = false;
      for (let g = 0; g < targets.length; g++) {
        const tg = targets[g];
        if (Math.hypot(mx - tg.gx, mz - tg.gz) < tg.gr) {
          const [r, gr2, bl] = texel(a, b, c);
          if (isHue(tg.mode, r, gr2, bl)) {
            buckets[g].push(a, b, c);
            const s = sat(tg.mode, r, gr2, bl);
            if (s > best[g].s) { best[g].s = s; best[g].col = [r, gr2, bl]; }
            placed = true; break;
          }
        }
      }
      if (!placed) rest.push(a, b, c);
    }

    const parts = [rest, ...buckets], merged = new Uint32Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0; const offs = [];
    for (const p of parts) { merged.set(p, off); offs.push([off, p.length]); off += p.length; }
    geo.setIndex(new THREE.BufferAttribute(merged, 1));
    geo.clearGroups();
    geo.addGroup(offs[0][0], offs[0][1], 0);   // untouched mesh, original material

    const mats = [base];
    for (let g = 0; g < targets.length; g++) {
      const [o, len] = offs[g + 1];
      if (!len) { console.warn('ModelViewer: an LED lens was not found — skipped.'); continue; }
      const tg = targets[g], m = base.clone();   // keeps the lens's own base map/UVs
      if (tg.paint === 'texture') {
        const c = best[g].col, peak = Math.max(c[0], c[1], c[2]) || 1;   // normalise the sampled colour so it stays vivid
        m.emissive = new THREE.Color(c[0] / peak, c[1] / peak, c[2] / peak).convertSRGBToLinear();
      } else {
        m.emissive = new THREE.Color(tg.paint);
      }
      m.emissiveIntensity = 0;                   // _loop lights it with its signal
      m.roughness = 0.5;                         // matte → the emissive glows evenly (no glossy specular gap)
      m.metalness = 0;
      m.roughnessMap = m.metalnessMap = null;
      m.name = 'power_led';
      geo.addGroup(o, len, mats.length);
      mats.push(m);
      this._leds.push({ mat: m, source: tg.source, on: tg.on });
    }
    mesh.material = mats;
  }

  // Read the persisted camera view, or null if absent/malformed.
  _readSavedCamera() {
    try {
      const raw = localStorage.getItem(CAM_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (o && Array.isArray(o.p) && o.p.length === 3 && Array.isArray(o.t) && o.t.length === 3 &&
          o.p.every(Number.isFinite) && o.t.every(Number.isFinite)) return o;
    } catch { /* ignore malformed / storage-disabled */ }
    return null;
  }

  // Persist the current camera position + orbit target. Guarded on the model
  // being loaded so we never save the pre-framing placeholder view.
  _saveCamera() {
    if (!this._modelLoaded || !this.camera || !this.controls) return;
    try {
      const p = this.camera.position, t = this.controls.target;
      localStorage.setItem(CAM_KEY, JSON.stringify({ p: [p.x, p.y, p.z], t: [t.x, t.y, t.z] }));
    } catch { /* storage disabled — non-fatal */ }
  }

  // Idle-spin state persistence. Default on (spinning) when nothing is stored, so
  // a first-time viewer still greets with the slow auto-rotate.
  _readSavedAutoRotate() {
    try { return localStorage.getItem(ROTATE_KEY) !== '0'; }
    catch { return true; }
  }
  _saveAutoRotate(on) {
    try { localStorage.setItem(ROTATE_KEY, on ? '1' : '0'); } catch { /* storage off */ }
  }

  // Advance to the next scene (wraps). Wired to the bottom-right scene button.
  nextScene() {
    // Pause + mute across the swap: tearing down the old scene and building the
    // new one (plus its first shader compile) stalls the main thread. _loop
    // resumes once the new scene is fully ready (see its busy-exit logic).
    this._enterBusy();
    this._applyScene(this._sceneIndex + 1);
  }

  // Frame the monitor head-on and as large as it will go — the ⛶ fullscreen
  // button under the scene toggler. Aims straight down the CRT glass's own
  // normal and dollies to the distance where the screen just fits the viewport
  // (limited by whichever of its width/height is tighter for the live aspect),
  // then glides the camera there. Auto-spin stops so the head-on view holds.
  zoomToScreen() {
    if (!this._modelLoaded || !this.camera || !this.controls) return;

    // Prefer the monitor glass; fall back to the whole-model bounds if the
    // screen mesh wasn't found (live screen disabled — see _wireScreen).
    let center, width, height, normal;
    const mesh = this._screenMesh;
    if (mesh) {
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
      mesh.matrixWorld.decompose(pos, quat, scale);
      // The glass is a frontal rectangle in local XY (planar UVs map X→u, Y→v),
      // so its own width/height are the local extents scaled to world, and its
      // outward face is local +Z. Using the mesh's own dims (not the world AABB)
      // keeps the fit correct even if the model is rotated off-axis.
      width  = (bb.max.x - bb.min.x) * scale.x;
      height = (bb.max.y - bb.min.y) * scale.y;
      center = bb.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();
    } else if (this._modelSphere) {
      center = this._modelSphere.center.clone();
      width = height = this._modelSphere.radius * 2;
      normal = new THREE.Vector3(0.7, 0.4, 1).normalize();
    } else {
      return;
    }

    // Face the glass from the side the camera is already on — the GLB's normal
    // sign isn't guaranteed to point out the front.
    if (normal.dot(this.camera.position.clone().sub(center)) < 0) normal.negate();

    // Fit distance: the larger of the width- and height-limited pullbacks for
    // the current aspect, with a hair of margin so the glass sits inside the
    // frame rather than clipped hard at the edge.
    const vFov = (this.camera.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    const distH = (height / 2) / Math.tan(vFov / 2);
    const distW = (width / 2) / (Math.tan(vFov / 2) * aspect);
    const dist = Math.max(distH, distW) * 1.04;

    // Widen the dolly limits so the close framing isn't clamped, and pull the
    // near plane in for the tight shot.
    this.controls.minDistance = Math.min(this.controls.minDistance, dist * 0.5);
    this.controls.maxDistance = Math.max(this.controls.maxDistance, dist * 4);
    this.camera.near = Math.max(dist / 1000, 0.001);
    this.camera.updateProjectionMatrix();

    // Hold the head-on view: stop the idle spin (and remember it), then glide.
    if (this.controls.autoRotate) { this.controls.autoRotate = false; this._saveAutoRotate(false); }
    this._camTween = {
      fromPos: this.camera.position.clone(),
      toPos: center.clone().addScaledVector(normal, dist),
      fromTarget: this.controls.target.clone(),
      toTarget: center.clone(),
      t0: performance.now(),
      dur: 620,
    };
  }

  // Advance the in-flight fullscreen-framer glide (see zoomToScreen). Drives the
  // camera manually while it runs — _loop skips controls.update() so OrbitControls
  // doesn't fight it — then hands back to the controls once done (position + target
  // match, so its next update() resyncs without a jump).
  _updateCamTween() {
    const a = this._camTween;
    const k = Math.min((performance.now() - a.t0) / a.dur, 1);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // easeInOutCubic
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
    this.camera.lookAt(this.controls.target);
    if (k >= 1) {
      this._camTween = null;
      this.controls.update();   // resync the orbit state from the final pose
      this._saveCamera();       // persist the fullscreen framing as the current view
    }
  }

  // Swap in scene `i` (mod SCENES.length): tear down the previous scene group,
  // build the new one's lights/props, set its env intensity + backdrop class,
  // and persist the choice. Safe to call before/after model load.
  _applyScene(i) {
    if (!this.scene) return;
    const n = ((i % SCENES.length) + SCENES.length) % SCENES.length;
    this._sceneIndex = n;
    try { localStorage.setItem(SCENE_KEY, String(n)); } catch { /* storage off */ }

    // Dispose the previous scene's group — geometry, materials/textures, and the
    // render-target / instanced owners _disposeObject handles (reflector, shadow
    // maps, instanced dust). Lights without shadows need no disposal.
    if (this._sceneGroup) {
      this.scene.remove(this._sceneGroup);
      this._sceneGroup.traverse((o) => this._disposeObject(o));
      this._sceneGroup = null;
    }

    const def = SCENES[n];
    // IBL: a scene may supply its own envMap(renderer) (e.g. IK+'s sunset sky);
    // default is the shared neutral RoomEnvironment PMREM.
    this.scene.environment = (def.envMap && this.renderer && def.envMap(this.renderer)) || this._envMap;
    this.scene.environmentIntensity = def.envInt;
    // Tone mapping: `tone: 'none'` renders raw (punchy neon, e.g. Synthwave);
    // otherwise ACES (also what the composer's OutputPass uses).
    this.renderer.toneMapping = def.tone === 'none' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    // Per-scene exposure (a dusk scene dials it down for mood); default 1.05.
    this.renderer.toneMappingExposure = def.exposure || 1.05;
    // Opaque in-scene background (gradient sky) — lets the bloom composite cleanly
    // and gives reflections something to catch. A scene may instead build its own
    // sky (e.g. Synthwave's dome) and leave bg unset. Falls back to the CSS backdrop.
    this.scene.background = def.bg ? bgTexture(def.css, def.bg) : null;
    // Per-scene bloom tuning.
    if (this._bloomPass && def.bloom) {
      this._bloomPass.strength = def.bloom.strength;
      this._bloomPass.radius = def.bloom.radius;
      this._bloomPass.threshold = def.bloom.threshold;
    }
    // Halation: film scatters longest in its red layer, so a bleed is white at the
    // core and warm at the edges. The five mips run widest-last, hence the ramp.
    if (this._bloomPass && Array.isArray(this._bloomPass.bloomTintColors)) {
      const t = def.halation || [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]];
      this._bloomPass.bloomTintColors.forEach((v, i) => {
        const c = t[i] || t[t.length - 1];
        v.set(c[0], c[1], c[2]);
      });
    }
    // Null rather than false: _setScreenLive early-returns on an unchanged flag, so
    // a scene switch while powered off would otherwise keep the previous glass.
    this._sceneScreenOff = !!def.screenOff;
    if (!this._screenLive) this._screenLive = null;
    if (this._gradePass) {
      const u = this._gradePass.uniforms, gr = def.grade || {};
      u.uSplit.value = gr.split || 0;
      u.uSplitShadow.value.fromArray(gr.shadow || [1, 1, 1]);
      u.uSplitHigh.value.fromArray(gr.highlight || [1, 1, 1]);
    }
    const sphere = this._modelSphere || new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3);
    const box = this._modelBox || new THREE.Box3(new THREE.Vector3(-3, -3, -3), new THREE.Vector3(3, 3, 3));
    // Optional atmospheric fog (e.g. golden-hour haze), scaled to the model.
    this.scene.fog = def.fog
      ? new THREE.Fog(def.fog.color, def.fog.near * sphere.radius, def.fog.far * sphere.radius)
      : null;
    // World-space CRT dimensions and outward direction, so a scene can treat
    // the live glass as an area emitter rather than an omnidirectional point.
    let screen = null;
    if (this._screenMesh) {
      const mesh = this._screenMesh;
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
      mesh.matrixWorld.decompose(pos, quat, scale);
      const center = bb.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();
      // The setup's bounds identify the outside even if a model revision flips
      // the glass winding/local normal.
      if (normal.dot(center.clone().sub(sphere.center)) < 0) normal.negate();
      screen = {
        center, normal,
        width: (bb.max.x - bb.min.x) * Math.abs(scale.x),
        height: (bb.max.y - bb.min.y) * Math.abs(scale.y),
      };
    }
    const g = new THREE.Group();
    def.build(g, { sphere, box, screen });
    this.scene.add(g);
    this._sceneGroup = g;
    this._sceneAnimate = def.animate || null;
    this._sceneBasic = !!def.basic;   // basic scenes render without the post pipeline

    for (const s of SCENES) this.overlay.classList.remove(s.css);
    this.overlay.classList.add(def.css);
    if (this._sceneBtn) this._sceneBtn.title = `Scene: ${def.name} — click to change`;

    // Freshly built: make _loop's busy-exit wait for a couple of rendered frames
    // (first shader compile + composite) before resuming the machine.
    this._sceneReadyFrames = 0;
  }

  // Find the 1702 monitor's CRT surface (material "monitor_screen") and swap it
  // for an unlit material whose map is a DataTexture we refill from the live
  // emulator framebuffer each frame — so the running C64 shows ON the modelled
  // TV. Unlit (MeshBasicMaterial) + toneMapped:false so the screen reads as a
  // self-emitting CRT at the true VIC palette, untouched by the scene's neon
  // lights or ACES tone mapping. Nearest filtering keeps the chunky C64 pixels.
  _wireScreen(root) {
    let screenMesh = null;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => m && m.name === 'monitor_screen')) screenMesh = o;
    });
    if (!screenMesh) {
      console.warn('ModelViewer: "monitor_screen" material not found — live screen disabled.');
      return;
    }

    // The mesh ships a rotated, partial-atlas UV set for the glass, which fought
    // orientation/aspect. Recompute clean planar UVs straight from the glass
    // geometry: local X → u (left→right), Y → v (bottom→top). The glass is an
    // almost-flat frontal rectangle, so this projects the framebuffer onto it
    // undistorted, upright, covering the whole glass at its native ~4:3 aspect —
    // no texture rotation / repeat / offset needed.
    const geo = screenMesh.geometry;
    const pos = geo.attributes.position;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    const wx = (xmax - xmin) || 1, hy = (ymax - ymin) || 1;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2]     = (pos.getX(i) - xmin) / wx;
      uv[i * 2 + 1] = (pos.getY(i) - ymin) / hy;
    }
    // Keep the mesh's ORIGINAL UVs — the stock glass material samples an atlas
    // through them, so we must restore them (alongside the material) whenever we
    // revert to the untouched monitor. Only the live feed uses the planar UVs.
    this._screenGeo = geo;
    this._origUV = geo.attributes.uv;
    this._planarUV = new THREE.BufferAttribute(uv, 2);

    const W = 384, H = 272;   // vic2 CANVAS_W × CANVAS_H
    const tex = new THREE.DataTexture(new Uint8Array(W * H * 4), W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;   // framebuffer bytes are sRGB
    tex.magFilter = THREE.NearestFilter;     // chunky C64 pixels up close
    // Nearest minification point-samples: a 1px font stem hits a device pixel or
    // misses, and which way it falls moves with the camera, so text crawls.
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    if (this.renderer && this.renderer.capabilities) {
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    }
    tex.flipY = true;                        // framebuffer row 0 (picture top) → texture v=1 (glass top)
    tex.needsUpdate = true;

    const liveMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    // CRT effect for the powered-on screen: horizontal scanlines + a soft corner
    // vignette, injected into the final fragment colour. Done via onBeforeCompile
    // (not a raw ShaderMaterial) so three still handles the framebuffer's sRGB
    // decode/encode — we only modulate the output. Applied to the LIVE material
    // only, so it shows exactly when powered on; the stock glass stays untouched.
    liveMat.onBeforeCompile = (shader) => {
      shader.uniforms.uScanCount = { value: 272.0 };  // one line per C64 raster
      shader.uniforms.uScanDepth = { value: 0.28 };   // scanline darkness
      shader.uniforms.uVignette  = { value: 0.30 };   // corner falloff
      shader.uniforms.uGain      = { value: 1.12 };    // compensate the average dimming
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `
          uniform float uScanCount;
          uniform float uScanDepth;
          uniform float uVignette;
          uniform float uGain;
          void main() {`)
        .replace('#include <colorspace_fragment>', `
          #include <colorspace_fragment>
          {
            float scan = 0.5 + 0.5 * cos( vMapUv.y * uScanCount * 6.2831853 );
            // Under ~2 device pixels a period the cosine aliases into moire that
            // swims with the camera, so fade out near Nyquist (fwidth = UV per pixel).
            float fade = 1.0 - smoothstep( 0.25, 0.5, fwidth( vMapUv.y ) * uScanCount );
            float lines = 1.0 - uScanDepth * scan * fade;
            vec2 vc = vMapUv - 0.5;
            float vig = clamp( 1.0 - uVignette * dot( vc, vc ) * 4.0, 0.0, 1.0 );
            // uGain undoes the scanlines' dimming, so it retreats with them.
            gl_FragColor.rgb *= lines * vig * mix( 1.0, uGain, fade );
          }
        `);
    };

    // Keep the original screen material so we can restore the untouched monitor
    // when the machine is powered off (the live feed is swapped in only while the
    // C64 is running — see _updateScreen).
    this._screenMesh = screenMesh;
    if (Array.isArray(screenMesh.material)) {
      this._screenMatIndex = screenMesh.material.findIndex((m) => m && m.name === 'monitor_screen');
      this._origMaterial = screenMesh.material.slice();
    } else {
      this._screenMatIndex = -1;
      this._origMaterial = screenMesh.material;
    }
    this._liveMaterial = liveMat;
    // The model's stock glass is a pale grey that reads as a lit screen in a dark
    // room. A scene can ask for a dead tube instead (`screenOff`): near-black, but
    // still glossy, so it stays glass rather than becoming a hole.
    this._offMaterial = new THREE.MeshStandardMaterial({
      name: 'monitor_screen_off', color: 0x05060a, roughness: 0.22, metalness: 0,
    });
    this._screenTex = tex;
    this._screenDataRef = null;
    this._screenLive = false;   // starts on the original (untouched) glass
  }

  // Swap the glass between the live-feed material and the model's original one.
  // The UVs swap in lockstep: the live feed uses the planar UVs, the stock glass
  // its original atlas UVs — restoring both leaves the powered-off monitor exactly
  // as the model shipped it.
  _setScreenLive(live) {
    if (!this._screenMesh || this._screenLive === live) return;
    this._screenLive = live;
    if (this._screenGeo && this._origUV && this._planarUV) {
      this._screenGeo.setAttribute('uv', live ? this._planarUV : this._origUV);
    }
    const off = this._sceneScreenOff && this._offMaterial;
    if (this._screenMatIndex >= 0) {
      const arr = this._screenMesh.material.slice();
      arr[this._screenMatIndex] = live ? this._liveMaterial
        : (off || this._origMaterial[this._screenMatIndex]);
      this._screenMesh.material = arr;
    } else {
      this._screenMesh.material = live ? this._liveMaterial : (off || this._origMaterial);
    }
  }

  // Push the current emulator frame into the CRT texture. The framebuffer array
  // is replaced whenever the machine is re-created (power / reset), so re-point
  // the texture at the new buffer only when the reference actually changes;
  // otherwise just flag it dirty so the same buffer re-uploads. When the machine
  // is powered off the provider returns null, and we restore the original glass.
  _updateScreen(time = 0) {
    // Only touch the CRT texture while the viewer is actually on screen. The
    // render loop already only runs while open (open()→RAF, close()→cancel), so
    // this is belt-and-suspenders: no framebuffer upload happens when hidden.
    if (!this.running) return;
    const tex = this._screenTex;
    if (!tex || !this.screenProvider) return;
    const src = this.screenProvider();
    if (!src || !src.data) {
      this._screenLight.active = false;
      this._setScreenLive(false);
      return;
    }   // powered off → untouched monitor
    this._setScreenLive(true);
    if (src.data !== this._screenDataRef) {
      this._screenDataRef = src.data;
      const data = src.data instanceof Uint8Array
        ? src.data
        : new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength);
      tex.image = { data, width: src.width, height: src.height };
    }
    tex.needsUpdate = true;
    // Lighting reacts at 10 Hz; sampling a fixed 16×12 grid in linear light is
    // enough to follow scene colour without scanning 104k pixels per RAF.
    if (time - this._screenLightSampleAt >= 100) {
      sampleScreenLight(src.data, src.width, src.height, this._screenLight);
      this._screenLightSampleAt = time;
    }
  }

  _setLoading(text) {
    if (!this.loadingEl) return;
    if (text == null) { this.loadingEl.style.display = 'none'; return; }
    this.loadingEl.textContent = text;
    this.loadingEl.style.display = 'block';
  }

  _onResize() {
    if (!this.renderer || !this.camera) return;   // camera is null while closed (renderer now persists)
    // three owns the framebuffer size while presenting in VR; calling setSize
    // then warns "Can't change size while VR device is presenting".
    if (this.renderer.xr && this.renderer.xr.isPresenting) return;
    if (this._busy) this._lastResizeFrame = this._framesSinceOpen;   // keep paused until resizes settle
    const w = window.innerWidth;
    const h = window.innerHeight;
    // updateStyle=false: the CSS keeps the canvas at 100%×100% of the overlay;
    // the drawing buffer tracks the viewport (× capped DPR) for crispness.
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._composer) this._composer.setSize(w, h);
  }

  _loop(time, frame) {
    if (!this.running) return;
    this._updateScreen(time);        // live emulator frame → CRT texture + sampled spill colour
    const powered = !!(this.powerProvider && this.powerProvider());
    if (this._leds.length) {   // ramp each LED's emissive from its signal (power / drive-activity)
      const driveOn = !!(this.driveActiveProvider && this.driveActiveProvider());
      for (let i = 0; i < this._leds.length; i++) { const l = this._leds[i]; l.mat.emissiveIntensity = ((l.source === 'drive' ? driveOn : powered) ? l.on : 0); }   // indexed: no per-frame iterator alloc
    }
    if (this._keycap) this._keycap.update();   // [removable prototype] RETURN keycap
    const t = performance.now() * 0.001;
    if (this._sceneAnimate) this._sceneAnimate(this._sceneGroup, t, powered, this._screenLight);   // scenes may gate FX (e.g. the CRT) on power
    const presenting = this.renderer.xr.isPresenting;
    // Desktop view: a fullscreen-framer glide (if running) drives the camera and
    // suppresses OrbitControls' own update for its duration; otherwise controls
    // apply damping + autoRotate. Head tracking owns the VR view.
    if (!presenting) {
      if (this._camTween) this._updateCamTween();
      else this.controls.update();
    }
    if (presenting) {
      // WebXR renders per-eye to the XR framebuffer; EffectComposer isn't
      // XR-compatible, so VR always uses a plain render (no bloom/grade).
      this.renderer.render(this.scene, this.camera);
    } else if (this._composer && !this._sceneBasic) {
      if (this._gradePass) this._gradePass.uniforms.uTime.value = t;
      this._composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);   // basic scenes: plain, no bloom/grade
    }

    // Resume the machine only once the scene is fully ready: the model is loaded,
    // the just-built scene has rendered ≥2 frames (so its first shader compile +
    // composite happens while paused), and the transition's resizes have settled
    // (fullscreen enter reallocates GL buffers — a stall we stay paused through).
    // Scene-ready frames are counted ONLY after the model loads, so a slow first-
    // time download keeps the machine paused instead of resuming mid-load. The
    // cap is a post-load safety net; closing the viewer always resumes anyway.
    if (this._busy) {
      this._framesSinceOpen++;
      if (this._modelLoaded) this._sceneReadyFrames++;
      const resizeSettled = (this._framesSinceOpen - this._lastResizeFrame) >= 2;
      const ready = this._modelLoaded && this._sceneReadyFrames >= 2 && resizeSettled;
      if (ready || this._sceneReadyFrames >= 180) this._exitBusy();
    }
  }

  // ── Promo mode ───────────────────────────────────────────────────────────
  // Strips the viewer to the scene and the C64 READY. logo — no hint, no credit,
  // no buttons — for screenshots and video. Everything hidden is CSS-only
  // (.promo on the overlay), so the render loop, the camera and the live screen
  // texture all carry on untouched.
  //
  // The shortcut is the only way in and out: Escape keeps its usual job of
  // closing the viewer, promo or not, and takes no layer of its own.
  // Remembered across opens, like the scene and the idle spin: `_promoWanted` is
  // the preference, the .promo class is only how an OPEN viewer shows it. close()
  // strips the class without touching the preference, so the next open comes back
  // the way it was left.
  isPromo() { return !!this.overlay?.classList.contains('promo'); }

  setPromo(on) {
    this._promoWanted = !!on;
    try { localStorage.setItem(PROMO_KEY, on ? '1' : '0'); } catch { /* storage off */ }
    this._applyPromo(on);
  }

  togglePromo() { this.setPromo(!this.isPromo()); }

  _applyPromo(on) {
    if (!this.overlay || this.isPromo() === !!on) return;
    // A control that is about to be display:none must not keep focus — the same
    // a11y rule close() follows when it hides the overlay.
    if (on && this.overlay.contains(document.activeElement)) document.activeElement.blur();
    this.overlay.classList.toggle('promo', !!on);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  open() {
    // Escape closes the overlay, via the shared stack rather than a listener of
    // its own: while this is up it IS the topmost layer, which a bubble-phase
    // handler could never express.
    this._escapeLayer ??= { close: () => this.close(), isOpen: () => this.isOpen() };
    pushEscapeLayer(this._escapeLayer);
    this._applyPromo(this._promoWanted);   // promo, if that's how it was left
    if (this.onShow) this.onShow();
    // Pause + mute the machine up front: GL init, model load, scene build and the
    // first-frame shader compile all block the main thread; a running machine would
    // underrun the SID ring during that stall. _loop resumes once it's on screen.
    this._enterBusy();
    try {
      this._initGL();
    } catch (err) {
      console.warn('ModelViewer: WebGL unavailable — 3D view disabled.', err);
      this.supported = false;
    }
    this._touchControlsHome =
      hostTouchControls(this.touchControls, this.overlay) || this._touchControlsHome;
    this.overlay.hidden = false;
    this.overlay.setAttribute('aria-hidden', 'false');
    // Go true fullscreen (fills the whole screen, past the browser chrome), like
    // the emulator's own fullscreen mode. Called inside the double-click gesture
    // so the request is allowed; falls back to the CSS full-viewport overlay if
    // the browser refuses. The fullscreenchange handler closes the viewer on exit.
    if (this.overlay.requestFullscreen) this.overlay.requestFullscreen().catch(() => {});
    if (!this.supported) { this._setLoading('3D VIEW UNAVAILABLE'); this._exitBusy(); return; }

    this._loadModel();
    this._onResize();
    window.addEventListener('resize', this._onResize);
    if (!this.running) {
      this.running = true;
      this.renderer.setAnimationLoop(this._loop);   // WebXR-compatible loop (drives per-eye frames while presenting)
    }
  }

  close() {
    // The .promo class belongs to an OPEN viewer: drop it whichever way the close
    // arrived — ✕, Escape, or the browser leaving fullscreen. The preference
    // behind it survives, and open() reapplies it.
    this._applyPromo(false);
    if (this._escapeLayer) popEscapeLayer(this._escapeLayer);
    if (this.overlay.hidden) return;   // idempotent — ✕, Esc, and fullscreenchange can all call this
    this._camTween = null;             // drop any in-flight fullscreen-framer glide
    if (this._xrSession) {
      try { this._xrSession.end(); } catch { /* ignore */ }
      this._xrSession = null;
      // sessionend → _onXrEnd fires on a LATER tick, so restore the desktop camera
      // NOW: otherwise the _saveCamera() below persists the headset pose three left
      // in this.camera as the saved 3D view.
      this._restorePreVrCamera();
    }
    // Pause + mute across the teardown too (exit-fullscreen + the page reflow
    // stall the main thread the same way the open transition does).
    this._enterBusy();
    this._saveCamera();   // persist the final view (catches auto-rotate drift too)
    // Move focus out before hiding: a focused descendant under aria-hidden is an
    // a11y error ("Blocked aria-hidden … descendant retained focus").
    if (this.overlay.contains(document.activeElement)) document.activeElement.blur();
    this.overlay.hidden = true;
    this.overlay.setAttribute('aria-hidden', 'true');
    restoreTouchControls(this.touchControls, this._touchControlsHome);
    this._touchControlsHome = null;
    // Leave native fullscreen if we're still the fullscreen element (i.e. closed
    // via the ✕ rather than by the browser exiting fullscreen itself).
    if (document.fullscreenElement === this.overlay && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    window.removeEventListener('resize', this._onResize);
    this.running = false;
    if (this.renderer) this.renderer.setAnimationLoop(null);
    // Free everything from memory (the 4K model alone is ~95 MB / a lot of VRAM);
    // open() rebuilds from scratch. Done while paused (busy), so the disposal
    // stall can't jerk the audio.
    this._teardownGL();
    this._scheduleBusyExit();   // resume once the reflow settles (loop is stopped now)
    if (this.onHide) this.onHide();
  }

  // Dispose the per-open scene, model and post-pipeline, and reset state so the
  // next open() rebuilds them. The WebGLRenderer + its GL context are kept and
  // reused, so everything the open allocated is freed explicitly here: geometry,
  // materials and their textures, per-pass render targets, reflector/shadow-map
  // render targets, and instanced buffers. Shared resources (the _envMap and the
  // module-cached scene textures, tagged _shared) are left intact.
  //
  // Known residual: a THREE.Water reflection target (512² HalfFloat, IK+ scene
  // only) cannot be freed — Water owns the WebGLRenderTarget in a closure and
  // exposes no handle, and disposing its texture no-ops (render-target textures
  // skip deallocateTexture). It is one small buffer confined to that one scene.
  _teardownGL() {
    if (!this.renderer) return;
    // The screen mesh swaps its uv attribute between the stock (_origUV) and the
    // live-feed (_planarUV) buffers; geometry.dispose() only frees the attribute
    // present when it fires, so re-attach both (as uv + uv1) first — dispose then
    // frees both GPU buffers (keyed by attribute object, not by slot name).
    if (this._screenGeo && this._origUV && this._planarUV) {
      this._screenGeo.setAttribute('uv', this._origUV);
      this._screenGeo.setAttribute('uv1', this._planarUV);
    }
    if (this.scene) {
      this.scene.traverse((o) => this._disposeObject(o));
      // scene.environment is the shared _envMap (baked once) and scene.background
      // is a shared cached gradient — just detach, never dispose them here.
      this.scene.environment = null;
      this.scene.background = null;
    }
    // EffectComposer.dispose() frees only its two ping-pong targets — NOT the
    // passes it owns — so free each pass's render targets/materials first (bloom
    // mip-chain, SMAA targets + lookup textures, grade/output pass materials).
    if (this._composer) {
      if (Array.isArray(this._composer.passes)) {
        this._composer.passes.forEach((p) => { if (p && typeof p.dispose === 'function') p.dispose(); });
      }
      if (typeof this._composer.dispose === 'function') this._composer.dispose();
    }
    if (this.controls && typeof this.controls.dispose === 'function') this.controls.dispose();
    // Both screen materials + the live texture. The traverse above only disposes
    // whichever material is CURRENTLY on the screen mesh; the detached one would
    // otherwise leak its textures. EITHER can be the detached one: the scene is
    // opened both while the C64 runs (live feed shown, stock glass detached) AND
    // while powered off (stock glass shown, live feed detached — e.g. viewing the
    // model, then double-clicking to power on). So dispose both unconditionally.
    for (const mm of [this._liveMaterial, this._origMaterial, this._offMaterial]) {
      if (Array.isArray(mm)) mm.forEach((m) => this._disposeMaterial(m));
      else this._disposeMaterial(mm);
    }
    if (this._screenTex && typeof this._screenTex.dispose === 'function') this._screenTex.dispose();
    // Keep this.renderer + its canvas alive for the next open. Stop the loop and
    // release cached programs/render-lists that referenced the torn-down scene.
    this.renderer.setAnimationLoop(null);
    if (this.renderer.renderLists && typeof this.renderer.renderLists.dispose === 'function') this.renderer.renderLists.dispose();

    // Drop every per-open reference so the model's geometry/texture data can be GC'd.
    this.scene = this.camera = this.controls = null;
    this._composer = this._bloomPass = this._gradePass = null;
    this._model = this._sceneGroup = this._sceneAnimate = null;
    this._modelSphere = this._modelBox = null;
    this._offMaterial = null;
    this._screenTex = this._screenDataRef = this._screenMesh = this._screenGeo = null;
    this._liveMaterial = this._origMaterial = this._origUV = this._planarUV = null;
    this._screenLive = false;
    this._screenLight.active = false;
    this._screenLightSampleAt = -Infinity;
    this._keycap = null;
    this._leds = [];   // materials freed by the scene traverse above; re-wired on reopen
    this._rig = this._preVr = this._xrFill = null;   // VR-only refs; rebuilt on next entry
    this._xrPending = false;                          // clear any in-flight-request latch
    this._glReady = false; this._modelLoaded = false; this._loading = false;
  }

  isOpen() { return this.overlay && !this.overlay.hidden; }
}
