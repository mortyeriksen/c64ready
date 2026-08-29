// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Desktop Chromium and Safari. Policy on top of the APIs: Firefox and unknown
// agents stay out even where the APIs exist.
//
// iPadOS defeats the mobile token check (Macintosh UA, no Mobile token) but is
// caught by the capability half of recordingSupported() — it has no
// getDisplayMedia.
export function recordingBrowserSupported(userAgent = globalThis.navigator?.userAgent || '') {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return false;
  if (/Chrome\/|Chromium\//.test(userAgent)) return true;
  // Desktop Safari: "Safari/" without Chrome/Chromium/CriOS (those also say Safari).
  if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS|Edg\/|OPR\//.test(userAgent)) {
    return true;
  }
  return false;
}

export function recordingApisPresent({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderCtor = globalThis.MediaRecorder,
  MediaStreamCtor = globalThis.MediaStream,
} = {}) {
  return typeof mediaDevices?.getDisplayMedia === 'function'
    && typeof MediaRecorderCtor === 'function'
    && typeof MediaStreamCtor === 'function';
}

export function recordingSupported({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderCtor = globalThis.MediaRecorder,
  MediaStreamCtor = globalThis.MediaStream,
  userAgent = globalThis.navigator?.userAgent || '',
} = {}) {
  return recordingApisPresent({ mediaDevices, MediaRecorderCtor, MediaStreamCtor })
    && recordingBrowserSupported(userAgent);
}

// Does stop() have to run the teardown itself?
//
// Normally MediaRecorder.stop() is enough: its onstop runs finish(), which saves
// the file and puts the button back to RECORD. But when the browser ends the
// screen share on its own — Safari does this whenever the page loses focus, e.g.
// to a native file dialog — its recorder may already be INACTIVE by the time we
// react. stop() would then be a no-op, onstop would never fire, and the
// recording would be silently lost with the button stuck on STOP RECORDING.
export function needsDirectFinish(recorderState) {
  return recorderState === 'inactive' || recorderState === undefined || recorderState === null;
}

// Capture ceilings offered in Options ▸ Recorder. Both dimensions are a MAXIMUM,
// so the browser scales the surface to fit inside the box keeping its aspect ratio
// (no cropping) and leaves anything smaller alone. NATIVE records the shared
// surface at its own size, which on a HiDPI display means 3456x2234 and ~2 MB/s of
// H.264 for a window showing a 320x200 picture.
export const CAPTURE_PRESETS = [
  { id: '720p',   label: '720p',   width: 1280, height: 720 },
  { id: '1080p',  label: '1080p',  width: 1920, height: 1080 },
  { id: '1440p',  label: '1440p',  width: 2560, height: 1440 },
  { id: '4k',     label: '4K',     width: 3840, height: 2160 },
  { id: 'native', label: 'NATIVE', width: 0,    height: 0    },
];

export const DEFAULT_CAPTURE_PRESET = '1080p';

export function capturePreset(id) {
  return CAPTURE_PRESETS.find(p => p.id === id)
    || CAPTURE_PRESETS.find(p => p.id === DEFAULT_CAPTURE_PRESET);
}

export function nextCapturePreset(id) {
  const i = CAPTURE_PRESETS.findIndex(p => p.id === id);
  return CAPTURE_PRESETS[(i < 0 ? 0 : i + 1) % CAPTURE_PRESETS.length].id;
}

// Four outcomes: share lost or not, crossed with data or none. A stop with no
// data is a FAILURE, not a cancellation — calling it one hides a lost take behind
// a message that sounds like the user's own choice.
export function recordingEndStatus({ lost, hasData }) {
  if (lost) {
    return hasData
      ? { message: 'Screen sharing ended — saving the recording so far…', tone: 'idle' }
      : { message: 'Screen sharing ended before anything was recorded', tone: 'error' };
  }
  return hasData
    ? { message: 'Saving recording…', tone: 'idle' }
    : { message: 'Recording failed — the browser returned no video data', tone: 'error' };
}
