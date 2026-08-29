// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/recorder.js — Screen + audio recorder for the RECORD button.
//
// Video: navigator.mediaDevices.getDisplayMedia captures whatever surface the
// user shares (whole browser window / screen / tab). Because it records the
// composited output rather than a specific canvas, it captures fullscreen and
// the Retro Vibes 3D overlay for free, with no per-mode source switching. The
// captured frame is capped at the Options ▸ Recorder resolution (1080p by
// default); see CAPTURE_PRESETS in recording-support.js.
//
// Audio: rather than the flaky screen-capture audio path, we tap the emulator's
// own Web Audio graph. The tap sits UPSTREAM of masterGain, then crosses a
// MediaStream bridge into a recorder-owned AudioContext. That second context
// keeps media time advancing independently. While recording, app pauses gate
// the tap to silence but leave its source context clock running, avoiding a
// cross-context queue offset when the app resumes.
//
// The two tracks are muxed into one MediaStream and recorded by MediaRecorder.
// Capability detection admits browsers that provide display capture and media
// recording. The button stays visible elsewhere, where a click explains which
// browser APIs are missing.

import { confirmDialog } from './dialogs.js';
import { createRecorderAudioBridge } from './recorder-audio-bridge.js';
import { remuxFragmentedMp4 } from './mp4-remux.js';
import { needsDirectFinish, recordingEndStatus } from './recording-support.js';
import { capturePreset, DEFAULT_CAPTURE_PRESET } from './recording-support.js';
import { recordingSupported } from './recording-support.js';

// Preferred container/codec, most specific first. Baseline H.264 (42E01E) is
// the most broadly playable; the plain entries are fallbacks. An empty result
// lets the browser choose (WebM), and the file extension follows suit.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

// Capture ceiling, chosen in Options ▸ Recorder. See CAPTURE_PRESETS.
let getCapturePresetId = () => DEFAULT_CAPTURE_PRESET;

// Keep the timeslice. Without one the only dataavailable is the one stop()
// produces, i.e. the whole take in a single event — which Safari does not
// reliably deliver, losing the file. Fragmented MP4 concatenates fine.
const TIMESLICE_MS = 1000;

let btn = null;
let getAudioGraph = () => ({});
let setStatus = () => {};
let restoreAfterCapturePicker = () => {};
let onAudioBridgeClosed = () => {};

let recorder = null;        // MediaRecorder
let chunks = [];            // recorded Blob parts
let displayStream = null;   // getDisplayMedia video stream
let captureLost = false;    // the browser ended the share; we didn't press stop
let finishing = false;      // in-flight finish() guard
let finished = false;       // this take already torn down (watchdog-safe)
let stopWatchdog = null;    // Safari: onstop may never fire after track death
let stopWaits = 0;          // watchdog rounds spent waiting for the first bytes
let captureWatch = null;    // focus/visibility re-check while a take is live
let audioBridge = null;     // recorder-owned clock fed from the emulator graph
let recording = false;
let starting = false;

function pickMime() {
  if (!window.MediaRecorder) return '';
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function supported() {
  return recordingSupported();
}

function showUnsupported() {
  confirmDialog(
    'Recording works in desktop Chrome (and other Chromium browsers) and desktop '
    + 'Safari. Other browsers are excluded on purpose: they either lack the '
    + 'screen-capture and media-recording APIs, or produce a file this app cannot '
    + 'vouch for.',
    { title: 'Recording is not supported here', okLabel: 'OK', okOnly: true },
  );
}

// Local timestamp as YYYY-MM-DD_HH-MM-SS for the download filename.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function setButtonState(isRec) {
  if (!btn) return;
  btn.classList.toggle('is-recording', isRec);
  // Static markup (no user input) — the leading glyph is a red-dotted span idle,
  // a stop icon while recording.
  btn.innerHTML = isRec
    ? '<span class="rec-dot" aria-hidden="true">⏹</span> STOP RECORDING'
    : '<span class="rec-dot" aria-hidden="true">●</span> RECORD';
  btn.title = isRec
    ? 'Stop recording and save the .mp4 file'
    : 'Record the browser window with sound to an .mp4 file';
}

// Fan out SID + drive sounds into a recorder-clocked media stream. This runs
// synchronously in the RECORD click before the share picker can blur/freeze the
// emulator, so the browser grants and starts the recorder AudioContext on the gesture.
function attachAudio() {
  const { audioCtx, sidNode, driveSounds } = getAudioGraph();
  audioBridge = createRecorderAudioBridge({ audioCtx, sidNode, driveSounds });
  return audioBridge?.track || null;
}

function detachAudio() {
  audioBridge?.close();
  audioBridge = null;
  try { onAudioBridgeClosed(); } catch {}
}

export function recorderAudioClockActive() {
  return !!audioBridge && (starting || recording);
}

export function setRecorderAudioPaused(paused) {
  audioBridge?.setSourceMuted(paused);
}

// Not every browser applies size constraints to a display-capture track at
// getDisplayMedia() time — Safari hands back the surface's native size. Re-apply
// the ceiling on the live track for those, and skip the call when the track is
// already inside it so a browser that rejects constraints on screen capture is
// never asked. Failure is non-fatal: the capture just stays at native size.
async function capAtDisplayResolution(videoTrack, cap) {
  if (!cap.width || typeof videoTrack.applyConstraints !== 'function') return;
  const { width = 0, height = 0 } = videoTrack.getSettings?.() || {};
  if (width <= cap.width && height <= cap.height) return;
  try {
    await videoTrack.applyConstraints({
      width: { max: cap.width },
      height: { max: cap.height },
    });
  } catch {
    // Constraint unsupported for this source; record the surface as offered.
  }
}

// getDisplayMedia() may resolve before the browser has delivered the capture track's
// first frame. Starting MediaRecorder in that gap lets audio begin against a
// frozen/empty video timeline. Prime the track through a muted preview and wait
// for one presented frame; the timeout keeps an unusual capture source from
// blocking RECORD forever.
async function waitForFirstVideoFrame(stream, timeoutMs = 3000) {
  const preview = document.createElement('video');
  preview.muted = true;
  preview.playsInline = true;
  preview.srcObject = stream;

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const firstFrame = (async () => {
    await preview.play();
    if (typeof preview.requestVideoFrameCallback === 'function') {
      await new Promise((resolve) => preview.requestVideoFrameCallback(() => resolve()));
    }
  })();

  try {
    await Promise.race([firstFrame, timeout]);
  } catch {
    // The display track is still handed to MediaRecorder; this is only a
    // readiness guard, not a reason to discard an otherwise valid capture.
  } finally {
    if (timer) clearTimeout(timer);
    try { preview.pause(); } catch {}
    preview.srcObject = null;
  }
}

// Breaks the deadlock when stop() produces no onstop, which would otherwise leave
// the button on STOP RECORDING forever.
const STOP_TIMEOUT_MS = 3000;
// With nothing received at all, wait again rather than finish: finishing would
// discard the take. Bounded so a dead encoder can't hang it forever.
const MAX_STOP_WAITS = 3;

function clearStopWatchdog() {
  if (stopWatchdog != null) {
    clearTimeout(stopWatchdog);
    stopWatchdog = null;
  }
}

function armStopWatchdog() {
  clearStopWatchdog();
  stopWatchdog = setTimeout(() => {
    stopWatchdog = null;
    if (finished) return;
    const encoderAlive = recorder && !needsDirectFinish(recorder.state);
    if (!chunks.length && encoderAlive && stopWaits < MAX_STOP_WAITS) {
      stopWaits++;
      armStopWatchdog();
      return;
    }
    finish();
  }, STOP_TIMEOUT_MS);
}

function captureStillLive() {
  const track = displayStream?.getVideoTracks?.()[0];
  if (!track || track.readyState === 'ended') return false;
  if (recorder && needsDirectFinish(recorder.state)) return false;
  return true;
}

// Safari often ends the share on focus loss (file dialog) without a reliable
// track 'ended' → onstop chain until focus returns — or never. Re-check on
// focus / visibility so the button and status cannot stay stuck.
function onCaptureFocusCheck() {
  if (!recording || finished || finishing) return;
  if (captureStillLive()) return;
  captureLost = true;
  stop();
}

function armCaptureWatch() {
  disarmCaptureWatch();
  captureWatch = onCaptureFocusCheck;
  window.addEventListener('focus', captureWatch);
  document.addEventListener('visibilitychange', captureWatch);
}

function disarmCaptureWatch() {
  if (!captureWatch) return;
  window.removeEventListener('focus', captureWatch);
  document.removeEventListener('visibilitychange', captureWatch);
  captureWatch = null;
}

async function start() {
  if (starting || recording) return;
  starting = true;
  finished = false;
  captureLost = false;
  clearStopWatchdog();
  // Must precede the first await: construction stays inside the RECORD gesture.
  const audioTrack = attachAudio();
  const cap = capturePreset(getCapturePresetId());
  let stream;
  try {
    // audio:false — the recorder-clocked emulator graph is the audio source.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 60,
        ...(cap.width ? { width: { max: cap.width }, height: { max: cap.height } } : {}),
      },
      audio: false,
    });
  } catch {
    detachAudio();
    starting = false;
    return; // user dismissed the share picker, or capture is unavailable
  }
  displayStream = stream;
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    for (const track of stream.getTracks()) { try { track.stop(); } catch {} }
    displayStream = null;
    detachAudio();
    starting = false;
    return;
  }
  await capAtDisplayResolution(videoTrack, cap);

  // The share picker can blur the page. The app's foreground lifecycle
  // consequently pauses emulation and suspends its AudioContext while the
  // recorder-owned context keeps advancing. Thaw the app and wait for the
  // source context before priming video or starting MediaRecorder, otherwise
  // the cross-context stream can begin with a fixed audio-content offset.
  try { await restoreAfterCapturePicker(); } catch {}
  try { await audioBridge?.resumeSource(); } catch {}
  await waitForFirstVideoFrame(stream);
  try { await audioBridge?.resume(); } catch {}
  const combined = new MediaStream();
  combined.addTrack(videoTrack);
  if (audioTrack) combined.addTrack(audioTrack);

  const mimeType = pickMime();
  try {
    recorder = new MediaRecorder(combined, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 12_000_000,
    });
  } catch {
    recorder = new MediaRecorder(combined); // fall back to browser defaults
  }

  chunks = [];
  // A finished take's MediaRecorder stays alive in these closures and can still
  // deliver events. Ungated, its late blob lands in the NEXT take's chunks and its
  // onstop tears that take down mid-record — hence `recorder === myRec` below.
  const myRec = recorder;
  recorder.ondataavailable = (ev) => {
    if (recorder !== myRec) return;
    if (ev.data && ev.data.size) chunks.push(ev.data);
  };
  recorder.onstop = () => {
    if (recorder !== myRec) return;
    clearStopWatchdog();
    finish();
  };
  recorder.onerror = () => {
    // Encoder failure: still tear down so the button cannot stick.
    if (recorder !== myRec) return;
    captureLost = true;
    clearStopWatchdog();
    finish();
  };

  // "Stop sharing" in the browser chrome, or Safari ending the capture on
  // focus loss (file dialog, etc.), ends the track. Mark captureLost so status
  // explains it, then stop() — which always reaches finish() even when Safari
  // never fires MediaRecorder.onstop.
  videoTrack.addEventListener('ended', () => {
    if (!recording || finished) return;
    captureLost = true;
    stop();
  });

  recorder.start(TIMESLICE_MS);   // pieces as we go, not one blob at stop
  recording = true;
  starting = false;
  stopWaits = 0;
  setButtonState(true);
  setStatus('Recording…', 'running');
  armCaptureWatch();
}

function stop() {
  if (finished || finishing) return;
  if (!recording && !recorder) return;

  // Prefer stop() → onstop → finish(). A dead share leaves Safari either
  // "inactive" (needsDirectFinish) or "recording" with no onstop ever, so the
  // direct finish below and the watchdog have to cover both.
  //
  // Do NOT add requestData() here: flushing immediately before stop() is the
  // sequence WebKit mishandles, and it loses the take.
  if (recorder && !needsDirectFinish(recorder.state)) {
    try {
      recorder.stop();
      stopWaits = 0;
      armStopWatchdog();
      return;
    } catch { /* fall through and finish here */ }
  }
  clearStopWatchdog();
  finish();
}

// Tear down taps, stop screen capture, save the file. Idempotent: track-ended,
// onstop, onerror, and the stop() watchdog may all race here.
function finish() {
  if (finished || finishing) return;
  finishing = true;
  finished = true;
  clearStopWatchdog();
  disarmCaptureWatch();
  const lost = captureLost;
  captureLost = false;
  recording = false;
  starting = false;
  setButtonState(false);
  detachAudio();
  if (displayStream) {
    for (const t of displayStream.getTracks()) { try { t.stop(); } catch {} }
    displayStream = null;
  }

  const type = (recorder && recorder.mimeType) || 'video/mp4';
  const endState = recorder && recorder.state;
  recorder = null;              // also retires this take's handler token
  finishing = false;
  const { message, tone } = recordingEndStatus({ lost, hasData: chunks.length > 0 });
  setStatus(message, tone);
  if (!chunks.length) {
    // Should be unreachable now that data arrives every TIMESLICE_MS. If it ever
    // fires, these are the values that identify which delivery path broke.
    console.warn('[recorder] no data delivered — nothing to save '
      + `(lost=${lost} endState=${endState} stopWaits=${stopWaits})`);
    return;
  }

  const ext = type.includes('webm') ? 'webm' : 'mp4';
  const blob = new Blob(chunks, { type });
  chunks = [];

  // MediaRecorder hands back a FRAGMENTED MP4, which has no sample tables.
  // Players that rebuild a track's timeline from the fragments then get the
  // video short — its durations don't cover capture stalls, while audio is
  // continuous — so sound drifts from picture by ~0.5 s even though every
  // timestamp is right. Editors that want an index (QuickTime) also refuse to
  // trim it. Rewriting it as a progressive, indexed MP4 fixes both.
  if (ext === 'mp4') {
    remuxToProgressive(blob, type).then(finalBlob => download(finalBlob, ext));
    return;
  }
  download(blob, ext);
}

// Best-effort: any failure ships the original recording rather than none.
//
// The recording is never pulled into memory. remuxFragmentedMp4 reads only the
// metadata boxes off the blob and hands back a plan: literal header bytes plus
// ranges of the source. Mapping those ranges to blob.slice() parts builds the
// output by REFERENCE — Blob parts may be Blobs, and a slice points into the
// parent's storage rather than copying it — so a take of any length costs the
// same few MB here, and the download streams from that storage as before.
async function remuxToProgressive(blob, type) {
  try {
    const t0 = performance.now();
    const res = await remuxFragmentedMp4(blob);
    if (!res) return blob;                     // already progressive
    const parts = res.parts.map(p => (p instanceof Uint8Array
      ? p
      : blob.slice(p.offset, p.offset + p.size)));
    const stalls = res.stats.repairedSeconds
      .map(r => `trk${r.trackId} +${r.seconds.toFixed(3)}s`).join(' ');
    // Remux diagnostics: sample/fragment counts and how much metadata the index
    // pass had to read. Worth having when a recording comes out wrong, noise on
    // every ordinary save — so opt in with `c64Trace.recorderDiag = true`, the
    // same idiom the SID cycle-sync logging uses.
    if (window.c64Trace?.recorderDiag) {
      console.log(`[recorder] indexed ${res.stats.samples} samples from ` +
                  `${res.stats.fragments} fragments in ${Math.round(performance.now() - t0)} ms; ` +
                  `read ${(res.stats.metadataBytes / 1e6).toFixed(1)} MB of metadata in ` +
                  `${res.stats.sourceReads} reads, ${res.stats.ranges} ranges` +
                  (stalls ? `; recovered stalls ${stalls}` : ''));
    }
    return new Blob(parts, { type });
  } catch (err) {
    console.warn('[recorder] remux failed; saving the original recording:', err);
    return blob;
  }
}

function download(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `c64ready-${stamp()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  setStatus(`Recording saved as ${a.download}`, 'running');
}

export function initRecorder(opts = {}) {
  getAudioGraph = opts.getAudioGraph || (() => ({}));
  setStatus = opts.setStatus || (() => {});
  restoreAfterCapturePicker = opts.restoreAfterCapturePicker || (() => {});
  onAudioBridgeClosed = opts.onAudioBridgeClosed || (() => {});
  getCapturePresetId = opts.getCapturePresetId || (() => DEFAULT_CAPTURE_PRESET);
  btn = document.getElementById('btn-record');
  if (!btn) return;

  // The button stays visible everywhere so the feature is discoverable; a click
  // in an unsupported browser explains the required APIs instead of recording.
  setButtonState(false);
  btn.addEventListener('click', () => {
    if (recording) { stop(); return; }
    if (!supported()) { showUnsupported(); return; }
    start();
  });
}
