// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Keep recorder audio on a clock that is independent of emulator suspension.

function stopStream(stream) {
  if (!stream?.getTracks) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

export function createRecorderAudioBridge({
  audioCtx,
  sidNode,
  driveSounds,
  AudioContextCtor = globalThis.AudioContext,
} = {}) {
  if (!audioCtx || audioCtx.state === 'closed' || !AudioContextCtor) return null;

  const sourceDest = audioCtx.createMediaStreamDestination();
  const sourceGate = audioCtx.createGain();
  const sourceWasRunning = audioCtx.state === 'running';
  const tappedNodes = [];
  let recorderCtx = null;
  let recorderSource = null;
  let recorderDest = null;
  let closed = false;

  const disconnectSources = () => {
    for (const node of tappedNodes) {
      try { node.disconnect(sourceGate); } catch { /* not connected */ }
    }
    tappedNodes.length = 0;
    try { sourceGate.disconnect(sourceDest); } catch { /* not connected */ }
  };

  try {
    sourceGate.connect(sourceDest);
    if (sidNode) {
      sidNode.connect(sourceGate);
      tappedNodes.push(sidNode);
    }
    if (driveSounds?.master) {
      driveSounds.master.connect(sourceGate);
      tappedNodes.push(driveSounds.master);
    }

    // Bridge the emulator tap through a recorder-owned clock. App lifecycle
    // pauses gate sourceGate to silence while leaving both contexts running;
    // this context also keeps MediaRecorder independent of the live output.
    recorderCtx = new AudioContextCtor({ sampleRate: audioCtx.sampleRate });
    recorderSource = recorderCtx.createMediaStreamSource(sourceDest.stream);
    recorderDest = recorderCtx.createMediaStreamDestination();
    recorderSource.connect(recorderDest);

    const track = recorderDest.stream.getAudioTracks()[0];
    if (!track) throw new Error('Recorder audio bridge produced no audio track');

    return {
      track,
      context: recorderCtx,
      setSourceMuted(muted) {
        if (closed) return;
        const now = audioCtx.currentTime;
        try { sourceGate.gain.cancelScheduledValues(now); } catch {}
        sourceGate.gain.setValueAtTime(muted ? 0 : 1, now);
      },
      resumeSource() {
        // The display-share picker blurs the app, which auto-suspends a context
        // that was running when RECORD was pressed. Restore only that transient
        // suspension; a context already paused by the user stays paused.
        if (sourceWasRunning && audioCtx.state === 'suspended'
          && typeof audioCtx.resume === 'function') return audioCtx.resume();
        return Promise.resolve();
      },
      resume() {
        if (recorderCtx?.state === 'suspended') return recorderCtx.resume();
        return Promise.resolve();
      },
      close() {
        if (closed) return;
        closed = true;
        disconnectSources();
        try { recorderSource?.disconnect(recorderDest); } catch { /* not connected */ }
        stopStream(recorderDest?.stream);
        stopStream(sourceDest.stream);
        if (recorderCtx && recorderCtx.state !== 'closed') {
          try {
            const closing = recorderCtx.close();
            if (closing?.catch) closing.catch(() => {});
          } catch { /* already closing */ }
        }
        recorderSource = null;
        recorderDest = null;
        recorderCtx = null;
      },
    };
  } catch {
    disconnectSources();
    try { recorderSource?.disconnect(recorderDest); } catch { /* not connected */ }
    stopStream(recorderDest?.stream);
    stopStream(sourceDest.stream);
    if (recorderCtx && recorderCtx.state !== 'closed') {
      try {
        const closing = recorderCtx.close();
        if (closing?.catch) closing.catch(() => {});
      } catch { /* already closing */ }
    }
    return null;
  }
}
