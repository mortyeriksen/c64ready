// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/main.js – Entry point: audio init, keyboard handling, RAF loop, video blit
// Wires up auto-ROM loading, D64 disk images, joystick emulation, and PRG injection.

import './tooltips.js';   // must own `title` before any module writes one
import { C64Machine } from './machine.js';
import { ROMLoader, pickViceRoms } from './roms.js';
import * as ControlPort from './control-port.js';
import { CANVAS_W, CANVAS_H, CYCLES_PER_FRAME, VIC_VARIANT, VIC_VARIANTS, PALETTE_NAMES, setVicPalette } from './vic2.js';
import { D64 }        from './d64.js';
import { DriveSounds } from './drive-sounds.js';
import { TapeSound } from './tape-sound.js';
import { SPEAKER_ON_SVG, SPEAKER_MUTE_SVG } from './pixel-speaker.js';
import { SCOPE_SVG } from './pixel-scope.js';
import './tape-scope.js';
import { shouldMuteOnAutoFreeze, needsForegroundAudioRestore } from './audio-lifecycle.js';
import { VERSION }     from './version.js';
// PauseDemo (pausedemo.js) + ModelViewer (retrovibes.js) are imported lazily on
// first need — both pull in three.js (~700 kB), kept out of the main bundle so it
// loads on demand. See _ensurePauseDemo / _ensureModelViewer below.
import { switchOn }   from './switches.js';
import { attachVibesButtonFx, createVibesZoom } from './vibes-btn-fx.js';
import { WebGLPresenter } from './webgl-presenter.js';
import sidWorkletUrl   from './sid-worklet.js?worker&url';
import { registerSW }  from 'virtual:pwa-register';
import {
  machine, loader, sidNode, running, _pristineBoot, _hasBeenReady,
  setMachine, setLoader, setSidNode, setRunning, setPristineBoot, setHasBeenReady,
} from './state.js';
import { registerAudioContext } from './debug.js';
import {
  initMedia, _onCRTLoaded, _onTapLoaded, _syncCartridgeControls, _syncDrive9TdeBtn, _applyDrive9Tde,
  _syncTapeButtons, _applyReu,
  _flashDrive9Led, drive9LedActive, updateMediaIndicators, downloadSnapshot,
  currentD64, currentD64Drive9, drive9Enabled, drive9TdeEnabled,
  _cachedCartData, _cachedTapData, _cachedTapName, _cachedTapProtected, _cacheTapeFromDeck,
  _cachedTapDeck, _restoreDeck,
} from './media.js';
import { initInput, updateJoyPorts, installNeosHook, _releaseAllLatched, softKeyboardInput } from './input.js';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';
import { createAvMarker, avMarkerEnabled } from './av-marker.js';
import { SoftKeyboardInsertState } from './input-key-ownership.js';
import { CAPTURE_PRESETS, DEFAULT_CAPTURE_PRESET, capturePreset, nextCapturePreset }
  from './recording-support.js';
import {
  initRecorder, recorderAudioClockActive, setRecorderAudioPaused,
} from './recorder.js';
import { splashIsOpen } from './splash.js';
import { initPanelOrder } from './panel-order.js';
// ── Elements (see dom.js for the full inventory) ─────────────────────────────
import {
  canvas, statusEl, powerBtn, resetBtn, pauseBtn, recordBtn, prgBtn, pasteBtn,
  saveStateBtn, crtBtn, d64Btn, d64NewBtn, tapBtn, tapNewBtn, kernalInput, basicInput,
  charInput, drive1541Input, romStatus, sidToggleBtn, vicToggleBtn, paletteToggleBtn,
  tapeListenBtn, tdeToggleBtn, fpsCounter, fpsDisplay, frametimeDisplay, frametimeWrap,
  heapDisplay, heapWrap, fullscreenBtn, fsCloseBtn, sizeBtn, crtEffectBtn, _logoText,
  driveSoundToggleBtn, sidEngineToggleBtn, wakeLockToggleBtn, muteToggleBtn, volumeSlider,
  volumeValue, attractToggleBtn, vibesModelBtn, recResToggleBtn, runBackgroundBtn, _romFnSpans, romClearBtn,
  mobileKbd, touchControls, autorunBtn, creditsModal, creditsBtn, creditsClose, creditsVer,
  tapeScopeBtn,
  creditsProse, vibesBtn, vibesFxBtn, vibesZoomModal, vibesZoomStage, vibesZoomClose,
  modelViewerCloseBtn, creditLink, creditPopup, settingsModal, settingsBtn, settingsClose,
  setupModal, externalBrowserModal,
} from './dom.js';


// Set native canvas resolution
canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

// ── Screen presenter ─────────────────────────────────────────────────────────
// WebGL by default ('webglPresenter' switch — force the legacy 2D path with
// ?WEBGL_PRESENTER=0 in the URL for an A/B). Decided before any getContext
// call because a canvas binds permanently to its first context type; when
// WebGL is unavailable, create() returns null WITHOUT binding the canvas, so
// the 2D fallback below still works. Only the framebuffer→canvas hop changes:
// same 384×272 backing store, CSS does all scaling, CRT presets are CSS.
const presenter = switchOn('webglPresenter')
  ? WebGLPresenter.create(canvas, CANVAS_W, CANVAS_H)
  : null;
const ctx = presenter ? null : canvas.getContext('2d');

function _isFacebookInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /\b(?:FBAN|FBAV|FBIOS|FB_IAB|FB4A|FBSS|FBCR|FBID|FBLC|FBDV)\b/i.test(ua);
}

function _sharedArrayBufferAvailable() {
  return typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated === true;
}

function _showExternalBrowserModalIfNeeded() {
  if (!externalBrowserModal) return;
  if (!_isFacebookInAppBrowser() || _sharedArrayBufferAvailable()) return;
  externalBrowserModal.hidden = false;
}
document.addEventListener('keydown', e => {
  if (!externalBrowserModal || externalBrowserModal.hidden) return;
  e.stopImmediatePropagation();
  e.preventDefault();
}, { capture: true });
_showExternalBrowserModalIfNeeded();

// Power-off attract mode: a looping Three.js vector demo overlaid on the black
// CRT area. Runs whenever the machine is powered off (attract mode ON); stopped
// on POWER ON and resumed on POWER OFF (see the power button handler).
// LAZILY loaded + built: pausedemo.js (three.js) is dynamically imported and the
// scene constructed only on first need (attract mode on + powered off). Attract
// off → three is never imported and no WebGL context is built; the static boot
// hint shows instead. Returns the singleton instance (async). See below.
let pauseDemo = null;
let _pauseDemoPromise = null;
async function _ensurePauseDemo() {
  if (pauseDemo) return pauseDemo;
  if (!_pauseDemoPromise) _pauseDemoPromise = (async () => {
    const { PauseDemo } = await import('./pausedemo.js');
    pauseDemo = new PauseDemo(document.querySelector('.crt-bezel'));
    // The demo measures itself: if this GPU can't hold a frame rate, it stops and
    // says so, and the powered-off screen goes back to the static banner.
    pauseDemo.onTooSlow = (medianMs) => {
      console.info(`PauseDemo: ~${medianMs}ms/frame — falling back to the boot banner.`);
      try { localStorage.setItem(ATTRACT_CAPABLE_KEY, `no:${VERSION}`); } catch { /* storage off */ }
      if (!running) _startBootHint();
    };
    if (typeof window !== 'undefined') window.pauseDemo = pauseDemo;
    return pauseDemo;
  })();
  return _pauseDemoPromise;
}
// Whether the attract-mode vector demo plays while the machine is powered off
// (Settings ▸ Display). Default ON. When off, the powered-off screen shows a
// static "PRESS POWER TO BOOT" hint instead of the animated demo.
let attractModeEnabled = (() => {
  try { const v = localStorage.getItem('c64emu.attractMode'); return v === null ? true : v === 'on'; }
  catch { return true; }
})();
// A looping vector demo is the kind of motion prefers-reduced-motion asks us not
// to play, so the static banner stands in — same as attract mode off.
const _reducedMotion = () =>
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// Machines whose GPU couldn't hold a frame rate get the banner too, remembered so
// the next visit doesn't make them sit through the demo again to find out. Stamped
// with the version: a new build re-tests, since a driver or a machine can change.
const ATTRACT_CAPABLE_KEY = 'c64emu.attractCapable';
const _attractCapable = () => {
  try { return localStorage.getItem(ATTRACT_CAPABLE_KEY) !== `no:${VERSION}`; }
  catch { return true; }
};

// The "PRESS ⏻ POWER TO BOOT" boot banner — shown while the machine is off and
// attract mode is disabled. Styled to match the attract demo's own banner (Giana
// font, a power symbol between the words, a Colodore light-blue halo under a
// white core) and gently pulsed by a lightweight 2D loop — so it feels like the
// animated demo's banner without loading any Three.js. Rendered on an offscreen
// 384×272 canvas (reused) so one path serves both presenters (the WebGL screen
// has no fillText — it shows this canvas through the frame texture).
let _bootHintRaf = null;
let _bootHintCanvas = null;

// Standard power symbol: a ring with a gap at the top + a vertical bar through it.
function _drawPowerIcon(g, cx, cy, r) {
  const gap = 0.45;
  g.lineWidth = r * 0.26;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(cx, cy, r, -Math.PI / 2 + gap, -Math.PI / 2 - gap + 2 * Math.PI);
  g.stroke();
  g.beginPath();
  g.moveTo(cx, cy - r * 1.05);
  g.lineTo(cx, cy + r * 0.02);
  g.stroke();
}

// Without the three mandatory ROMs there is nothing to power on, so the banner
// asks for what's missing instead. Read live — ROMs arrive at any time. Before the
// loader exists (the first powered-off render runs first) "ready" is the right
// guess: nearly every visit has its ROMs, and guessing the other way flashes a
// Setup banner at all of them. _runAutoLoad re-renders once it knows.
const _romsReady = () => !loader || !!loader.allLoaded;

function _drawBootHint(alpha = 1) {
  if (!_bootHintCanvas) _bootHintCanvas = document.createElement('canvas');
  const off = _bootHintCanvas;
  if (off.width !== canvas.width || off.height !== canvas.height) { off.width = canvas.width; off.height = canvas.height; }
  const g = off.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, off.width, off.height);
  g.globalAlpha = alpha;

  // The boot banner puts the power symbol between its two words; the Setup one is
  // a plain line of text — no symbol on the machine means "set me up".
  const setup = !_romsReady();
  const pre = setup ? 'PRESS TO START SETUP' : 'PRESS';
  const post = setup ? '' : 'POWER TO BOOT';
  const fontAt = (n) => `${n}px 'Giana', 'Share Tech Mono', 'Courier New', monospace`;
  const GAP_PRE = 0.55, GAP_POST = 0.32, ICON = 0.92;   // relative to font size
  let fs = Math.round(off.height / 10);
  const layout = (n) => {
    g.font = fontAt(n);
    const preW = g.measureText(pre).width;
    if (setup) return { preW, postW: 0, iconD: 0, total: preW };
    const postW = g.measureText(post).width, iconD = n * ICON;
    return { preW, postW, iconD, total: preW + n * GAP_PRE + iconD + n * GAP_POST + postW };
  };
  let m = layout(fs);
  while (fs > 6 && m.total > off.width * 0.56) { fs--; m = layout(fs); }

  const cy = off.height / 2, x0 = (off.width - m.total) / 2;
  const iconCx = x0 + m.preW + fs * GAP_PRE + m.iconD / 2;
  const postX = x0 + m.preW + fs * GAP_PRE + m.iconD + fs * GAP_POST;
  const iconR = m.iconD * 0.46;

  g.font = fontAt(fs);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const pass = (color, blur) => {
    g.shadowColor = 'rgba(112,109,235,0.6)';   // Colodore light-blue glow
    g.shadowBlur = blur;
    g.fillStyle = color; g.strokeStyle = color;
    g.fillText(pre, x0, cy);
    if (setup) return;
    g.fillText(post, postX, cy);
    _drawPowerIcon(g, iconCx, cy, iconR);
  };
  pass('#706deb', fs * 0.16);   // blue halo
  pass('#ffffff', 0);           // white core
  g.shadowBlur = 0; g.globalAlpha = 1;

  if (presenter) presenter.presentCanvas(off);
  else ctx.drawImage(off, 0, 0);
}

// Gentle pulse loop for the boot banner (~25 fps; only runs while it's shown).
function _startBootHint() {
  if (_bootHintRaf !== null) return;
  const t0 = performance.now();
  let last = 0;
  const tick = (now) => {
    _bootHintRaf = requestAnimationFrame(tick);
    if (now - last < 40) return;
    last = now;
    _drawBootHint(0.72 + 0.28 * Math.sin(((now - t0) / 1000) * 2.0));
  };
  _bootHintRaf = requestAnimationFrame(tick);
}
function _stopBootHint() {
  if (_bootHintRaf !== null) { cancelAnimationFrame(_bootHintRaf); _bootHintRaf = null; }
}
function _blankScreen() {
  if (presenter) { presenter.clearBlack(); return; }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Render the powered-off screen. Attract mode ON → build (if needed) + run the
// full animated demo. OFF → never load the demo; show the static "PRESS POWER
// TO BOOT" banner (also the fallback when WebGL is unavailable). Called live on
// the attract-mode toggle, so switching while powered off swaps immediately.
function _showPoweredOffScreen() {
  canvas.style.cursor = 'pointer';
  // No ROMs, no machine: show the Setup banner, not the attract demo — it would
  // hide the one thing to do and promise a boot that can't happen.
  if (!_romsReady()) {
    pauseDemo?.stop();
    _startBootHint();
    return;
  }
  if (!attractModeEnabled || _reducedMotion() || !_attractCapable()) {
    pauseDemo?.stop();   // halt a running demo (e.g. attract toggled off live)
    _startBootHint();    // pulsing "PRESS ⏻ POWER TO BOOT" banner
    return;
  }
  // Attract on: show the boot-hint banner right away, then upgrade to the 3D
  // demo once pausedemo.js (three.js) has lazily loaded — effectively instant on
  // cached visits (the banner's first rAF is cancelled before it paints), a brief
  // banner on the first uncached load. Re-check state when the import resolves:
  // only start if we're still powered-off + attract (the user may have powered on
  // or toggled attract off mid-load), and keep the banner if WebGL is absent.
  // _romsReady is re-checked for a reason: it answers TRUE before the loader
  // exists, so a first paint gets this far, and the autoload that later finds no
  // ROMs calls back in while pauseDemo is still null — its stop() hits nothing.
  // Without this the demo starts anyway and buries the Setup banner.
  _startBootHint();
  _ensurePauseDemo().then(pd => {
    if (pd && pd.supported && !running && attractModeEnabled && _romsReady()) {
      _stopBootHint();
      pd.start();
    }
  }).catch(() => {});
}
window.matchMedia?.('(prefers-reduced-motion: reduce)')
  ?.addEventListener?.('change', () => { if (!running) _showPoweredOffScreen(); });

// First visit, splash overlay up: it covers the screen, so skip the powered-
// off render (and the attract demo's lazy three.js fetch) until it's
// dismissed. "Explore" lands here still powered off; POWER ON boots before
// the event fires, and the !running guard skips the stale render.
if (splashIsOpen()) {
  window.addEventListener('c64-splash-dismissed', () => { if (!running) _showPoweredOffScreen(); }, { once: true });
} else {
  _showPoweredOffScreen();
}
// The screen starts powered off, so hint that clicking it boots (see the
// canvas click handler near the POWER button).
canvas.style.cursor = 'pointer';

// ── Machine & ROM loader ─────────────────────────────────────────────────────
try {
  setMachine(new C64Machine());
  setLoader(new ROMLoader());
  // Expose to DevTools console for ad-hoc debugging (sidTraceStart, etc.).
  if (typeof window !== 'undefined') window.machine = machine;
} catch (err) {
  console.error("Critical Init Error:", err);
  const status = document.getElementById('status');
  if (status) {
    status.textContent = "Initialization Failed: " + err.message;
    status.className = "status status-error";
  }
}

let audioCtx  = null;
// Status card content to restore when an auto-freeze thaws (see _autoFreeze /
// _autoThaw). Declared with the early state: setStatus() touches it and can
// run from ROM-autoload microtasks before the freeze/thaw block is evaluated.
let _preFreezeStatus = null;
// Master output gain — everything (SID worklet + drive sounds) routes through
// this node so a single control silences the lot. Created in initAudio();
// null until then. MUTE toggles its gain 0 ↔ 1. See btn-mute-toggle.
let masterGain = null;
// Global MUTE (Settings ▸ Sound). Persisted; default OFF (audible). When ON,
// masterGain is pinned to 0; toggling OFF restores it to the masterVolume level.
let audioMuted = (() => {
  try { return localStorage.getItem('c64emu.mute') === 'on'; } catch { return false; }
})();
// Master output VOLUME = the slider POSITION 0..1 (Settings ▸ Sound). Persisted
// (c64emu.volume); default 0.7. This is NOT the raw gain — a perceptual taper
// (volumeToGain) maps position → gain. Effective master gain = audioMuted ? 0 :
// volumeToGain(masterVolume), so MUTE and the slider compose on the one
// masterGain node (see setMasterMuted).
let masterVolume = (() => {
  try {
    const v = parseFloat(localStorage.getItem('c64emu.volume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
  } catch { return 0.7; }
})();
// Perceptual (audio-taper) volume → gain curve. Square law: loudness perception
// is ~logarithmic, so a linear slider spends most of its travel sounding "loud"
// (50% = only -6 dB). Squaring pushes the useful range up: position 0.5 → 0.25
// (-12 dB), 0.7 → 0.49 (-6 dB, the default), 1 → 1 (0 dB). Endpoints stay exact
// (0→silence, 1→unity). Applied wherever masterGain.gain is set.
const volumeToGain = (v) => v * v;
// Pending unmute after a RESET (see _hardReset) — cleared if another reset lands
// inside the settle window so a stale timer can't unmute mid-reset.
let _resetUnmuteTimer = null;
// Synthesized 1541 mechanical drive sounds (motor hum + stepper clicks +
// trap-mode fake-load bursts). User-toggleable in Settings → Sound; persisted
// in localStorage. Default OFF. Every use site is guarded on `driveSounds`
// being non-null, so a null instance silences the lot.
// SID engine (Options ▸ Sound): 'wasm' = the reSID-ported transistor-level
// model compiled from Rust (default — bit-identical to the JS engine, ~6×
// less CPU; the worklet renders the JS engine while the module instantiates
// and falls back to it for the session if WebAssembly fails, so the default
// never loses audio), 'resid' = the same model in JS. Persisted; applied at
// worklet init and switchable live via the 'engine' message. Any other
// stored value (older builds had a third engine) falls back to the default.
let sidEngine = (() => {
  try {
    return localStorage.getItem('c64emu.sidEngine') === 'resid' ? 'resid' : 'wasm';
  } catch { return 'wasm'; }
})();

let driveSoundsEnabled = (() => {
  try { return localStorage.getItem('c64emu.driveSound') === 'on'; } catch { return false; }
})();
let driveSounds = null;
// Screen wake-lock state (Settings ▸ STAY AWAKE, persisted, default ON): hold a
// screen wake lock while a demo is actively running so the device doesn't dim or
// lock and trip the auto-freeze mid-demo.
let wakeLockEnabled = (() => {
  try { return localStorage.getItem('c64emu.wakeLock') !== 'off'; } catch { return true; }
})();
let _wakeLock = null;
let paused    = false;   // PAUSE button: freezes the emulation loop (running stays true)
// Mirror `running` into a body class so CSS can style power-dependent UI
// (e.g. disable Key Map taps when the machine is off). Call this after any
// assignment to `running`.
function _syncPowerStateClass() {
  document.body.classList.toggle('powered-on', running);
}

// Reflect the PAUSE state on <body> so paused-only CSS can key off it — e.g.
// freezing the CRT HUM roll (a continuous full-screen compositor animation) to
// save battery while the machine is paused. Call after any assignment to `paused`.
function _syncPausedClass() {
  document.body.classList.toggle('paused', paused);
}

// Replay the logo's boot shake-zoom (CSS .logo-text.logo-punch). A CSS
// animation only restarts when the class is newly applied, so removing it +
// forcing a reflow before re-adding lets it fire again on RESET / state load,
// not just on the off->on power transition.
function _punchLogo() {
  if (!_logoText) return;
  _logoText.classList.remove('logo-punch');
  void _logoText.offsetWidth;   // force reflow so the re-add restarts the animation
  _logoText.classList.add('logo-punch');
}
// Drop the class once the shake-zoom finishes, so it doesn't linger on the
// element — otherwise re-showing the header (e.g. exiting fullscreen, which
// toggles the logo's display) would restart the CSS animation. It still fires
// on power/reset/load because _punchLogo re-adds it each time.
if (_logoText) {
  _logoText.addEventListener('animationend', (e) => {
    if (e.animationName === 'logo-shake-zoom') _logoText.classList.remove('logo-punch');
  });
}
let rafId     = null;
let lastTime  = 0;
// SID variant preference. Persisted in localStorage. Default = 8580
// (the HMOS SID in the later C64C). Internally we still keep an is8580 boolean
// because the audio worklet protocol uses it. A persisted choice still wins.
let sidVariantPref = (() => {
  try {
    const v = localStorage.getItem('c64emu.sidVariant');
    return (v === '8580' || v === '6581') ? v : '8580';
  } catch { return '8580'; }
})();
let is8580 = sidVariantPref === '8580';

// VIC variant preference (6569 NMOS → 8565 HMOS). Persisted likewise.
// The variant list/strings come from vic2.js (single source of truth).
let vicVariantPref = (() => {
  try {
    const v = localStorage.getItem('c64emu.vicVariant');
    return VIC_VARIANTS.includes(v) ? v : VIC_VARIANT.V6569;
  } catch { return VIC_VARIANT.V6569; }
})();

// Color palette preference (Colodore ↔ Pepto). The active palette is module-
// level state inside vic2.js, so it survives RESET / POWER cycling — we apply
// the persisted choice once here at startup, then again on each toggle. Names
// come from vic2.js (single source of truth).
let palettePref = (() => {
  try {
    const v = localStorage.getItem('c64emu.palette');
    return PALETTE_NAMES.includes(v) ? v : 'colodore';
  } catch { return 'colodore'; }
})();
setVicPalette(palettePref);

// Drive state polled each frame to trigger mechanical sounds.
let prevMotorOn    = false;
let prevHalfTrack  = 0;

// FPS tracking & timing
let frameCount = 0;
let lastFpsTime = performance.now();
let timeAccumulator = 0;
let _avMarker = null;                  // A/V sync clapper, see src/av-marker.js
const PAL_CPU_HZ = 985248;
const IDEAL_DELTA = (CYCLES_PER_FRAME / PAL_CPU_HZ) * 1000;
// Warp the emulation during the silent cold-boot RAM test so the ~2 s wait to
// the BASIC READY prompt finishes faster. Only active while still booting
// (_pristineBoot && !_hasBeenReady); no audio plays during boot, so there's no
// pitch/sync side-effect. Bump higher for an even snappier boot.
const BOOT_WARP = 4;
let pendingPasteText = '';

// Per-frame compute timer. Code-level switch (not a UI control): when true,
// the average wall-clock time spent in machine.runFrame() — the emulation
// work our perf optimizations target — is measured and shown next to the FPS
// number, refreshed on the same 1-second cadence as FPS. Flip to false to
// hide it (zero measurement overhead when off). Default on.
const SHOW_FRAME_TIME = true;
let frameComputeAccum = 0;  // summed runFrame() ms over the current FPS window
let frameComputeCount = 0;  // runFrame() calls over the current FPS window
if (frametimeWrap) frametimeWrap.style.display = SHOW_FRAME_TIME ? '' : 'none';

// JS-heap readout beside the frame time, refreshed on the same 1 s cadence.
// Diagnoses GC pressure on-device (the Android 20→35 ms report): a climbing
// sawtooth FLOOR = old-space growth / allocation pressure worth chasing; a
// flat sawtooth while ms rises = thermal throttling, not GC. Chrome-only
// (performance.memory; Android Chrome has it) — hidden where unavailable.
// This page is cross-origin isolated (COOP/COEP for the SAB), so Chrome
// reports precise values rather than the quantized fallback.
const HEAP_MEM = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
if (heapWrap) heapWrap.style.display = (SHOW_FRAME_TIME && HEAP_MEM) ? '' : 'none';

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function normalizeClipboardText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/[a-z]/g, ch => ch.toUpperCase())
    .replace(/\n/g, '\r');
}

function queueClipboardText(text) {
  const normalized = normalizeClipboardText(text);
  if (!normalized) return 0;
  pendingPasteText += normalized;
  return normalized.length;
}

function queuePastedTextAndReport(text) {
  const queued = queueClipboardText(text);
  if (queued > 0) {
    flushKeyboardPasteQueue();
    setStatus(`Pasted ${queued} character${queued === 1 ? '' : 's'} to keyboard buffer`, 'running');
  }
  return queued;
}

function flushKeyboardPasteQueue() {
  if (!running || !pendingPasteText) return;
  const accepted = machine.bufferKeyboardText(pendingPasteText);
  if (accepted > 0) {
    pendingPasteText = pendingPasteText.slice(accepted);
  }
}

if (sidToggleBtn) {
  // Sync the button label with the persisted preference at startup.
  sidToggleBtn.textContent = `SID: ${sidVariantPref}`;
  sidToggleBtn.addEventListener('click', () => {
    is8580 = !is8580;
    sidVariantPref = is8580 ? '8580' : '6581';
    sidToggleBtn.textContent = `SID: ${sidVariantPref}`;
    // Worklet handles audio output; shadow voices handle $D41B/$D41C reads.
    // Both must learn the new model or model-detection routines diverge.
    if (sidNode) {
      sidNode.port.postMessage({ type: 'model', is8580 });
    }
    machine?.setSidModel?.(is8580);
    try { localStorage.setItem('c64emu.sidVariant', sidVariantPref); } catch {}
  });
}

// VIC-II variant toggle, cycling 6569 → 8565. 8565 adds a 1-cycle pixel
// pipeline delay used by some demos that detect via sprite collisions.
if (vicToggleBtn) {
  // Initial label uses the persisted preference; the actual machine.vic2
  // value is set when the machine is created (see _applyVicVariantPref).
  vicToggleBtn.textContent = `VIC: ${vicVariantPref}`;
  vicToggleBtn.addEventListener('click', () => {
    // Advance the persisted preference regardless of whether the machine is
    // running, so the user can pick a variant BEFORE POWER ON. If there
    // is a running machine, apply the change live too.
    const idx = VIC_VARIANTS.indexOf(vicVariantPref);
    const next = VIC_VARIANTS[(idx + 1) % VIC_VARIANTS.length];
    vicVariantPref = next;
    if (machine?.vic2) machine.vic2.vicVariant = next;
    vicToggleBtn.textContent = `VIC: ${next}`;
    try { localStorage.setItem('c64emu.vicVariant', next); } catch {}
  });
}

// Color-palette toggle, cycling Colodore → Pepto. setVicPalette() rewrites the
// renderer's RGBA table in place, so the swap is visible on the next frame
// (no machine re-creation needed). Persisted across sessions.
const _paletteLabel = (name) => `PAL: ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
if (paletteToggleBtn) {
  paletteToggleBtn.textContent = _paletteLabel(palettePref);
  paletteToggleBtn.addEventListener('click', () => {
    const idx = PALETTE_NAMES.indexOf(palettePref);
    const next = PALETTE_NAMES[(idx + 1) % PALETTE_NAMES.length];
    palettePref = next;
    setVicPalette(next);
    paletteToggleBtn.textContent = _paletteLabel(next);
    try { localStorage.setItem('c64emu.palette', next); } catch {}
  });
}

// SID engine toggle (Options ▸ Sound), reSID WASM ↔ reSID JS. Persisted;
// applies live — the worklet swaps the engine under the running voices (the
// full $D400-$D418 register file replays from the processor's shadow; filter
// integrators and the resampler restart). If the WASM module fails to
// instantiate the worklet silently renders with reSID JS.
if (sidEngineToggleBtn) {
  const CYCLE = { resid: 'wasm', wasm: 'resid' };
  const LABEL = { resid: 'reSID JS', wasm: 'reSID WASM' };
  const _syncSidEngineLabel = () => {
    sidEngineToggleBtn.textContent = `ENGINE: ${LABEL[sidEngine] || 'reSID WASM'}`;
  };
  _syncSidEngineLabel();
  sidEngineToggleBtn.addEventListener('click', () => {
    sidEngine = CYCLE[sidEngine] || 'resid';
    try { localStorage.setItem('c64emu.sidEngine', sidEngine); } catch {}
    _syncSidEngineLabel();
    if (sidNode) sidNode.port.postMessage({ type: 'engine', engine: sidEngine });
  });
}

// Disk-drive sound toggle (Settings → Sound). Persisted; applies live — turning
// it on lazily builds the DriveSounds graph once audio exists; turning it off
// silences and drops it (updateDriveSounds + onLoadTrap then no-op on null).
if (driveSoundToggleBtn) {
  const _syncDriveSoundLabel = () => {
    driveSoundToggleBtn.textContent = `DRIVE SOUND: ${driveSoundsEnabled ? 'ON' : 'OFF'}`;
  };
  _syncDriveSoundLabel();
  driveSoundToggleBtn.addEventListener('click', () => {
    driveSoundsEnabled = !driveSoundsEnabled;
    try { localStorage.setItem('c64emu.driveSound', driveSoundsEnabled ? 'on' : 'off'); } catch {}
    if (driveSoundsEnabled) {
      if (audioCtx && !driveSounds) driveSounds = new DriveSounds(audioCtx, masterGain);
    } else if (driveSounds) {
      driveSounds.motorOff();
      driveSounds = null;
      prevMotorOn = false;
    }
    _syncDriveSoundLabel();
  });
}

// Tape audio (the speaker button on the Datasette card). A C64 tape's data IS
// audio, so this plays the signal the head is reading rather than an effect.
// Persisted; off by default, and built lazily the first time it is switched on.
let tapeListenEnabled = (() => {
  try { return localStorage.getItem('c64emu.tapeSound') === 'on'; } catch { return false; }
})();
let tapeSound = null;

function _syncTapeListenBtn() {
  if (!tapeListenBtn) return;
  tapeListenBtn.innerHTML = SPEAKER_ON_SVG + SPEAKER_MUTE_SVG;
  tapeListenBtn.classList.toggle('is-silent', !tapeListenEnabled);
  tapeListenBtn.setAttribute('aria-pressed', String(tapeListenEnabled));
}

if (tapeScopeBtn) tapeScopeBtn.innerHTML = SCOPE_SVG;

if (tapeListenBtn) {
  _syncTapeListenBtn();
  tapeListenBtn.addEventListener('click', (e) => {
    e.stopPropagation();          // the card header toggles expand/collapse
    tapeListenEnabled = !tapeListenEnabled;
    try { localStorage.setItem('c64emu.tapeSound', tapeListenEnabled ? 'on' : 'off'); } catch {}
    if (tapeListenEnabled) {
      if (audioCtx && !tapeSound) tapeSound = new TapeSound(audioCtx, masterGain);
    } else if (tapeSound) {
      tapeSound.dispose();
      tapeSound = null;
    }
    _syncTapeListenBtn();
  });
}

// ── Screen Wake Lock ─────────────────────────────────────────────────────────
// Keep the display awake while a demo is actually running, so the OS doesn't dim
// or lock the screen (which fires the auto-freeze and pauses the machine
// mid-demo). Held iff wakeLockEnabled && running && !paused && foreground;
// released on pause / background / power-off and re-acquired on return (the lock
// also auto-releases when the tab hides, so _autoThaw re-requests it). No-op
// where the API is absent (older Safari / Firefox).
async function _acquireWakeLock() {
  if (_wakeLock || !('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch { _wakeLock = null; }   // rejects if not visible — _syncWakeLock retries
}
function _releaseWakeLock() {
  const wl = _wakeLock;
  _wakeLock = null;
  if (wl) wl.release().catch(() => {});
}
function _syncWakeLock() {
  if (wakeLockEnabled && running && !paused && !document.hidden) _acquireWakeLock();
  else _releaseWakeLock();
}

if (wakeLockToggleBtn) {
  const _syncWakeLockLabel = () => {
    wakeLockToggleBtn.textContent = `STAY AWAKE: ${wakeLockEnabled ? 'ON' : 'OFF'}`;
  };
  _syncWakeLockLabel();
  wakeLockToggleBtn.addEventListener('click', () => {
    wakeLockEnabled = !wakeLockEnabled;
    try { localStorage.setItem('c64emu.wakeLock', wakeLockEnabled ? 'on' : 'off'); } catch {}
    _syncWakeLockLabel();
    _syncWakeLock();
  });
}

// Sound ▸ master volume + MUTE (Settings). One full-width control: an icon
// toggle (mute) and a draggable level slider, plus a live % readout. Both
// compose on the single masterGain node via setMasterMuted() (effective gain =
// audioMuted ? 0 : masterVolume), so the tab-hidden auto-mute and post-reset
// re-assertions honor the slider level too. Persisted: c64emu.mute (on/off)
// and c64emu.volume (0..1).
if (muteToggleBtn || volumeSlider) {
  // PETSCII-style pixel speaker: inject both glyphs once; CSS shows the ON or
  // MUTE one via the .is-silent class toggled below (no per-input DOM churn).
  if (muteToggleBtn) muteToggleBtn.innerHTML = SPEAKER_ON_SVG + SPEAKER_MUTE_SVG;
  const _syncSoundUI = () => {
    const pct = Math.round(masterVolume * 100);
    const silent = audioMuted || masterVolume === 0;
    if (muteToggleBtn) {
      muteToggleBtn.classList.toggle('is-silent', silent);
      muteToggleBtn.classList.toggle('is-muted', audioMuted);
      muteToggleBtn.setAttribute('aria-pressed', audioMuted ? 'true' : 'false');
      muteToggleBtn.setAttribute('aria-label', audioMuted ? 'Unmute' : 'Mute');
    }
    if (volumeSlider) {
      volumeSlider.value = String(pct);
      // Filled portion left of the thumb. WebKit/Safari paints the element's
      // background; Firefox uses ::-moz-range-progress from CSS instead.
      const fill = audioMuted ? 'var(--dim)' : 'var(--accent)';
      volumeSlider.style.background =
        `linear-gradient(to right, ${fill} ${pct}%, var(--border) ${pct}%)`;
      volumeSlider.classList.toggle('is-muted', audioMuted);
    }
    if (volumeValue) volumeValue.textContent = audioMuted ? 'MUTED' : `${pct}%`;
  };
  _syncSoundUI();

  if (muteToggleBtn) {
    muteToggleBtn.addEventListener('click', () => {
      audioMuted = !audioMuted;
      try { localStorage.setItem('c64emu.mute', audioMuted ? 'on' : 'off'); } catch {}
      setMasterMuted(audioMuted);
      _syncSoundUI();
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      masterVolume = Math.min(1, Math.max(0, (parseFloat(volumeSlider.value) || 0) / 100));
      try { localStorage.setItem('c64emu.volume', String(masterVolume)); } catch {}
      // Raising the level always makes sound: clear MUTE so a muted drag isn't a
      // dead interaction. Dragging to 0 just leaves the output silent.
      if (masterVolume > 0 && audioMuted) {
        audioMuted = false;
        try { localStorage.setItem('c64emu.mute', 'off'); } catch {}
      }
      setMasterMuted(audioMuted);  // recomputes gain from masterVolume
      _syncSoundUI();
    });
  }
}

// Attract-mode toggle (Settings ▸ Display). Persisted; applies live — when
// toggled while powered off it swaps between the animated demo and the static
// boot hint immediately.
if (attractToggleBtn) {
  const _syncAttractLabel = () => {
    attractToggleBtn.textContent = `ATTRACT MODE: ${attractModeEnabled ? 'ON' : 'OFF'}`;
  };
  _syncAttractLabel();
  attractToggleBtn.addEventListener('click', () => {
    attractModeEnabled = !attractModeEnabled;
    try { localStorage.setItem('c64emu.attractMode', attractModeEnabled ? 'on' : 'off'); } catch {}
    _syncAttractLabel();
    // Attract / boot-hint only show while powered off — apply the change live.
    if (!running) _showPoweredOffScreen();
  });
}

// VIBES 3D-model override (Options ▸ Display): cycle SMALL → AUTO → LARGE. SMALL
// (default) is the light 18 MB model, safe everywhere; AUTO lets retrovibes.js
// pick by device (4K on desktop); LARGE forces the 4K model. Read fresh by
// retrovibes.js each time the viewer opens (key 'c64emu.vibesModel').
if (vibesModelBtn) {
  const MODELS = ['small', 'auto', 'large'];
  const LABELS = { auto: 'AUTO', small: 'SMALL', large: 'LARGE' };
  let modelPref = (() => {
    try { const v = localStorage.getItem('c64emu.vibesModel'); return MODELS.includes(v) ? v : 'small'; }
    catch { return 'small'; }
  })();
  const _syncModelLabel = () => { vibesModelBtn.textContent = `3D MODEL SIZE: ${LABELS[modelPref]}`; };
  _syncModelLabel();
  vibesModelBtn.addEventListener('click', () => {
    modelPref = MODELS[(MODELS.indexOf(modelPref) + 1) % MODELS.length];
    try { localStorage.setItem('c64emu.vibesModel', modelPref); } catch {}
    _syncModelLabel();
  });
}

// RECORD capture ceiling (Options ▸ Other ▸ RECORDER). 1080p is the default and what the
// recorder shipped with. Read at the start of each take, so a change applies to
// the next recording rather than the one in progress.
let recPreset = (() => {
  try {
    const v = localStorage.getItem('c64emu.recResolution');
    return CAPTURE_PRESETS.some(p => p.id === v) ? v : DEFAULT_CAPTURE_PRESET;
  } catch { return DEFAULT_CAPTURE_PRESET; }
})();
if (recResToggleBtn) {
  const _syncRecResLabel = () => {
    const suffix = recPreset === DEFAULT_CAPTURE_PRESET ? ' (default)' : '';
    recResToggleBtn.textContent = `RECORDER: ${capturePreset(recPreset).label}${suffix}`;
  };
  _syncRecResLabel();
  recResToggleBtn.addEventListener('click', () => {
    recPreset = nextCapturePreset(recPreset);
    try { localStorage.setItem('c64emu.recResolution', recPreset); } catch {}
    _syncRecResLabel();
  });
}

// Options ▸ Other ▸ RUN IN BACKGROUND. Off, the machine pauses the moment the
// app leaves the foreground (see _autoFreeze) — what a phone in a pocket needs.
// On, a blur or a hidden tab leaves it running. A hidden tab gets no animation
// frames, so the loop is driven by a timer there instead, which browsers let
// run at full rate only while the tab is audible.
let runInBackground = (() => {
  try { return localStorage.getItem('c64emu.runInBackground') === 'on'; } catch { return false; }
})();
if (runBackgroundBtn) {
  const _syncRunBackgroundLabel = () => {
    runBackgroundBtn.textContent = `RUN IN BACKGROUND: ${runInBackground ? 'ON' : 'OFF'}`;
  };
  _syncRunBackgroundLabel();
  runBackgroundBtn.addEventListener('click', () => {
    runInBackground = !runInBackground;
    try { localStorage.setItem('c64emu.runInBackground', runInBackground ? 'on' : 'off'); } catch {}
    _syncRunBackgroundLabel();
  });
}

// Apply the persisted VIC variant to a freshly-created C64Machine. Called
// after `new C64Machine()` on both initial boot and every POWER ON.
function _applyVicVariantPref() {
  if (machine?.vic2) machine.vic2.vicVariant = vicVariantPref;
}
_applyVicVariantPref();

// Apply the persisted SID model to a freshly-created C64Machine. The shadow
// voices that serve $D41B/$D41C reads need to know the model, or OSC3-based
// model detection (e.g. lft's "Lunatico") always reads 6581 values and
// rejects the machine even when the user selected 8580. Called after every
// `new C64Machine()` and on toggle, mirroring the worklet's `model` message.
function _applySidVariantPref() {
  machine?.setSidModel?.(is8580);
}
_applySidVariantPref();

// Resync the SID / VIC toggle button labels with the persisted preference.
// Called after POWER ON so the UI never drifts away from the effective
// machine state.
function _syncToggleLabels() {
  if (sidToggleBtn) sidToggleBtn.textContent = `SID: ${sidVariantPref}`;
  if (vicToggleBtn) vicToggleBtn.textContent = `VIC: ${vicVariantPref}`;
  if (paletteToggleBtn) paletteToggleBtn.textContent = _paletteLabel(palettePref);
}

// True Drive Emulation preference — persisted like every other toggle, default
// ON. It has to be a stored intent rather than read back off the machine: the
// machine is rebuilt on every power cycle and reset, and each rebuild would
// otherwise resurrect the default.
let tdeEnabled = (() => {
  try { return localStorage.getItem('c64emu.tde') !== 'off'; }
  catch { return true; }
})();

function _syncTdeBtn() {
  if (!tdeToggleBtn) return;
  tdeToggleBtn.textContent = tdeEnabled ? 'TDE: ON' : 'TDE: OFF';
  tdeToggleBtn.classList.toggle('tde-on', tdeEnabled);
}

// Only enabled after 1541.bin loads.
if (tdeToggleBtn) {
  tdeToggleBtn.addEventListener('click', () => {
    if (!machine.drive1541) return;
    tdeEnabled = !tdeEnabled;
    try { localStorage.setItem('c64emu.tde', tdeEnabled ? 'on' : 'off'); } catch {}
    machine.setTrueDrive(tdeEnabled);
    _syncTdeBtn();
  });
}

// ── ROM status display ───────────────────────────────────────────────────────
// The ROM file selectors now live in the Settings dialog (always expanded),
// so there's no longer a collapsible panel to wire up here.
function updateRomStatus() {
  const k = loader.kernal    ? '✅' : '⬜';
  const b = loader.basic     ? '✅' : '⬜';
  const c = loader.charRom   ? '✅' : '⬜';
  const d = loader.drive1541 ? '✅' : '⬜';
  romStatus.textContent = `KERNAL ${k}  BASIC ${b}  CHAR ${c}  1541 ${d}`;
}

// Show the filename of each loaded ROM under its row (e.g. "kernal.bin",
// or whatever the user uploaded). Empty rows display nothing.
const _setupFnSpans = {
  kernal:    document.getElementById('setup-fn-kernal'),
  basic:     document.getElementById('setup-fn-basic'),
  charRom:   document.getElementById('setup-fn-charRom'),
  drive1541: document.getElementById('setup-fn-drive1541'),
};
function updateRomFilenames(names) {
  const src = names || loader.romNames;
  for (const key of Object.keys(_romFnSpans)) {
    const val = src[key] || '';
    if (_romFnSpans[key]) _romFnSpans[key].textContent = val;
    if (_setupFnSpans[key]) _setupFnSpans[key].textContent = val;
  }
}
loader.onNamesChanged = updateRomFilenames;
// Initial paint covers the case where autoLoad has not yet fired.
updateRomFilenames();

// Generic expand chevron — clicking anywhere on a collapsible panel's header
// (not just the small ▼ chevron) toggles its .panel-card. Panels with a
// data-persist-expanded="<key>" attribute have their open/closed state mirrored
// to localStorage (c64emu.expanded.<key>) so the choice survives reloads.
for (const btn of document.querySelectorAll('.expand-btn')) {
  const panel = btn.closest('.panel-card');
  if (!panel) continue;
  // Disk drive 9 and the RAM Expansion have headers that are power affordances,
  // not expanders (media.js wires them to their power switches); their expand
  // state follows power, so skip them here.
  if (panel.id === 'diskdrive9-card' || panel.id === 'reu-card') continue;
  // Toggle target is the whole header; the chevron is a button inside it, so a
  // click (mouse or keyboard) on the chevron bubbles here too — one handler
  // covers both, and no double-toggle.
  const header = btn.closest('.panel-card-header') || panel;
  const persistKey = panel.getAttribute('data-persist-expanded');
  const storageKey = persistKey ? `c64emu.expanded.${persistKey}` : null;

  // Restore persisted state before we hook the click handler so the
  // initial sync() reflects the saved value. An absent localStorage
  // entry leaves the HTML default in place (some panels ship expanded).
  if (storageKey) {
    try {
      const v = localStorage.getItem(storageKey);
      if      (v === 'on')  panel.classList.add('expanded');
      else if (v === 'off') panel.classList.remove('expanded');
    } catch {}
  }

  const sync = () => {
    const expanded = panel.classList.contains('expanded');
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.title = expanded ? 'Collapse' : 'Expand';
  };
  header.classList.add('header-clickable');
  header.addEventListener('click', () => {
    const expanded = panel.classList.toggle('expanded');
    sync();
    if (storageKey) {
      try { localStorage.setItem(storageKey, expanded ? 'on' : 'off'); } catch {}
    }
  });
  sync();
}

// Drag handles on the side-panel cards, and the saved card order. Runs after the
// expand wiring above so the handle lands in a header that already knows how to
// toggle — the handle stops its own clicks from reaching it.
initPanelOrder();

loader.bindInputs(kernalInput, basicInput, charInput, drive1541Input);
loader.onReady(roms => {
  machine.loadROMs(roms);

  let tdeStatus = '';
  if (roms.drive1541) {
    machine.attachDrive(roms.drive1541);
    machine.setTrueDrive(tdeEnabled);
    tdeStatus = ` (1541 ROM ready, TDE ${tdeEnabled ? 'on' : 'off'})`;
    if (tdeToggleBtn) {
      tdeToggleBtn.disabled = false;
      _syncTdeBtn();
    }
    _syncDrive9TdeBtn();   // drive-9 TDE becomes available once the ROM is present
  }

  updateRomStatus();
  setStatus('ROMs loaded – press POWER ON' + tdeStatus, 'ready');
  // Setup banner was up; there is a machine to boot now.
  if (!running) _showPoweredOffScreen();
  // Media-load buttons enabled now (not gated on POWER ON) so the user
  // can insert tape/disk/cart before powering up. The data is cached
  // until POWER ON, then applied to the new C64Machine.
  if (d64Btn) d64Btn.disabled = false;
  if (d64NewBtn) d64NewBtn.disabled = false;
  if (tapBtn) tapBtn.disabled = false;
  if (tapNewBtn) tapNewBtn.disabled = false;   // BLANK inserts like LOAD does
  if (crtBtn) crtBtn.disabled = false;
});

kernalInput.addEventListener('change', updateRomStatus);
basicInput .addEventListener('change', updateRomStatus);
charInput  .addEventListener('change', updateRomStatus);
if (drive1541Input) {
  drive1541Input.addEventListener('change', () => {
    // Give ROMLoader's FileReader a tick to finish before we check.
    setTimeout(() => {
      updateRomStatus();
      // If the machine is already booted, attach the drive now so the user
      // doesn't have to reload the page after dropping in 1541.bin.
      if (loader.drive1541 && machine?.ready && !machine.drive1541) {
        machine.attachDrive(loader.drive1541);
        machine.setTrueDrive(tdeEnabled);
        if (tdeToggleBtn) {
          tdeToggleBtn.disabled = false;
          _syncTdeBtn();
        }
        _applyDrive9Tde();   // ROM now present → activate drive-9 TDE if it was intended
        setStatus('1541 ROM loaded — TDE on', 'ready');
      }
    }, 50);
  });
}

// Run autoLoad and pick a status string based on the result. Shared by
// the page-load IIFE below and the Clear-cache button so both flows show
// consistent messaging.
async function _runAutoLoad(scanningMsg) {
  setStatus(scanningMsg, 'idle');
  const loaded = await loader.autoLoad();
  updateRomStatus();
  _pingRomsLoaded();
  const cached = loader.cachedCount | 0;
  if (loaded === 3) {
    const suffix = cached > 0 ? ` (${cached} from cache)` : '';
    setStatus(`ROMs ready${suffix} – press POWER ON`, 'ready');
  } else if (loaded > 0) {
    setStatus(`${loaded}/3 ROMs found – load remaining manually`, 'idle');
  } else {
    setStatusAction('Load all three ', 'ROM files', ' to begin', _openSetup);
    // No ROMs anywhere (cache + server both empty) → open the Setup dialog.
    _openSetup();
  }
  // Nothing to boot: swap the boot banner for the Setup one.
  if (loaded < 3 && !running) _showPoweredOffScreen();
}

// ── Auto-load ROMs from cache + server on page load ───────────────────
// ROM beacons → Netlify (server-side) analytics: the same network-only marker
// trick as /pwa.html, a line under Top Pages carrying no payload and no
// identifier.
//
// Launch-scaled on purpose. Top Pages is a RANKED list, so a once-per-browser
// marker never surfaces — /pwa-installed.html never has, while /pwa.html, which
// pings every launch, does. So these fire once per page load: /roms-loaded.html
// whenever the machine has its ROMs (supplied now, or restored from the cache),
// and /roms-vice.html when they came out of a picked VICE folder. Read them as
// sessions with ROMs, not as people. No ROMs ship with the site, so every count
// is someone's own files.
const _ROM_SOURCE_KEY = 'c64emu.romsSource';

let _romsPinged = false;
function _pingRomsLoaded() {
  if (_romsPinged || !loader.allLoaded) return;
  _romsPinged = true;
  fetch('/roms-loaded.html', { cache: 'no-store' }).catch(() => {});
  let source = null;
  try { source = localStorage.getItem(_ROM_SOURCE_KEY); } catch {}
  if (source === 'vice') fetch('/roms-vice.html', { cache: 'no-store' }).catch(() => {});
}

// Remember the route, because a returning visit has no upload to observe: the
// ROMs come straight back out of the localStorage cache. Last install wins, so
// re-loading a slot by hand takes the pair back to 'upload'.
loader.onUserRom = (_key, source) => {
  try { localStorage.setItem(_ROM_SOURCE_KEY, source); } catch {}
  _pingRomsLoaded();
};

(async () => { await _runAutoLoad('Scanning for ROM files…'); })();

// Clear-cache button: wipes the four c64emu.rom.* localStorage slots,
// resets the loader's in-memory ROM state, then re-runs autoLoad so the
// server can repopulate the slots. The CURRENTLY-running machine keeps
// using whatever it powered on with — only future POWER ON cycles will
// pick up the new ROMs.
if (romClearBtn) {
  romClearBtn.addEventListener('click', async () => {
    if (!confirm('Remove all cached ROMs from browser storage?')) return;
    loader.clearCache();
    loader.kernal = null;
    loader.basic = null;
    loader.charRom = null;
    loader.drive1541 = null;
    loader.romNames = { kernal: null, basic: null, charRom: null, drive1541: null };
    updateRomFilenames();
    updateRomStatus();
    await _runAutoLoad('Cache cleared — scanning server…');
  });
}

// ── Audio init ───────────────────────────────────────────────────────────────
// Re-post the current machine's sidShared buffer to the worklet. Called
// once at audio init, then again after a power-on (which creates a new
// C64Machine with a fresh SharedArrayBuffer).
function wireSidToMachine() {
  if (sidNode && machine?.sidShared) {
    sidNode.port.postMessage({ type: 'init', shared: machine.sidShared, is8580, engine: sidEngine });
  }
}

function resetSidWorklet() {
  if (sidNode) sidNode.port.postMessage({ type: 'reset', is8580 });
}

async function initAudio() {
  if (audioCtx) return;
  // 48000: match common device rate (avoids browser resample padding that can
  // add fixed A/V lag on Safari). latencyHint: 'interactive' prefers a short
  // output buffer. Worklet derives cycles/sample from context.sampleRate.
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  // `?worker&url` makes Vite BUNDLE the worklet into one self-contained file
  // (its `import './sid-voice.js'` inlined as an IIFE). Plain `?url` / new URL()
  // only COPIED the source, leaving a dangling import that addModule can't
  // resolve in a production build → "Unable to load a worklet's module" (no
  // sound). The bundled script's hash still busts the cache on edits.
  await audioCtx.audioWorklet.addModule(sidWorkletUrl);
  setSidNode(new AudioWorkletNode(audioCtx, 'sid-processor'));
  // Master gain: SID + drive sounds both route through it so MUTE (and the
  // tab-hidden auto-mute) can silence everything with one gain. Initial value
  // honors the persisted MUTE choice.
  masterGain = audioCtx.createGain();
  masterGain.gain.value = audioMuted ? 0 : volumeToGain(masterVolume);
  masterGain.connect(audioCtx.destination);
  sidNode.connect(masterGain);
  registerAudioContext(audioCtx);        // debug surface: c64Trace.audioLatency()

  // Diagnostic messages from the worklet are silent in production. To
  // re-enable cycle-sync logging, opt in via `c64Trace.sidDiag = true`.
  sidNode.port.onmessage = (e) => {
    if (!window.c64Trace?.sidDiag) return;
    if (e.data?.type === 'diag-init') {
      console.log(`[sid] init processed: currentCycle ${e.data.ccBefore} → ${e.data.ccAfter}, wi=${e.data.wi}, ri=${e.data.ri}, is8580=${e.data.is8580}`);
    } else if (e.data?.type === 'diag-period') {
      const d = e.data;
      // applied/future/drained = event flow; pending/maxDepth = mirror occupancy;
      // lateMax/late = SCHEDULING health (events applied long after their stamp);
      // overrun/pendDrop = TRANSPORT health (producer outran consumer → data lost).
      console.log(`[sid] cy=${d.currentCycle} applied=${d.applied} future=${d.future} drained=${d.drained}`
        + ` pending=${d.pendingDepth}/${d.maxDepth} oldestFutureΔ=${d.oldestFutureΔ}`
        + ` lateMax=${d.lateMax} late=${d.late} overrun=${d.overrun} pendDrop=${d.pendDrop}`
        + ` backlogFF=${d.backlogFF}`);
    }
  };

  // Hand the SharedArrayBuffer to the worklet
  wireSidToMachine();

  // Synthesized 1541 drive sounds share the same AudioContext. Gated on the
  // DRIVE_SOUNDS_ENABLED constant; left null (silent) when disabled. Routed
  // through masterGain so MUTE reaches them too.
  if (driveSoundsEnabled) driveSounds = new DriveSounds(audioCtx, masterGain);

  // Trap-mode load sound is wired in the powerBtn handler now, so it
  // gets re-attached on every power-on (not just the first).
}

async function resumeAudio() {
  try {
    if (!audioCtx) await initAudio();
    // Do NOT await resume(): on a suspended context, resume() can stay pending
    // until the *next* user gesture, which would stall the awaited power-on and
    // make booting take two clicks. Fire it and let it settle on this gesture.
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    setRecorderAudioPaused(false);
    // NO resync here. This function is also the "make sure audio is running"
    // call on every keydown/pointerdown (see _restoreAudioFromUserGesture), and
    // a resync snaps currentCycle back to the OLDEST queued event — i.e. it
    // shoves the audio clock backwards by the whole queue depth. Firing that per
    // keypress injects lag continuously while a game is played, which is why it
    // showed up in games and never in a demo. Resync belongs to the paths that
    // actually froze emulation while audio kept running; they post it themselves.
    // A mobile foreground/background transition can pin the master gain to 0
    // even if the AudioContext resume is delayed until a later gesture.
    setMasterMuted(audioMuted);
  } catch (err) {
    // Audio is best-effort — never let an init/worklet failure block the boot.
    console.warn('[audio] init failed; continuing without sound:', err);
  }
}

// Suspend the whole audio graph (SID worklet + drive sounds). Used when the
// browser tab is hidden — see the visibilitychange handler below.
async function suspendAudio() {
  if (recorderAudioClockActive()) {
    setRecorderAudioPaused(true);
    return;
  }
  if (audioCtx && audioCtx.state === 'running') await audioCtx.suspend();
}

// Silence or restore the master output. `muted=true` pins the master gain to 0;
// `muted=false` restores it to the tapered volume level, volumeToGain(masterVolume)
// — the actual gain, not the raw slider position, and not always unity. Used by the
// Settings MUTE toggle, the volume slider (to re-apply a new level), and the tab-
// hidden auto-mute. No-op before initAudio() creates masterGain — the persisted
// audioMuted/masterVolume are applied to the gain's initial value there instead.
// A short time constant avoids a click on the level step.
function setMasterMuted(muted, instant = false) {
  if (!masterGain) return;
  const g = muted ? 0 : volumeToGain(masterVolume);
  try {
    if (instant) {
      // Hard cut (no ramp) — used to mute BEFORE a reset so the SID's state
      // discontinuity can't pop through a still-ramping gain.
      masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      masterGain.gain.setValueAtTime(g, audioCtx.currentTime);
    } else {
      masterGain.gain.setTargetAtTime(g, audioCtx.currentTime, 0.01);
    }
  } catch {
    masterGain.gain.value = g;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
// One tick of the loop: an animation frame while the page is visible, a timer
// while a hidden tab is allowed to run on. `rafId` holds either handle; which
// kind is remembered so the right cancel is used.
let tickIsTimer = false;
const HIDDEN_TICK_MS = 16;
function _scheduleTick() {
  if (runInBackground && document.hidden) {
    tickIsTimer = true;
    rafId = setTimeout(() => rafLoop(performance.now()), HIDDEN_TICK_MS);
  } else {
    tickIsTimer = false;
    rafId = requestAnimationFrame(rafLoop);
  }
}
function _cancelTick() {
  if (!rafId) return;
  if (tickIsTimer) clearTimeout(rafId); else cancelAnimationFrame(rafId);
  rafId = null;
}
// A pending animation frame never fires in a hidden tab, and a timer is the
// wrong driver for a visible one: on either change of state, re-arm.
function _redriveTick() {
  if (!rafId) return;
  _cancelTick();
  _scheduleTick();
}

function rafLoop(timestamp) {
  _scheduleTick();
  if (!running || paused) return;

  if (lastTime === 0) lastTime = timestamp;
  let delta = timestamp - lastTime;
  lastTime = timestamp;


  // Run faster than real time during the silent cold boot (until BASIC hits
  // READY), then snap back to 1x. The accumulator fills `BOOT_WARP`× faster,
  // so the while loop below executes that many more frames per wall-second.
  const warp = (_pristineBoot && !_hasBeenReady) ? BOOT_WARP : 1;

  // Cap delta to prevent "spiral of death" during heavy lag. The cap is divided
  // by `warp` so a tick can never queue more than 100 ms of EMULATED work
  // whatever the warp factor: at warp 1 this is the unchanged 100 ms, and at
  // BOOT_WARP=4 a stalled tick contributes 25 ms of wall time × 4 = the same
  // 100 ms. Undivided, one slow cold-boot tick queues ~20 frames, which on a
  // slow phone takes long enough that the NEXT tick also hits the cap and
  // queues another 20 — a self-sustaining several-hundred-ms main-thread block
  // (taps and scrolling dead) lasting the whole boot. Normal ticks (16.7 ms at
  // 60 Hz) are below 100/BOOT_WARP, so boot still warps at the full 4×.
  const deltaCap = 100 / warp;
  if (delta > deltaCap) delta = deltaCap;

  timeAccumulator += delta * warp;

  // Fixed-timestep with DECOUPLED rendering. Run as many emulated frames as the
  // accumulated wall-time calls for, so the emulation + SID always advance at
  // real time: after a hiccup we catch up the backlog rather than discard it, so
  // audio pitch stays correct and nothing runs in slow-motion. The screen is
  // drawn at most ONCE per rAF tick (the blit below), so under load the *visible*
  // FPS drops while emulation speed is unaffected — exactly the trade we want.
  //
  // The "spiral of death" is bounded by the 100 ms delta cap above: the
  // accumulator grows by at most 100 ms (×warp) per tick, i.e. ≤ floor(100 /
  // IDEAL_DELTA) ≈ 5 frames, so a single tick can never block unboundedly. We do
  // NOT cap frames-per-tick or zero the accumulator here — that capped catch-up
  // and made the emulation (and SID) run slow under load. Boot warp inflates the
  // accumulator on purpose and is likewise drained to completion each tick.
  let framesThisTick = 0;

  // Host input is sampled ONCE per tick, not once per emulated frame. No
  // pointer/key/gamepad event can be delivered while the loop below runs (JS is
  // single-threaded), so every catch-up frame would re-read byte-identical
  // state — and with a port set to a real gamepad, navigator.getGamepads()
  // allocates a fresh GamepadList (plus WebKit snapshot objects) per call,
  // multiplied by the catch-up factor. Browsers refresh gamepad state at
  // display cadence anyway. Key/touch/mouse changes don't wait for this call:
  // their event handlers push the port bytes through updateJoyPorts()
  // themselves. Gated on the loop actually running so a 120 Hz rAF with no
  // frame due doesn't poll MORE often than the per-frame version did.
  if (timeAccumulator >= IDEAL_DELTA) updateJoyPorts();

  while (timeAccumulator >= IDEAL_DELTA) {
    flushKeyboardPasteQueue();
    if (SHOW_FRAME_TIME) {
      const t0 = performance.now();
      machine.runFrame();
      frameComputeAccum += performance.now() - t0;
      frameComputeCount++;
    } else {
      machine.runFrame();
    }
    // Drive sounds edge-sample motor/half-track per emulated frame (a seek can
    // step several half-tracks within one rAF tick, so this must stay in the
    // loop to catch every stepper click) — but only when the feature is on:
    // `driveSounds` is null while DRIVE SOUND is OFF (the default), so the call
    // is bypassed entirely rather than paying a per-frame call + guard.
    if (driveSounds) updateDriveSounds();
    // Null unless the tape speaker is on, so the common case pays nothing.
    if (tapeSound) tapeSound.update(machine?.datasette);
    timeAccumulator -= IDEAL_DELTA;
    framesThisTick++;
  }

  const frameExecuted = framesThisTick > 0;

  // Track the pristine-boot state: once cold boot reaches READY, the machine
  // stays "pristine" until it next leaves the READY prompt (a program runs).
  if (_pristineBoot) {
    if (_basicReady()) setHasBeenReady(true);
    else if (_hasBeenReady) setPristineBoot(false);
  }

  // Service any deferred auto-load against the now-current state.
  if (_autoSeq) _serviceAutoLoad();

  if (frameExecuted) {
    if (presenter) presenter.present(machine.vic2.frameBuffer);
    else machine.vic2.blit(ctx);

    // A/V clapper: off by default. avMarkerEnabled() is a session boolean only
    // (no per-frame storage/URL). Instance exists only while on.
    if (!avMarkerEnabled()) {
      if (_avMarker) { _avMarker.stop(); _avMarker = null; }
    } else {
      if (!_avMarker) _avMarker = createAvMarker();
      _avMarker.tick(timestamp);
    }

    // Tape/drive DISPLAY indicators (LED, tape bar + time text) are display-only
    // — update once per presented frame, not per emulated frame. Inside the
    // catch-up loop this wrote style.width + textContent (layout thrash) up to
    // several times per rAF with a .tap loaded; once per tick is visually
    // identical.
    updateMediaIndicators();

    // Count emulated frames, not blits/ticks — so the FPS number reflects how
    // close we are to full-speed 50 fps emulation rather than the rAF tick rate.
    frameCount += framesThisTick;
    if (timestamp - lastFpsTime >= 1000) {
      const fps = Math.round((frameCount * 1000) / (timestamp - lastFpsTime));
      if (fpsCounter) fpsCounter.textContent = `FPS: ${fps}`;
      if (fpsDisplay) fpsDisplay.textContent = String(fps);
      if (SHOW_FRAME_TIME && frametimeDisplay && frameComputeCount > 0) {
        frametimeDisplay.textContent = (frameComputeAccum / frameComputeCount).toFixed(1);
      }
      if (HEAP_MEM && heapDisplay) {
        heapDisplay.textContent = (HEAP_MEM.usedJSHeapSize / 1048576).toFixed(1);
      }
      frameComputeAccum = 0;
      frameComputeCount = 0;
      frameCount = 0;
      lastFpsTime = timestamp;
    }
  }
}

function startLoop() {
  if (!rafId) _scheduleTick();
}

// ── Deferred auto-load ───────────────────────────────────────────────────────
// A load can't touch the machine until BASIC is idle at the READY prompt: a PRG
// load hard-resets first and must wait out the ~2 s cold boot (the RAM test);
// disk/tape loads don't reset but still type real KERNAL LOAD commands that only
// work at the prompt. So loads are DEFERRED and serviced from the RAF loop once
// BASIC is detected at READY — we run until ready is detected, never a fixed
// frame count.
//
// A pending auto-load is a list of steps run in order:
//   { ready }        wait until BASIC is idle at the READY prompt
//   { type: '…' }    feed text into the keyboard buffer (chunked: the KERNAL
//                    buffer holds only 10 bytes, so LOAD"*",8,1\r is split
//                    across ticks as BASIC drains it)
//   { loadDone }     wait until a preceding LOAD has finished — BASIC left the
//                    prompt to load and has now returned to READY
//   { wait: ms }     pause this many wall-clock ms before the next step (e.g.
//                    let the typed LOAD command stay on screen a beat)
//   { run: fn }      one-shot side effect (e.g. press PLAY on tape)
let _autoSeq = null;     // remaining steps, or null when idle
let _autoTypeRest = '';  // text left to feed for the current { type } step
let _autoSawBusy = false;// { loadDone }: have we seen BASIC leave the prompt yet
let _autoBudget = 0;     // service ticks left before we give up (safety net)
let _autoWaitUntil = 0;  // { wait }: performance.now() deadline, 0 = not started

// "Pristine boot" = the machine was just created (power-on / RESET) and nothing
// has run on it yet — it's still sitting at a clean cold-boot BASIC prompt.
// A PRG load skips its hard reset in this state (no point rebooting an already-
// fresh machine). Cleared the moment the machine leaves the READY prompt, i.e.
// once any program actually runs (auto-loaded, manually RUN, a cartridge, …).
// _pristineBoot / _hasBeenReady live in state.js — media.js also resets them on
// PRG/state load, so the binding is shared through the substrate module.

// BASIC is idle at the direct-mode READY prompt: keyboard buffer empty ($C6),
// cursor-blink/input mode active ($CC=0), and cold-start has set TXTTAB to
// $0801 ($2C hi byte = $08). True exactly at READY, stays true while idle.
function _basicReady() {
  const r = machine?.mem?.ram;
  return !!r && r[0x00C6] === 0 && r[0x00CC] === 0 && r[0x002C] === 0x08;
}

function _queueAutoLoad(steps) {
  _autoSeq = steps.slice();
  _autoTypeRest = '';
  _autoSawBusy = false;
  _autoWaitUntil = 0;
  // Safety net only — a step that never progresses (e.g. a first file that
  // auto-starts and never returns to READY) is abandoned rather than looping
  // forever. Generous so a slow true-drive LOAD is never cut short.
  _autoBudget = 10 * 60 * 60;   // ~10 min of active emulation
}

// Advance the pending auto-load one step per RAF tick. Called after the frame
// catch-up loop so it observes post-frame BASIC state.
function _serviceAutoLoad() {
  if (!_autoSeq || !machine?.ready) return;
  if (_autoBudget-- <= 0) { _autoSeq = null; return; }   // stuck (e.g. ?FILE NOT FOUND) — give up quietly
  const step = _autoSeq[0];
  if (step.ready) {
    if (_basicReady()) _autoSeq.shift();
  } else if (step.type !== undefined) {
    if (_autoTypeRest === '') _autoTypeRest = step.type;
    _autoTypeRest = _autoTypeRest.slice(machine.bufferKeyboardText(_autoTypeRest));
    if (_autoTypeRest === '') _autoSeq.shift();
  } else if (step.loadDone) {
    // A LOAD has finished once BASIC has left the READY prompt to load (the
    // residual keyboard buffer + the "SEARCHING…/LOADING" print guarantee a
    // !ready observation) and then returned to READY. The busy→ready edge is
    // independent of where the file loaded — real BASIC's LOAD",8,1 doesn't
    // update VARTAB for non-$0801 loads, so a program-present test would miss
    // those — and requiring the busy edge means a stale program left in RAM
    // (we no longer reset before a disk load) can't trigger RUN early.
    if (!_basicReady()) _autoSawBusy = true;
    if (_autoSawBusy && _basicReady()) {
      _autoSawBusy = false;
      _autoSeq.shift();
    }
  } else if (step.wait !== undefined) {
    // Hold for step.wait wall-clock ms (deadline set on first observation),
    // so e.g. the typed LOAD command lingers on screen before we press PLAY.
    if (_autoWaitUntil === 0) _autoWaitUntil = performance.now() + step.wait;
    if (performance.now() >= _autoWaitUntil) { _autoWaitUntil = 0; _autoSeq.shift(); }
  } else if (step.run) {
    try { step.run(); } catch {}
    _autoSeq.shift();
  } else {
    _autoSeq.shift();
  }
  if (_autoSeq && _autoSeq.length === 0) _autoSeq = null;
}

// Watch the 1541 for motor / stepper transitions and emit sounds accordingly.
function updateDriveSounds() {
  if (!driveSounds) return;
  const drv = machine.drive1541;
  if (!drv) return;

  // Motor on/off edge
  if (drv.motorOn !== prevMotorOn) {
    if (drv.motorOn) driveSounds.motorOn();
    else if (!driveSounds.isFakeLoading()) driveSounds.motorOff();
    prevMotorOn = drv.motorOn;
  }

  // Stepper click whenever the head moves to a new half-track
  if (drv.currentHalfTrack !== prevHalfTrack) {
    if (prevHalfTrack !== 0) driveSounds.click();
    prevHalfTrack = drv.currentHalfTrack;
  }
}

// ── Power / Reset ────────────────────────────────────────────────────────────
// POWER OFF deletes the C64Machine entirely; POWER ON creates a new
// instance and re-attaches cached ROMs / drive ROM / disk image / cart.
// RESET button is a HARD reset — it destroys the machine and builds a fresh
// one, identical to POWER OFF + POWER ON. (An in-place chip reset left the
// 1541 in a state where the next LOAD could deadlock the IEC handshake; a
// full re-create matches power-cycle behavior exactly.) softReset()
// (/RESET line, RAM preserved) is still available programmatically via
// machine.softReset({ allowSoft: true }).

// Build a fresh C64Machine and re-attach all cached peripherals (ROMs, SID
// worklet wiring, drive ROM + TDE, disk image, cartridge, tape). Shared by
// POWER ON and the RESET button so both produce an identical cold machine.
function _createAndWireMachine({ keepKey = true } = {}) {
  // The datasette is a separate box with its own mechanics: neither RESET nor a
  // power cycle winds its tape back. The machine is built from scratch here,
  // taking the deck with it, so where the head sits has to be read off the old
  // one first — and POWER OFF destroys the machine outright, so after that it
  // comes from the cache it left behind.
  //
  // The key is another matter, and only comes back on a power-on (keepKey). What
  // stops a real deck running on after a load is the KERNAL's motor interlock at
  // $C0, and a reset clears that along with the rest of page zero: put PLAY back
  // on a machine that has just been rebuilt and the interrupt handler energises
  // the motor with nothing to stop it, so the tape crawls on for ever behind a
  // READY prompt. Pressing PLAY and *then* switching on is a person's own doing,
  // and the flow this exists for; RESET is not.
  const deck = machine?.datasette?.hasMedia
    ? { key: machine.datasette.key, seconds: machine.datasette.elapsedSeconds }
    : _cachedTapDeck;
  setMachine(new C64Machine());
  if (typeof window !== 'undefined') window.machine = machine;
  machine.loadROMs({
    kernal:  loader.kernal,
    basic:   loader.basic,
    charRom: loader.charRom,
  });
  // Re-wire SID output to the audio worklet on the new machine.
  if (sidNode) wireSidToMachine();
  // Re-attach the trap-mode load sound hook (set only in initAudio otherwise,
  // so a re-created machine would have onLoadTrap = null).
  // Closure guards on `driveSounds` at call time, so it works regardless of
  // whether drive sound was on at power-on (it's toggleable live in Settings).
  machine.onLoadTrap = (dev) => {
    driveSounds && driveSounds.simulateLoad();
    if (dev === 9) _flashDrive9Led();
  };
  // Re-install the NEOS-mouse CIA1 hook on the freshly constructed machine.
  installNeosHook();
  // Re-apply persisted VIC/SID variants and resync the toggle labels.
  _applyVicVariantPref();
  _applySidVariantPref();
  _syncToggleLabels();
  // Re-attach drive ROM + TDE if it was loaded (TDE boots the drive to its
  // DOS idle scheduler so the first LOAD finds it listening for ATN).
  if (loader.drive1541) {
    machine.attachDrive(loader.drive1541);
    machine.setTrueDrive(tdeEnabled);
  }
  // Re-attach disk image if it was inserted.
  if (currentD64) machine.setD64(currentD64);
  // Re-apply the secondary device-9 drive (on/off + its disk + its TDE) on the
  // fresh machine, mirroring how the primary drive is restored above.
  machine.setDrive9Enabled(drive9Enabled);
  if (currentD64Drive9) machine.setD64Drive9(currentD64Drive9);
  if (drive9Enabled && drive9TdeEnabled && loader.drive1541) {
    machine.attachDrive9(loader.drive1541);   // real device-9 1541 on the bus
  }
  _syncDrive9TdeBtn();
  // Re-fit the RAM Expansion unit. Its RAM comes up blank here; a state load
  // fills it afterwards from the snapshot.
  _applyReu();
  // Re-apply cartridge if one was loaded; refresh UI label.
  if (_cachedCartData) {
    const info = machine.loadCartridge(_cachedCartData);
    _onCRTLoaded(info);
    resetSidWorklet();
  }
  // Re-load tape if one was inserted; refresh UI label + transport buttons. A
  // tape captured off a live deck carries its write-protect state with it, so a
  // reset mid-recording doesn't silently re-protect the tape.
  if (_cachedTapData) {
    machine.loadTap(_cachedTapData);
    if (_cachedTapProtected !== null) machine.setTapeWriteProtected(_cachedTapProtected);
    _onTapLoaded(_cachedTapName);
    // _onTapLoaded is written for a tape going in fresh — counter to zero, keys
    // up — so the deck's own state goes back on afterwards.
    if (deck) _restoreDeck(keepKey ? deck : { seconds: deck.seconds });
  }
  // Freshly created machine is "pristine" and will settle at a clean BASIC
  // prompt — unless a cartridge is present, which cold-boots into its own code
  // (no BASIC prompt), so a later PRG load must still reset.
  setPristineBoot(!_cachedCartData);
  setHasBeenReady(false);
}

// Peripheral state cached so a power-off → power-on cycle can re-apply
// it, AND so the user can insert tapes/disks/cartridges while powered
// off (they get applied at power-on).

// Power the machine on from the OFF state: build + wire a fresh machine, start
// the loop, enable the controls. No-op (returns true) if already running.
// Returns false if the ROMs aren't loaded yet. Shared by the POWER button and
// any action that needs the machine live (e.g. loading a library entry while
// powered off, mirroring how Load State boots an off machine).
async function _powerOn() {
  if (running) return true;
  if (!loader.allLoaded) { alert('Please load all three ROMs first.'); return false; }
  pauseDemo?.stop();
  _stopBootHint();
  // Both of those leave their last frame on the canvas, and the banner's can be a
  // stale one: _startBootHint no-ops while its loop is already running, so a fast
  // cached load cancels it before it ever repaints the ROMs-are-in text. Revealed
  // by the demo going away, that stale "PRESS TO START SETUP" flashes up until the
  // machine's first frame lands.
  _blankScreen();
  canvas.style.cursor = '';
  await resumeAudio();
  _createAndWireMachine();
  setRunning(true);
  _syncPowerStateClass();
  _punchLogo();
  startLoop();
  _syncWakeLock();
  setStatus('Running', 'running');
  resetBtn.disabled = false;
  pauseBtn.disabled = false;
  if (recordBtn) recordBtn.disabled = false;   // recording needs a running machine (live audio graph)
  prgBtn.disabled   = false;
  if (pasteBtn) pasteBtn.disabled = false;
  if (d64Btn) d64Btn.disabled = false;
  if (d64NewBtn) d64NewBtn.disabled = false;
  if (tapBtn) tapBtn.disabled = false;
  if (tapNewBtn) tapNewBtn.disabled = false;   // BLANK inserts like LOAD does
  if (crtBtn) crtBtn.disabled = false;
  _syncTapeButtons();          // BLANK + the transport keys need a live machine
  if (saveStateBtn) saveStateBtn.disabled = false;
  // The cartridge RESET/FREEZE buttons gate on `machine.ready && running`, but
  // the cached-cart re-apply inside _createAndWireMachine() above syncs them
  // through _onCRTLoaded() while `running` is still false — leaving them
  // disabled for the whole session. Re-sync now that the machine is up.
  _syncCartridgeControls();
  canvas.focus();
  return true;
}

powerBtn.addEventListener('click', async () => {
  // Nothing to power on until the ROMs are in, so POWER opens Setup instead —
  // live and pointing at what's missing beats greyed out with no explanation.
  if (!running && !_romsReady()) { _openSetup(); return; }
  if (running) {
    // Power off — stop the loop, destroy machine, blank the screen.
    // Load buttons (d64/tap/crt) stay enabled so the user can insert
    // media; it gets cached and applied on the next POWER ON.
    setRunning(false);
    _syncWakeLock();
    _syncPowerStateClass();
    // Blank the live-stat readouts while the machine is off.
    if (fpsDisplay) fpsDisplay.textContent = '–';
    if (frametimeDisplay) frametimeDisplay.textContent = '–';
    if (heapDisplay) heapDisplay.textContent = '–';
    _releaseAllLatched();
    _cancelTick();
    // Stop any drive audio that was active when the user pressed POWER
    // OFF (TDE motor, fake-load click train). Without this, the audio
    // graph kept playing through the entire off-period until the next
    // power-on edge happened to fire motorOff.
    if (driveSounds) driveSounds.motorOff();
    prevMotorOn = false;
    prevHalfTrack = 0;
    // Silence the SID worklet immediately. Without this, voices that
    // were in sustain when the user pressed POWER OFF kept droning
    // (the worklet keeps clocking voices regardless of whether the
    // main thread is emitting register writes). `resetSidWorklet`
    // posts a 'reset' that swaps in a fresh SIDChip (vol=0, voices
    // muted) but preserves clock sync for the next power-on.
    resetSidWorklet();
    updateMediaIndicators(false);   // stop the tape motor-dot pulse before the machine goes away
    _cacheTapeFromDeck();           // keep the tape (and any recording) for the next power-on
    setMachine(null);
    _syncCartridgeControls();
    _blankScreen();
    // Show the powered-off screen: the animated attract demo, or (when attract
    // mode is off) a static "PRESS POWER TO BOOT" hint. Both leave it clickable.
    _showPoweredOffScreen();
    setStatus('Powered off', 'idle');
    resetBtn.disabled = true;
    // Clear any active pause so the next power-on starts live (and un-suspend
    // the audio context the pause may have parked, else the next boot is mute).
    paused = false;
    _syncPausedClass();
    if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.textContent = '⏸ PAUSE'; }
    if (recordBtn) recordBtn.disabled = true;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    prgBtn.disabled   = true;
    if (pasteBtn) pasteBtn.disabled = true;
    if (saveStateBtn) saveStateBtn.disabled = true;   // can't snapshot an off machine
    // Tape transport keys are machine-bound; the deck sync disables them while
    // off and leaves .TAP export alone (a cached tape is still downloadable).
    _syncTapeButtons();
    return;
  }
  await _powerOn();
});

// Click the (black) screen while powered off to boot — a convenience alongside
// the POWER button. The vector-demo overlay has pointer-events:none, so the
// click lands here on #screen; reuse the POWER button's full power-on path.
// Guarded on `running` so a click during use never powers the machine off.
canvas.addEventListener('click', () => {
  if (running) return;
  // The banner says what the click does: Setup with no ROMs, else boot.
  if (!_romsReady()) _openSetup();
  else powerBtn.click();
});

// Mobile: a <canvas> can't raise the native soft keyboard, so a tap of the
// running screen focuses a hidden input (#mobile-kbd) and we route its
// keystrokes through the C64 keyboard MATRIX (softKeyboardInput), NOT the KERNAL
// buffer — so demos/games that poll $DC00/$DC01 directly (e.g. "HIT SPACE") see
// the key, not just BASIC (a held matrix tap fills the buffer via the IRQ scan
// too, so BASIC still works). beforeinput is the reliable cross-keyboard signal —
// soft keyboards report keyCode 229 / no `key` for printable keys via keydown,
// and the document keydown handlers bail on input targets (isEditableTarget)
// anyway, so routing happens here. (Paste stays on the buffer path — bulk text
// into BASIC, not per-key matrix taps.)
if (mobileKbd) {
  const softInsertState = new SoftKeyboardInsertState();

  // touchend (touch devices only) focuses the input inside the user gesture,
  // which is what raises the keyboard. Powered off → fall through to the click
  // handler above so the tap boots instead.
  canvas.addEventListener('touchend', (e) => {
    if (!running) return;
    e.preventDefault();          // suppress the synthetic click + double-tap zoom
    softInsertState.reset();
    mobileKbd.focus();
  }, { passive: false });

  // Soft keyboards route edits through inputType, not key codes: a Backspace or
  // Enter tap fires keydown with keyCode 229 / no `key`, so `e.key` checks miss
  // it — the per-tap signal is beforeinput's deleteContentBackward /
  // insertLineBreak. keydown here is the fallback for keyboards that DO emit real
  // keys (hardware / some AOSP). `_softEditViaKeydown` dedupes a keystroke that
  // fires both: keydown runs first and resets the flag, so a keyCode-229 keydown
  // still lets beforeinput handle the edit, while a recognized keydown suppresses
  // the paired beforeinput. preventDefault keeps the hidden field empty.
  let _softEditViaKeydown = false;
  mobileKbd.addEventListener('keydown', (e) => {
    if (!running) return;
    _softEditViaKeydown = false;
    if (e.key === 'Enter') {
      softInsertState.reset();
      softKeyboardInput('\n'); _softEditViaKeydown = true; e.preventDefault();
    } else if (e.key === 'Backspace') {
      softInsertState.reset();
      softKeyboardInput('\x14'); _softEditViaKeydown = true; e.preventDefault();  // → C64 DEL key
    }
  });
  mobileKbd.addEventListener('beforeinput', (e) => {
    if (running) {
      const t = e.inputType;
      if (t === 'insertText' && e.data) {              // printable + swipe/autocomplete
        softKeyboardInput(softInsertState.normalize(e.data));
      } else if (!_softEditViaKeydown) {
        if (t && t.startsWith('delete')) {
          softInsertState.reset();
          softKeyboardInput('\x14');                   // → C64 DEL key
        } else if (t === 'insertLineBreak' || t === 'insertParagraph') {
          softInsertState.reset();
          softKeyboardInput('\n');
        }
      }
    }
    e.preventDefault();
  });
}

// Hard reset = POWER OFF + POWER ON: throw away the machine and build a fresh
// one. This guarantees the 1541 cold-boots exactly as on power-up (an in-place
// reset could leave the drive mid-DOS-boot, deadlocking the next LOAD). The RAF
// loop keeps running against the new global `machine`. Returns false (no-op) if
// powered off. Does NOT touch any pending auto-load — callers that mean a
// user-initiated reset clear `_autoSeq` themselves.
function _hardReset() {
  if (!running) return false;
  _releaseAllLatched();
  // The machine is about to be replaced: take whatever is on the tape with us,
  // recording included, the way an inserted disk survives by being a live object.
  _cacheTapeFromDeck();
  // Mute the master output (hard cut) across the SID reset + machine re-wire so
  // the worklet's state discontinuity — old event ring → new, all voices reset —
  // can't pop, then restore the user's mute preference once it has settled.
  setMasterMuted(true, true);
  resetSidWorklet();
  _createAndWireMachine({ keepKey: false });
  _syncPowerStateClass();
  if (pasteBtn) pasteBtn.disabled = false;
  clearTimeout(_resetUnmuteTimer);
  _resetUnmuteTimer = setTimeout(() => setMasterMuted(audioMuted), 150);
  return true;
}

resetBtn.addEventListener('click', () => {
  if (!_hardReset()) return;       // RESET only when powered on
  if (paused) _setPaused(false);   // a reset always resumes, so its effect is visible
  _autoSeq = null;                 // a manual reset cancels any deferred auto-load
  _punchLogo();                    // same boot shake-zoom as power-on
  setStatus('Reset – Running', 'running');
});

// PAUSE: freeze/resume the emulation loop (rafLoop bails while `paused`).
// `running` stays true so the machine isn't torn down — only the per-frame
// stepping stops. Outside recording, audio is suspended so voices don't drone;
// during recording its tap is gated to silence while the source clock continues.
function _setPaused(p) {
  paused = p;
  _syncPausedClass();
  if (pauseBtn) pauseBtn.textContent = p ? '▶ RESUME' : '⏸ PAUSE';
  if (p) {
    suspendAudio();
    if (driveSounds) driveSounds.motorOff();
    setStatus('Paused', 'idle');
  } else {
    // Resuming: drop the accumulated wall-clock gap so we don't burst-run a
    // backlog of frames to "catch up" (same reset the state-load path does).
    lastTime = 0;
    timeAccumulator = 0;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    setRecorderAudioPaused(false);
    // While recording, suspendAudio() leaves the context running on purpose, so
    // the worklet's sample-driven clock kept advancing through the freeze and now
    // leads the emulation clock by the pause duration — under the 0.5 s snap for
    // a short pause, i.e. a permanent offset. Same re-align as fullscreen/thaw.
    if (sidNode) sidNode.port.postMessage({ type: 'resync' });
    // Restore the output gain to the Settings MUTE choice — a tab-hidden mute
    // may have pinned it to 0 while we were paused, and we skip the unmute on
    // tab-return while paused, so re-assert it here.
    setMasterMuted(audioMuted);
    setStatus('Running', 'running');
  }
  // Refresh media indicators for the new run state — the rAF loop won't run
  // while paused to clear the (compositor-driven) tape motor-dot pulse.
  updateMediaIndicators(!p);
  _syncWakeLock();
}

pauseBtn.addEventListener('click', () => {
  if (!running) return;            // pause only matters while powered on
  _setPaused(!paused);
  canvas.focus();
});

// Freeze + mute the machine across Retro Vibes' open/close transitions
// (see retrovibes.js busy hooks). Same mechanism as PAUSE — bail the rafLoop and
// suspend audio — but without touching the PAUSE button UI, and preserving a
// user's own manual pause (only pause if we were running, only resume if we did).
let _vibesPausedByUs = false;
function vibesBusyStart() {
  if (!running || paused) return;   // powered off or already paused → leave it be
  _vibesPausedByUs = true;
  paused = true;                    // rafLoop bails → no runFrame → no SID samples generated
  _syncPausedClass();
  // Mute the live output for the transition. Suspending the context is the real
  // silencer, but during a recording suspendAudio() deliberately keeps it
  // running (see there) — and the SID is clocked on the audio thread, so it
  // would drone the last voice and crackle while GL init / model load / scene
  // build hold the main thread. The 10 ms ramp is scheduled on the audio thread,
  // so it completes even though the main thread is about to stall; the tap that
  // feeds the recorder sits upstream of masterGain, so the file is unaffected.
  setMasterMuted(true);
  suspendAudio();
  if (driveSounds) driveSounds.motorOff();
}
function vibesBusyEnd() {
  if (!_vibesPausedByUs) return;
  _vibesPausedByUs = false;
  lastTime = 0; timeAccumulator = 0;   // drop the wall-clock gap so we don't burst-catch-up
  paused = false;
  _syncPausedClass();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  setRecorderAudioPaused(false);
  if (sidNode) sidNode.port.postMessage({ type: 'resync' });   // clock ran on during the transition
  setMasterMuted(audioMuted);          // unmute: back to the Settings MUTE choice
}

// ── Display size (1X / 2X / 2.5X / 3X) ───────────────────────────────────────
// In-page picture size toggled by the SIZE button (independent of FULL). Each is
// a whole multiple of the 384x272 framebuffer; the widths live in
// styles-display.css. 2X is the default and carries no class. The side-panel
// controls always take the width the picture leaves, in two columns where it fits.
// Persisted under c64emu.sizeMode. FULL (fullscreen) overrides the layout but
// preserves this choice, so exiting fullscreen returns to the chosen size.
{
  const SIZE_ORDER = ['1x', '2x', '25x', '3x', 'max'];   // cycle order
  const SIZE_LABEL = { '1x': '1X', '2x': '2X', '25x': '2.5X', '3x': '3X', 'max': 'MAX' };
  let sizeMode = '2x';   // a persisted choice below still wins
  try {
    const v = localStorage.getItem('c64emu.sizeMode');
    if (SIZE_ORDER.includes(v)) sizeMode = v;
    // A size that no longer exists ('15x', dropped) is rewritten rather than
    // just ignored, so storage and the UI agree without waiting for a click.
    else if (v !== null) localStorage.setItem('c64emu.sizeMode', sizeMode);
  } catch {}


  // A multiple wider than the space it has is clamped to that space, so on a
  // narrow window the larger ones all render identically and the button appears
  // to do nothing. Offer only the multiples that fit at their true size, and let
  // MAX cover whatever is left over — a picture that fills the width honestly,
  // rather than a "3X" that is nothing of the sort.
  const SIZE_PX = { '1x': 384, '2x': 768, '25x': 960, '3x': 1152 };

  // What the picture itself could have. Deliberately NOT the screen column's
  // current width: its grid track is minmax(0, max-content), so the column hugs
  // whatever size is showing — measuring it would let 1X answer "only 1X fits"
  // and strand the cycle there. Work from the row instead, leaving the panel its
  // minimum track when the two sit side by side, and take off whatever the frame
  // draws around the picture (26px a side under the CRT presets, otherwise 1px).
  const availableWidth = () => {
    const wrap = document.querySelector('.main-wrap');
    if (!wrap) return Infinity;
    const ws = getComputedStyle(wrap);
    const stacked = ws.gridTemplateColumns.trim().split(/\s+/).length < 2;
    const gap = parseFloat(ws.columnGap) || 0;
    const panelMin = parseFloat(ws.getPropertyValue('--panel-min')) || 0;
    const mon = document.querySelector('.c64-monitor');
    const cs = mon && getComputedStyle(mon);
    const chrome = cs ? (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) * 2 : 0;
    return wrap.clientWidth - (stacked ? 0 : panelMin + gap) - chrome;
  };

  const usableSizes = () => {
    const avail = availableWidth();
    const out = SIZE_ORDER.filter(s => s !== 'max' && SIZE_PX[s] <= avail);
    // MAX earns its place only when it beats the largest multiple that fits;
    // on a wide window 3X already reaches the edge and MAX would repeat it.
    const largest = out.length ? SIZE_PX[out[out.length - 1]] : 0;
    if (avail > largest + 1) out.push('max');
    return out.length ? out : ['1x'];
  };

  // A size restored from storage that this width cannot show lands outside the
  // list; indexOf gives -1 and the cycle starts from the smallest.
  const nextSize = (from) => {
    const list = usableSizes();
    return list[(list.indexOf(from) + 1) % list.length];
  };

  // The button is shown at every width; the cycle below offers whatever the
  // width can actually hold, which on a phone is 1X and MAX. A size restored
  // from storage that this width cannot show — 3X on a phone — is displayed as
  // the nearest it can, without overwriting the choice, so widening the window
  // brings it straight back.
  const apply = () => {
    const list = usableSizes();
    const eff = list.includes(sizeMode) ? sizeMode : list[list.length - 1];
    document.body.classList.toggle('size-1x', eff === '1x');
    document.body.classList.toggle('size-25x', eff === '25x');
    document.body.classList.toggle('size-3x', eff === '3x');
    document.body.classList.toggle('size-max', eff === 'max');
    // Label what is on screen, not what is in storage.
    if (sizeBtn) sizeBtn.textContent = `SIZE: ${SIZE_LABEL[eff]}`;
  };

  apply();
  // Which sizes fit depends on the width, so re-decide when it changes.
  // Coalesced into a frame: apply() measures the row, which flushes layout.
  let sizePending = false;
  const reapply = () => {
    if (sizePending) return;
    sizePending = true;
    requestAnimationFrame(() => { sizePending = false; apply(); });
  };
  addEventListener('resize', reapply);
  addEventListener('orientationchange', reapply);

  if (sizeBtn) {
    sizeBtn.addEventListener('click', () => {
      sizeMode = nextSize(sizeMode);
      apply();
      try { localStorage.setItem('c64emu.sizeMode', sizeMode); } catch {}
      canvas.focus();
    });
  }
}

// ── Fullscreen ───────────────────────────────────────────────────────────────
function enterFullscreen() {
  document.body.classList.add('fullscreen-mode');
  const root = document.documentElement;
  if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
  canvas.focus();
}

function exitFullscreen() {
  document.body.classList.remove('fullscreen-mode');
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  canvas.focus();
}

if (fullscreenBtn) fullscreenBtn.addEventListener('click', enterFullscreen);
if (fsCloseBtn)    fsCloseBtn.addEventListener('click', exitFullscreen);

// Sync class with native fullscreen state — covers browser ESC, F11, etc.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('fullscreen-mode');
  // The fullscreen transition can stall the main thread (layout reflow, or a
  // transient blur→focus) while the audio worklet keeps clocking — drifting its
  // sample clock ahead of the emulation clock and leaving the music subtly out
  // of sync on return (reported on mobile). Re-sync the worklet; no-op if audio
  // hasn't started.
  if (sidNode) sidNode.port.postMessage({ type: 'resync' });
});

// Assigned by the CRT block below so input.js can drive it from the shortcut; the mode
// state stays scoped to that block.
let _cycleCrtEffect = () => {};

// CRT effect — persisted under c64emu.crtMode. Modes:
//   'on'     basic scanlines (no body class)
//   'tube'   authentic colour CRT (phosphor mask + scanlines + vignette + glow)
//   'bw'     monochrome CRT (tube look, grayscale, no RGB mask)
//   'arcade' punchy sharp arcade monitor (bright, strong tight scanlines)
//   'hum'    tube look + a slow rolling mains-hum brightness bar
//   'off'    flat
// Legacy 'on'/'off' values remain valid. Default = 'on'.
// Button cycles on → tube → bw → arcade → hum → off → on.
{
  const MODES = ['on', 'tube', 'bw', 'arcade', 'hum', 'off'];
  let crtMode = 'on';
  try {
    const v = localStorage.getItem('c64emu.crtMode');
    if (MODES.includes(v)) crtMode = v;
  } catch {}
  const LABELS = {
    on:     '🖥 CRT: ON',
    tube:   '🖥 CRT: TUBE',
    bw:     '🖥 CRT: B&W',
    arcade: '🖥 CRT: ARCADE',
    hum:    '🖥 CRT: HUM',
    off:    '🖥 CRT: OFF',
  };
  const apply = () => {
    document.body.classList.toggle('crt-off',    crtMode === 'off');
    document.body.classList.toggle('crt-tube',   crtMode === 'tube');
    document.body.classList.toggle('crt-bw',     crtMode === 'bw');
    document.body.classList.toggle('crt-arcade', crtMode === 'arcade');
    document.body.classList.toggle('crt-hum',    crtMode === 'hum');
    if (crtEffectBtn) {
      crtEffectBtn.textContent = LABELS[crtMode];
    }
  };
  apply();
  const cycle = () => {
    crtMode = MODES[(MODES.indexOf(crtMode) + 1) % MODES.length];
    apply();
    try { localStorage.setItem('c64emu.crtMode', crtMode); } catch {}
  };
  if (crtEffectBtn) crtEffectBtn.addEventListener('click', cycle);
  // Cmd+Shift+F is bound in input.js, next to the snapshot shortcut — see
  // initInput below.
  _cycleCrtEffect = cycle;
}

// Autorun toggle: when ON, the file-picker / drag-drop / D64-entry-click
// load paths inject RUN ($0801) or SYS <addr> (other) after loadPRG.
// When OFF, control stays at the BASIC READY. prompt. Default ON; the
// state is persisted in localStorage across reloads.
let autorunEnabled = (() => {
  try { return localStorage.getItem('c64emu.autorun') !== 'off'; }
  catch { return true; }
})();
function _renderAutorunBtn() {
  if (!autorunBtn) return;
  autorunBtn.textContent = autorunEnabled ? 'AUTORUN: ON' : 'AUTORUN: OFF';
}
_renderAutorunBtn();
if (autorunBtn) {
  autorunBtn.addEventListener('click', () => {
    autorunEnabled = !autorunEnabled;
    try { localStorage.setItem('c64emu.autorun', autorunEnabled ? 'on' : 'off'); } catch {}
    _renderAutorunBtn();
  });
}


// ── Credits modal ──────────────────────────────────────────────────────
if (creditsVer) creditsVer.textContent = VERSION;

// The About body copy is authored once in docs/ABOUT.md (also compiled to the
// public /docs/about.html page). The build emits a bare, chrome-less
// about-fragment.html; fetch it on first open and inject it into the modal.
// Fetched once, then it lives in the node (and the service worker precaches it,
// so it still opens offline). Off-site links in it open a new tab; internal
// /docs/ links navigate in place.
let _creditsLoaded = false;
async function _loadCreditsBody() {
  if (_creditsLoaded || !creditsProse) return;
  try {
    const res = await fetch('/docs/about-fragment.html');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    creditsProse.innerHTML = await res.text();
    _creditsLoaded = true;
  } catch (err) {
    // Leave _creditsLoaded false so a later open retries the fetch.
    creditsProse.innerHTML =
      "<p>Couldn't load the about text — read it in the " +
      '<a class="credits-link-inline" href="/docs/about.html">documentation</a>.</p>';
    console.warn('[credits] failed to load about-fragment.html:', err);
  } finally {
    creditsProse.removeAttribute('aria-busy');
  }
}

function _openCredits()  { if (creditsModal) { creditsModal.hidden = false; _loadCreditsBody(); pushEscapeLayer(_creditsEscape); } }
function _closeCredits() { if (creditsModal) creditsModal.hidden = true; popEscapeLayer(_creditsEscape); }
const _creditsIsOpen = () => creditsModal && !creditsModal.hidden;
const _creditsEscape = { close: _closeCredits, isOpen: _creditsIsOpen };

if (creditsBtn)   creditsBtn.addEventListener('click', _openCredits);
if (creditsClose) creditsClose.addEventListener('click', _closeCredits);
if (creditsModal) {
  creditsModal.addEventListener('click', e => {
    if (e.target === creditsModal) _closeCredits();
  });
}

// Swallow keys while the credits modal is open, so nothing reaches the C64.
// Escape is escape-stack.js's and never gets here.
document.addEventListener('keydown', e => {
  if (!_creditsIsOpen()) return;
  e.stopImmediatePropagation();
  e.preventDefault();
}, { capture: true });

// ── Retro Vibes — 3D model viewer ────────────────────────────────────────────
// The 🌇 Retro Vibes button (Controls) → a browser-window-filling Three.js scene
// of the C64 model, lit like an 80s synthwave demo (see retrovibes.js). Lazy:
// three.js + its addons are ~700 kB and this scene only opens on that button, so
// defer importing retrovibes.js (and thus three) until the first open — it then
// splits into its own chunk instead of bloating the main bundle. On first open
// the module also builds its WebGL context and loads the GLB, then keeps them
// resident.
let modelViewer = null;
let _modelViewerPromise = null;
async function _ensureModelViewer() {
  if (modelViewer) return modelViewer;
  if (!_modelViewerPromise) _modelViewerPromise = (async () => {
    const { ModelViewer } = await import('./retrovibes.js');
    const mv = new ModelViewer(document.getElementById('model-viewer-overlay'));
    if (typeof window !== 'undefined') window.modelViewer = mv;
    // Feed the live emulator framebuffer to the model's CRT. `machine` is
    // re-created on power/reset, so read it fresh each call (the viewer re-points
    // its texture when the buffer reference changes). 384×272 = vic2 canvas.
    mv.setScreenProvider(() => {
      const vic = machine && machine.vic2;
      if (!running || !vic || !vic.frameBuffer) return null;
      return { data: vic.frameBuffer, width: 384, height: 272 };
    });
    // Double-click in the 3D scene powers on (the power button's full boot path).
    // No-op when running, and when the ROMs aren't in: POWER opens Setup then, and
    // this overlay covers the page opaquely, so the dialog would open unseen.
    mv.setOnDoubleClick(() => {
      if (!running && _romsReady()) powerBtn.click();
    });
    // Light the modelled power LEDs whenever the machine is running (C64 + the
    // 1541's green LED), and the 1541's red LED from the drive read/activity
    // indicator (same signal as the device-8 drive LED in the controls section).
    mv.setPowerProvider(() => running);
    mv.setDriveActiveProvider(() => !!machine?.drive1541?.ledOn || drive9LedActive());
    mv.setTouchControls(touchControls);
    // Pause + mute the machine while the viewer loads (open) and tears down
    // (close), so those main-thread stalls don't underrun the SID ring.
    mv.setBusyHooks(vibesBusyStart, vibesBusyEnd);
    // The powered-off screen keeps animating behind the overlay otherwise — the
    // attract demo is a second WebGL context rendering a full scene nobody can
    // see, competing for the GPU with the one they can. vibesBusyStart can't do
    // this: it returns early when the machine isn't running, which is exactly
    // when the attract demo IS running.
    mv.setVisibilityHooks(
      () => { pauseDemo?.stop(); _stopBootHint(); },
      () => { if (!running) _showPoweredOffScreen(); },   // re-decides banner vs demo
    );
    modelViewer = mv;
    return mv;
  })();
  return _modelViewerPromise;
}
if (vibesBtn) vibesBtn.addEventListener('click', async () => {
  (await _ensureModelViewer()).open();
});

// The VIBES button's own pocket demo — a field of dark pixels morphing through
// ten sine patterns behind the label (vibes-btn-fx.js). Decoration, so it is
// switchable from Options ▸ Display and persisted; default ON.
const vibesBtnFx = attachVibesButtonFx(vibesBtn);

// Cmd+Shift+Z zooms that button to 10x in a dialog. Wired through
// input.js's shortcut table, since Z is also a C64 key.
const vibesZoom = createVibesZoom(vibesBtn, vibesZoomModal, vibesZoomStage, vibesZoomClose);
if (vibesFxBtn && vibesBtnFx) {
  let fxEnabled = (() => {
    try { return localStorage.getItem('c64emu.vibesBtnFx') !== 'off'; }
    catch { return true; }
  })();
  const _syncFxLabel = () => {
    vibesFxBtn.textContent = `VIBES BUTTON FX: ${fxEnabled ? 'ON' : 'OFF'}`;
  };
  _syncFxLabel();
  const _applyFx = () => {
    vibesBtnFx.setEnabled(fxEnabled);
    vibesZoom?.setFxEnabled(fxEnabled);   // the zoom shows the same button
  };
  _applyFx();
  vibesFxBtn.addEventListener('click', () => {
    fxEnabled = !fxEnabled;
    try { localStorage.setItem('c64emu.vibesBtnFx', fxEnabled ? 'on' : 'off'); } catch {}
    _syncFxLabel();
    _applyFx();
  });
} else if (vibesFxBtn) {
  vibesFxBtn.hidden = true;   // no canvas (no 2D context) — nothing to toggle
}
if (modelViewerCloseBtn) modelViewerCloseBtn.addEventListener('click', () => modelViewer?.close());

// Model-credit link → toggle its little popup; click-away or Esc dismisses it.
if (creditLink && creditPopup) {
  const creditEscape = { close: () => setCredit(false), isOpen: () => !creditPopup.hidden };
  const setCredit = (show) => {
    creditPopup.hidden = !show;
    creditLink.setAttribute('aria-expanded', String(show));
    if (show) pushEscapeLayer(creditEscape); else popEscapeLayer(creditEscape);
  };
  creditLink.addEventListener('click', (e) => { e.stopPropagation(); setCredit(creditPopup.hidden); });
  document.addEventListener('click', (e) => {
    if (!creditPopup.hidden && !creditPopup.contains(e.target) && e.target !== creditLink) setCredit(false);
  });
  // No keydown listener: closing on Escape is escape-stack.js's, and that was all
  // this one did. It called stopPropagation, which does not stop sibling listeners
  // on the same node, so it never really claimed the key in the first place.
}

// The C64 keyboard stays fully live while the viewer is open — you can type and
// watch it on the modelled TV — so nothing here captures or swallows keys. Escape
// closes the viewer via the layer it pushes in ModelViewer.open().

// ── Settings dialog ─────────────────────────────────────────────────────────
// Houses the VIC / SID / palette toggles and the ROM-file selectors (all of
// which are wired by id elsewhere, so they work unchanged from inside here).

function _openSettings()  { if (settingsModal) { settingsModal.hidden = false; pushEscapeLayer(_settingsEscape); } }
function _closeSettings() { if (settingsModal) settingsModal.hidden = true; popEscapeLayer(_settingsEscape); }
const _settingsIsOpen = () => settingsModal && !settingsModal.hidden;
const _settingsEscape = { close: _closeSettings, isOpen: _settingsIsOpen };

if (settingsBtn)   settingsBtn.addEventListener('click', _openSettings);
if (settingsClose) settingsClose.addEventListener('click', _closeSettings);
if (settingsModal) {
  settingsModal.addEventListener('click', e => {
    if (e.target === settingsModal) _closeSettings();
  });
}

// Swallow keys while the settings modal is open (same pattern as credits) — but
// never when a text field is focused (its own inputs, or the Fetch-ROMs URL
// fields layered on top): those must type and paste normally.
document.addEventListener('keydown', e => {
  if (!_settingsIsOpen()) return;
  // Escape belongs to escape-stack.js; everything else is swallowed below.
  if (isEditableTarget(e.target)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
}, { capture: true });

// ── Setup C64 READY. dialog ──────────────────────────────────────────────────
// First-run ROM setup. The emulator needs Commodore's copyrighted ROM images, so
// the user supplies them: this dialog offers the same file selectors as
// Options ▸ ROM Files, plus a "help me find it" web search per ROM. It NEVER
// downloads a ROM — it only points a search engine at the exact filename, so the
// user makes the conscious choice to fetch it. Auto-opens on page load when no
// ROMs are present (see _runAutoLoad).

function _openSetup() {
  if (!setupModal || !setupModal.hidden) return;
  _syncSetupDoneLabel();
  setupModal.hidden = false;
  pushEscapeLayer(_setupEscape);
}
function _closeSetup() { if (setupModal) setupModal.hidden = true; popEscapeLayer(_setupEscape); }
const _setupIsOpen = () => setupModal && !setupModal.hidden;
const _setupEscape = { close: _closeSetup, isOpen: _setupIsOpen };

document.getElementById('btn-setup-close')?.addEventListener('click', _closeSetup);
document.getElementById('btn-setup-later')?.addEventListener('click', _closeSetup);
if (setupModal) {
  setupModal.addEventListener('click', e => {
    if (e.target === setupModal) _closeSetup();
  });
}

// Wire the Setup dialog's ROM file inputs through the SAME load path as the
// Options selectors (bindInputs → loader._loadFile → validate + cache + onReady),
// so a ROM loaded here is treated identically. On change, refresh the status and
// close the dialog once all required ROMs are in.
const _setupInputs = [
  document.getElementById('setup-rom-kernal'),
  document.getElementById('setup-rom-basic'),
  document.getElementById('setup-rom-char'),
  document.getElementById('setup-rom-1541'),
];
loader.bindInputs(_setupInputs[0], _setupInputs[1], _setupInputs[2], _setupInputs[3]);
// The dialog never closes itself — the user dismisses it, so they can add the
// optional 1541 ROM after the three mandatory ones. Once those three are in, the
// dismiss button relabels from "Find them later" to "Done".
const _setupLaterBtn = document.getElementById('btn-setup-later');
function _syncSetupDoneLabel() {
  if (_setupLaterBtn) {
    _setupLaterBtn.textContent =
      (loader.kernal && loader.basic && loader.charRom) ? 'Done' : 'Find them later';
  }
}
for (const el of _setupInputs) {
  el?.addEventListener('change', () => {
    // loader._loadFile reads the file asynchronously; check after it lands.
    setTimeout(() => { updateRomStatus(); _syncSetupDoneLabel(); }, 80);
  });
}
_syncSetupDoneLabel();

// "Get ROM files from VICE": one directory pick, then the C64 images are taken
// out of the tree by name (see pickViceRoms) and installed through the same
// setRomData path as an upload. The browser hands over every file in the tree
// and announces that as an upload of hundreds of files; only the ROM images are
// ever read. showDirectoryPicker would ask more quietly, but Chrome refuses
// /Applications to it as system files, which is where VICE lives on a Mac.
const _viceDirInput = document.getElementById('setup-vice-dir');
const _viceStatusEl = document.getElementById('setup-vice-status');
const _ROM_SLOT_LABELS = { kernal: 'KERNAL', basic: 'BASIC', charRom: 'CHARGEN', drive1541: '1541 DOS' };

// Hide the section where a folder can't be chosen: no webkitdirectory at all,
// or a touch-primary device, where iOS Safari exposes the property but its file
// picker has no folder mode (and no VICE install to point it at either).
if (!('webkitdirectory' in document.createElement('input'))
    || window.matchMedia?.('(pointer: coarse)').matches) {
  document.getElementById('setup-vice-section')?.setAttribute('hidden', '');
}

function _setViceStatus(msg) { if (_viceStatusEl) _viceStatusEl.textContent = msg; }

_viceDirInput?.addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  e.target.value = '';                     // so the same folder can be picked again
  if (!files.length) return;
  const root = files[0].webkitRelativePath?.split('/')[0] || 'that folder';
  const picked = pickViceRoms(files);
  const loaded = [];
  for (const [key, file] of Object.entries(picked)) {
    try {
      loader.setRomData(key, new Uint8Array(await file.arrayBuffer()), file.name, 'vice');
      loaded.push(_ROM_SLOT_LABELS[key]);
    } catch {}                             // wrong size for the slot: treat as not found
  }
  const missing = Object.values(_ROM_SLOT_LABELS).filter(label => !loaded.includes(label));
  _setViceStatus(loaded.length
    ? `Loaded ${loaded.join(', ')} from ${root}.` + (missing.length ? ` Not found: ${missing.join(', ')}.` : '')
    : `No C64 ROMs found in ${root}. Try the folder VICE is installed in.`);
  updateRomStatus();
  _syncSetupDoneLabel();
});

// "help me find it" links: open a web search for the exact ROM filename so the
// user can locate and download it themselves. We deliberately do NOT link to or
// fetch the file — only point a search engine at a publicly-indexed filename, so
// the user makes the conscious choice to download it.
for (const btn of document.querySelectorAll('.rom-find')) {
  btn.addEventListener('click', () => {
    const file = btn.getAttribute('data-rom-search');
    if (!file) return;
    const q = encodeURIComponent(`"${file}"`);
    window.open(`https://www.google.com/search?q=${q}`, '_blank', 'noopener,noreferrer');
  });
}

// Keep keys off the emulator while the dialog is open (capture phase beats the
// emulator's bubble-phase matrix handler). Escape closes; the file inputs aren't
// text fields, so nothing needs to type through.
document.addEventListener('keydown', e => {
  if (!_setupIsOpen()) return;
  // Escape belongs to escape-stack.js; everything else is swallowed below.
  if (isEditableTarget(e.target)) return;
  e.stopImmediatePropagation();
}, { capture: true });


// Read the clipboard and queue it into the C64 keyboard buffer. Shared by the
// PASTE button and the Cmd+Shift+V / Ctrl+Shift+V shortcut (both use the async
// Clipboard API, so the shortcut behaves identically to the button).
async function _pasteFromClipboard() {
  if (!running) return;
  try {
    const text = await navigator.clipboard.readText();
    const queued = queuePastedTextAndReport(text);
    if (queued === 0) setStatus('Clipboard has no BASIC-safe text to paste', 'idle');
    else canvas.focus();
  } catch (err) {
    setStatus(`Paste failed: ${err?.message || 'clipboard unavailable'}`, 'error');
  }
}

// Dedupe guard: one keystroke can fire BOTH our keydown shortcut and a native
// 'paste' event. Whichever runs first claims a short window; the other skips, so
// text is queued once. Right-click → Paste and (on macOS) a plain Cmd+V have no
// shortcut of ours behind them, so they claim via the paste event alone.
let _pasteGuardUntil = 0;
function _pasteClaim() {
  const now = performance.now();
  if (now < _pasteGuardUntil) return false;
  _pasteGuardUntil = now + 500;
  return true;
}

if (pasteBtn) pasteBtn.addEventListener('click', _pasteFromClipboard);

// The paste shortcut itself is registered in input.js (see pasteFromShortcut in
// the initInput deps below), alongside every other app shortcut. Plain Ctrl+V is
// deliberately not bound: Ctrl is a real C64 key, and the native `paste` event
// below cannot cover for it either, because the matrix handler consumes that
// keydown before the browser would raise one. Plain Cmd+V needs no binding — the
// matrix router leaves Cmd chords alone, so the browser raises `paste` itself.



document.addEventListener('paste', e => {
  if (!running) return;
  if (isEditableTarget(e.target)) return;
  if (!_pasteClaim()) return;   // already handled by the paste shortcut
  const text = e.clipboardData?.getData('text/plain') || '';
  const queued = queuePastedTextAndReport(text);
  if (queued > 0) {
    e.preventDefault();
  }
});


// Auto-pause the emulator whenever the app leaves the foreground — a tab switch,
// an app switch, window blur, or (crucially on mobile) a screen-lock / standby.
// Browsers signal these differently and NOT always reliably: visibilitychange may
// never fire on a phone standby — a live AudioContext can keep the page "visible" —
// so we ALSO listen for blur, pagehide, and the Page Lifecycle "freeze", and freeze
// on any of them. The symmetric events (focus, visibilitychange→visible, pageshow,
// resume) thaw again.
//
// Freezing (a) sets `paused` so the rAF loop bails — no runFrame, no fresh SID —
// (b) stops the drive-motor sound and (c) suspends the audio context. During an
// active recording, (c) instead gates the recorder tap to silence and leaves the
// source clock running so resumption cannot queue delayed audio. Outside
// recording, suspension still prevents mobile battery drain and a droning voice.
//
// Mirrors the Retro-Vibes busy pattern: only freeze if we were actually running (a manual
// PAUSE / powered-off machine is left alone) and only thaw what we froze. On thaw
// we drop the wall-clock gap (lastTime / timeAccumulator) so the first visible tick
// doesn't burst-run a catch-up of frames.
let _autoPausedByUs = false;

function _autoFreeze() {
  if (shouldMuteOnAutoFreeze({ running })) setMasterMuted(true);
  if (!running || paused) return;      // powered off, or already paused → leave it
  _autoPausedByUs = true;
  paused = true;                       // rafLoop bails → no runFrame, no fresh SID
  _syncPausedClass();
  // Say why the machine stopped (the page may still be visible on blur), but
  // remember what the card said so the thaw can put it back verbatim. The
  // snapshot is assigned AFTER setStatus — any setStatus call clears it, so a
  // status that changes DURING the freeze wins over the stale snapshot.
  const prev = { msg: statusEl.textContent, cls: statusEl.className };
  setStatus('Paused', 'idle');
  _preFreezeStatus = prev;
  if (driveSounds) driveSounds.motorOff();
  suspendAudio();
  updateMediaIndicators(false);        // stop the tape motor-dot pulse (page may still be visible on blur)
  _syncWakeLock();
}

function _autoThaw() {
  if (document.hidden) return;         // not truly foreground yet — wait for it
  const thawed = _autoPausedByUs;
  if (_autoPausedByUs) {
    _autoPausedByUs = false;
    paused = false;
    _syncPausedClass();
    lastTime = 0;                      // drop the away-duration gap …
    timeAccumulator = 0;               // … so the first tick back doesn't burst-catch-up
  }
  // Only touch the status if THIS thaw un-froze the machine — a plain focus
  // event must not overwrite transient statuses (paste feedback, ROM notes).
  // Restore exactly what the card said before the freeze, whatever it was.
  if (thawed && _preFreezeStatus) {
    statusEl.textContent = _preFreezeStatus.msg;
    statusEl.className   = _preFreezeStatus.cls;
    _preFreezeStatus = null;
  }
  if (running && !paused) {
    resumeAudio();                     // best-effort; a suspended ctx may need a tap
    setMasterMuted(audioMuted);        // re-assert the Settings MUTE choice
    // A real freeze/thaw: emulation stopped while this worklet's clock ran on,
    // so re-align it — the offset is under the 0.5 s auto-snap and permanent.
    if (sidNode) sidNode.port.postMessage({ type: 'resync' });
  }
  _syncWakeLock();
}

// Bound to keydown/pointerdown/touchend, so this runs on every keystroke of
// gameplay: do nothing unless something is genuinely suspended or pinned.
function _restoreAudioFromUserGesture() {
  const gainPinned = !audioMuted && !!masterGain && masterGain.gain.value < 0.001;
  if (!needsForegroundAudioRestore({
    running, paused, hidden: document.hidden, ctxState: audioCtx?.state, gainPinned,
  })) return;
  resumeAudio();
  setMasterMuted(audioMuted);
}

// With RUN IN BACKGROUND on, losing focus or being hidden is not a reason to
// stop — only to change what drives the loop. Leaving the page (pagehide) and
// the browser freezing it are, either way.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (runInBackground) _redriveTick(); else _autoFreeze(); }
  else { _redriveTick(); _autoThaw(); }
});
window.addEventListener('blur', () => { if (!runInBackground) _autoFreeze(); });
window.addEventListener('focus', _autoThaw);
window.addEventListener('pagehide', _autoFreeze);
window.addEventListener('pageshow', _autoThaw);
document.addEventListener('freeze', _autoFreeze);   // Page Lifecycle API
document.addEventListener('resume', _autoThaw);     // Page Lifecycle API
document.addEventListener('pointerdown', _restoreAudioFromUserGesture, { capture: true, passive: true });
document.addEventListener('touchend', _restoreAudioFromUserGesture, { capture: true, passive: true });
document.addEventListener('keydown', _restoreAudioFromUserGesture, { capture: true });


// ── Helpers ──────────────────────────────────────────────────────────────────
function setStatus(msg, type = 'idle') {
  statusEl.textContent = msg;
  statusEl.className   = `status status-${type}`;
  _preFreezeStatus = null;   // a fresh status supersedes any pending freeze-restore
}

// Status text with one clickable word. Assembled from nodes, never innerHTML —
// setStatus() is textContent-only because statuses interpolate filenames.
function setStatusAction(before, actionText, after, onClick, type = 'idle') {
  statusEl.textContent = '';
  statusEl.className = `status status-${type}`;
  _preFreezeStatus = null;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'status-link';
  action.textContent = actionText;
  action.addEventListener('click', onClick);
  statusEl.append(before, action, after);
}

// Initial ROM status
updateRomStatus();

// ── PWA: offline install + update prompt ─────────────────────────────────────
// registerSW comes from vite-plugin-pwa. In dev (SW disabled) it's a no-op, so
// importing/calling it is safe. We use the 'prompt' flow: a new deployed build
// waits until the user accepts, rather than swapping code mid-session.
function _pwaToast(message, actionLabel, onAction, autoHideMs, dismissLabel) {
  const el = document.createElement('div');
  el.className = 'pwa-toast';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  // A string action is a URL — a real link, so it can be opened in a new tab or
  // copied. It opens in one either way: the machine is running behind the toast.
  if (actionLabel) {
    const href = typeof onAction === 'string' ? onAction : null;
    const act = document.createElement(href ? 'a' : 'button');
    act.className = 'pwa-toast-action';
    act.textContent = actionLabel;
    if (href) { act.href = href; act.target = '_blank'; act.rel = 'noopener'; }
    act.addEventListener('click', () => { el.remove(); if (!href) onAction?.(); });
    el.appendChild(act);
  }
  // Dismiss control: a labelled button (e.g. "Later…") when dismissLabel is
  // given — a real tap target on mobile and clear on desktop — otherwise the
  // compact ✕ used by the transient info toasts.
  const dismiss = document.createElement('button');
  if (dismissLabel) {
    dismiss.className = 'pwa-toast-later';
    dismiss.textContent = dismissLabel;
  } else {
    dismiss.className = 'pwa-toast-x';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
  }
  dismiss.addEventListener('click', () => el.remove());
  el.appendChild(dismiss);
  document.body.appendChild(el);
  if (autoHideMs) setTimeout(() => el.remove(), autoHideMs);
  return el;
}

// 'prompt' flow: a new deployed build's SW installs and WAITS; we surface a
// persistent "Reload" toast rather than reloading automatically, so we never
// swap code — and lose the running machine — out from under the user mid-session.
const _SW_UPDATE_INTERVAL_MS = 10 * 60 * 1000;   // poll for a new build every 10 min
let _updateToastEl = null;
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // A new build is waiting. Show a persistent toast (no auto-hide) with a
    // Reload action, superseding any earlier one. Reload skip-waits the new SW
    // and reloads (updateSW(true)); "Later…" leaves the current build running —
    // the waiting SW still applies on the next full app restart, and the toast
    // re-appears on the next launch or a newer deploy. The `pwa-toast-update`
    // class enlarges this (persistent) toast vs the transient info toasts.
    _updateToastEl?.remove();
    _updateToastEl = _pwaToast('New version available.', 'Reload', () => updateSW(true), 0, 'Later…');
    _updateToastEl.classList.add('pwa-toast-update');
  },
  onOfflineReady() {
    _pwaToast('Ready to run offline.', null, null, 4000);
  },
  // Check for a new deployed build every 10 minutes AND whenever the app
  // returns to the foreground — background timers are suspended while the PWA
  // sits idle, so the interval alone can miss a deploy. registration.update()
  // re-fetches sw.js; the browser only fires onNeedRefresh when the script
  // actually changed, so an extra check is a no-op otherwise. Skipped while
  // offline. `r` is undefined in dev (SW disabled), so guard for it.
  onRegisteredSW(_swUrl, r) {
    if (!r) return;
    const check = () => { if (navigator.onLine) r.update(); };
    setInterval(check, _SW_UPDATE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  },
});

// After the user-accepted update reload (Reload → updateSW(true) → skipWaiting +
// reload), greet the fresh build with a one-shot toast. The new SW taking
// control fires `controllerchange`; stash a flag (it survives the reload) and
// surface it on the next load. Guard on a pre-existing controller so the FIRST
// install — announced by onOfflineReady above — doesn't masquerade as an update.
if ('serviceWorker' in navigator) {
  const _hadSwController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_hadSwController) sessionStorage.setItem('c64EmulatorUpdated', '1');
  });
  if (sessionStorage.getItem('c64EmulatorUpdated')) {
    sessionStorage.removeItem('c64EmulatorUpdated');
    _pwaToast('Emulator updated. READY.', "What's new", '/docs/whats-new.html', 10000)
      .classList.add('pwa-toast-update');
  }
}

// ── Install card (right column) ──────────────────────────────────────────────
// Two paths:
//   • Chromium/Edge/Android fire `beforeinstallprompt` → show a card with a
//     working "Install app" button that triggers the native prompt.
//   • Safari/Firefox never fire that event → after a short wait we show the
//     same card with browser-specific manual instructions instead.
// Hidden when already installed or previously dismissed (remembered).
let _installPrompt = null;
const _INSTALL_DISMISS_KEY = 'c64emu.installDismissed';

function _isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;   // iOS home-screen app
}

// New-install beacon → Netlify (server-side) analytics, once per installation.
//
// `appinstalled` is not enough on its own: only Chromium fires it, so every Apple
// install ("Add to Home Screen", "Add to Dock") would be invisible. The other
// half is the FIRST launch in standalone mode, which needs no event at all. Both
// call this, and the flag makes whichever comes first the one that counts.
//
// On Chromium the two share a storage partition, so the install-time flag
// suppresses the first-launch ping and an install counts once. On iOS the event
// never fires and the home-screen app has its own partition, so the first launch
// is the one that counts — also once.
//
// What this therefore measures is new installations that get opened (or, on
// Chromium, accepted). Clearing site data resets the flag, so a later launch
// counts again: read the number as "installs seen", not "distinct devices".
const _INSTALL_COUNTED_KEY = 'c64emu.installCounted';

function _countInstallOnce() {
  try {
    if (localStorage.getItem(_INSTALL_COUNTED_KEY) === '1') return;
    localStorage.setItem(_INSTALL_COUNTED_KEY, '1');
  } catch {
    return;              // no storage to dedupe with: skip rather than count every launch
  }
  fetch('/pwa-installed.html', { cache: 'no-store' }).catch(() => {});
}

// Installed-app launch beacon → Netlify (server-side) analytics. When running as
// an installed PWA, ping a tiny network-only marker so the launch is logged under
// Top Pages (installed launches show as /pwa.html; browser visits stay on /).
// Works everywhere incl. iOS (no install events needed — just standalone
// detection). cache:'no-store' + the SW passthrough (sw.js) guarantee it reaches
// Netlify's edge rather than the precache; it fails silently offline. Once per launch.
if (_isInstalled()) {
  fetch('/pwa.html', { cache: 'no-store' }).catch(() => {});
  _countInstallOnce();   // a first standalone launch IS a new install
}

function _installDismissed() {
  try { return localStorage.getItem(_INSTALL_DISMISS_KEY) === '1'; } catch { return false; }
}

function _removeInstallCard() {
  document.querySelector('.pwa-install')?.remove();
}

// Manual-install instructions for browsers that don't support the prompt.
function _manualInstallHint() {
  const ua = navigator.userAgent;
  const iOS = /iphone|ipad|ipod/i.test(ua)
           || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) return 'Tap the Share button, then “Add to Home Screen”.';
  if (/firefox|fxios/i.test(ua)) return 'Open the browser menu, then “Install” — or use Chrome/Edge.';
  // Safari (incl. macOS Sonoma+): Share ▸ Add to Dock.
  if (/^((?!chrome|chromium|android|crios|edg).)*safari/i.test(ua))
    return 'Open Safari’s Share menu, then “Add to Dock”.';
  return 'Use the install icon in the address bar, or your browser’s menu.';
}

// mode: 'prompt' (native install available) | 'manual' (show instructions)
function _showInstallCard(mode) {
  _removeInstallCard();
  const el = document.createElement('div');
  el.className = 'panel-card pwa-install';

  const row = document.createElement('div');
  row.className = 'pwa-install-row';
  const icon = document.createElement('img');
  icon.className = 'pwa-install-icon';
  icon.src = '/icons/icon-192.png';
  icon.alt = '';
  const text = document.createElement('div');
  text.className = 'pwa-install-text';
  const title = document.createElement('strong');
  title.textContent = 'Install C64 READY.';
  const sub = document.createElement('span');
  sub.textContent = mode === 'manual'
    ? _manualInstallHint()
    : 'Play offline, launches like an app.';
  text.append(title, sub);
  row.append(icon, text);
  el.appendChild(row);

  // Only Chromium's prompt path gets a working button.
  if (mode === 'prompt') {
    const install = document.createElement('button');
    install.className = 'pwa-install-btn';
    install.textContent = 'Install app';
    install.addEventListener('click', async () => {
      if (!_installPrompt) { _removeInstallCard(); return; }
      _installPrompt.prompt();
      await _installPrompt.userChoice.catch(() => {});
      _installPrompt = null;            // a prompt can only be used once
      _removeInstallCard();             // 'appinstalled' also fires on accept
    });
    el.appendChild(install);
  }

  const x = document.createElement('button');
  x.className = 'pwa-install-x';
  x.setAttribute('aria-label', 'Dismiss');
  x.textContent = '✕';
  x.addEventListener('click', () => {
    _removeInstallCard();
    try { localStorage.setItem(_INSTALL_DISMISS_KEY, '1'); } catch {}
  });
  el.appendChild(x);

  // Top of the first card column, so it reads as one more card in the stack.
  // Not above .panel-cols: that spans both columns and lands as a full-width
  // block over the panel. It carries no data-panel, so src/panel-order.js does
  // not treat it as arrangeable — dropping a card at the top of that column
  // still lands under it.
  const col = document.querySelector('.panel-col[data-col="0"]');
  const host = col || document.querySelector('.side-panel');
  if (host) host.insertBefore(el, host.firstChild);
  else document.body.appendChild(el);
}

// Chromium path: the prompt may have been captured by the early <head> script
// before this module ran, or arrive later via 'c64-install-available'.
function _maybeShowPromptCard() {
  _installPrompt = window.__c64InstallPrompt || _installPrompt;
  if (!_installPrompt || _isInstalled() || _installDismissed()) return;
  _showInstallCard('prompt');          // upgrades a manual card if one is showing
}
_maybeShowPromptCard();
window.addEventListener('c64-install-available', _maybeShowPromptCard);

// Dev aid, same shape as ?SPLASH: the card needs a browser that is offering an
// install and shows once per browser, which makes it awkward to look at while
// working on the panel. ?INSTALL=1 forces the prompt card, ?INSTALL=manual the
// instructions one, both past the installed / already-dismissed checks. The
// Install button does nothing without a real prompt — it just closes the card.
try {
  const forced = new URLSearchParams(location.search).get('INSTALL');
  if (forced) _showInstallCard(forced === 'manual' ? 'manual' : 'prompt');
} catch {}

window.addEventListener('appinstalled', () => {
  _installPrompt = null;
  _removeInstallCard();
  _countInstallOnce();   // Chromium only, and before the app is ever launched
});

// Fallback path: if no native prompt has arrived shortly after load and the app
// isn't installed/dismissed, show manual instructions (Safari/Firefox, or a
// Chromium that's withholding the prompt). The prompt path replaces this if it
// later fires. While the first-visit splash covers the page, hold the card
// until it's dismissed — one pitch at a time.
function _maybeShowManualCard() {
  if (_isInstalled() || _installDismissed()) return;
  if (_installPrompt || window.__c64InstallPrompt) return;   // prompt path owns it
  if (document.querySelector('.pwa-install')) return;
  _showInstallCard('manual');
}
setTimeout(() => {
  if (splashIsOpen()) {
    window.addEventListener('c64-splash-dismissed',
      () => setTimeout(_maybeShowManualCard, 1500), { once: true });
    return;
  }
  _maybeShowManualCard();
}, 2500);

// ── Wire input.js ────────────────────────────────────────────────────────────
// input.js registered its keyboard/joystick/mouse listeners at import; inject the
// two core hooks it needs — the debug-snapshot download (from media.js) and clearing
// the keyboard paste buffer on focus loss.
initInput({
  cycleCrtEffect: () => _cycleCrtEffect(),
  toggleVibesZoom: () => vibesZoom?.toggle(),
  downloadSnapshot,
  clearPendingPaste: () => { pendingPasteText = ''; },
  // The paste shortcut lives in input.js's registry with the rest, but the
  // clipboard plumbing is here; _pasteClaim keeps it from doubling up with the
  // native `paste` event below when the browser raises both.
  pasteFromShortcut: () => { if (running && _pasteClaim()) _pasteFromClipboard(); },
  // Studio mode strips Retro Vibes to the scene and the logo. From a closed
  // viewer the shortcut opens it straight into Studio mode, which is what someone
  // reaching for it actually wants — one keystroke to a clean frame.
  toggleVibesStudio: async () => {
    const mv = await _ensureModelViewer();
    if (mv.isOpen()) mv.toggleStudio();
    else { mv.open(); mv.setStudio(true); }
  },
});

// ── Wire media.js ────────────────────────────────────────────────────────────
// media.js was evaluated at import (its buttons/listeners are already wired);
// this injects the core lifecycle/audio/pref helpers it calls — now that all are
// defined — and triggers its deferred drive-9 power restore. Small arrows adapt
// core-private state (loop timers, chip-variant prefs, pause flag, auto-load
// sequencer) that media only needs to read or reset.
initMedia({
  setStatus, _powerOn, _hardReset, _createAndWireMachine, _setPaused, startLoop,
  resumeAudio, suspendAudio, resetSidWorklet, _syncPowerStateClass, _punchLogo,
  _syncToggleLabels, _stopBootHint, _queueAutoLoad, _basicReady,
  releaseAllLatched: _releaseAllLatched,
  stopPauseDemo: () => pauseDemo?.stop(),
  cancelAutoLoad: () => { _autoSeq = null; },
  // Save state freezes the machine for as long as its naming dialog is open,
  // while the worklet's clock keeps advancing — the digi-garbling case.
  resyncSid: () => { if (sidNode) sidNode.port.postMessage({ type: 'resync' }); },
  resetFrameTiming: () => {
    lastTime = 0;
    timeAccumulator = 0;
    frameCount = 0;
    frameComputeAccum = 0;
    frameComputeCount = 0;
    lastFpsTime = performance.now();
  },
  applyLoadedVariants: ({ vicVariant, sidIs8580 }) => {
    if (vicVariant) {
      vicVariantPref = vicVariant;
      try { localStorage.setItem('c64emu.vicVariant', vicVariantPref); } catch {}
    }
    if (typeof sidIs8580 === 'boolean') {
      is8580 = sidIs8580;
      sidVariantPref = is8580 ? '8580' : '6581';
      try { localStorage.setItem('c64emu.sidVariant', sidVariantPref); } catch {}
    }
  },
  getIs8580: () => is8580,
  getVicVariantPref: () => vicVariantPref,
  getAutorunEnabled: () => autorunEnabled,
  isPaused: () => paused,
});

// ── Wire recorder.js ─────────────────────────────────────────────────────────
// Screen + audio recorder (RECORD button). Audio is tapped live at record time
// via this accessor, upstream of masterGain so MUTE / RESET never blank it.
initRecorder({
  getAudioGraph: () => ({ audioCtx, sidNode, driveSounds }),
  getCapturePresetId: () => recPreset,
  setStatus,
  restoreAfterCapturePicker: () => _autoThaw(),
  onAudioBridgeClosed: () => {
    if (audioCtx?.state === 'running' && (!running || paused || document.hidden)) {
      audioCtx.suspend().catch(() => {});
    }
  },
});
