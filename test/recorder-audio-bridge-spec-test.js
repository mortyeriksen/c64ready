import assert from 'node:assert/strict';
import { createRecorderAudioBridge } from '../src/recorder-audio-bridge.js';

function track(name) {
  return { name, stopped: false, stop() { this.stopped = true; } };
}

function stream(name) {
  const audioTrack = track(name);
  return {
    audioTrack,
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack],
  };
}

function destination(name) {
  return { name, stream: stream(name) };
}

const upstreamDest = destination('upstream');
const recorderDest = destination('recorder');
const sidConnections = [];
const driveConnections = [];
const sourceConnections = [];
let sourceInput = null;
let recorderOptions = null;
let recorderClosed = 0;
let sourceResumed = 0;
const gainEvents = [];
const markerConnections = [];
const createdGains = [];

const audioCtx = {
  state: 'running',
  sampleRate: 44100,
  currentTime: 12.5,
  resume() {
    this.state = 'running';
    sourceResumed++;
    return Promise.resolve();
  },
  createMediaStreamDestination: () => upstreamDest,
  createGain: () => {
    const node = {
      gain: {
        cancelScheduledValues: (time) => gainEvents.push(['cancel', time]),
        setValueAtTime: (value, time) => gainEvents.push(['set', value, time]),
        linearRampToValueAtTime: (value, time) => gainEvents.push(['ramp', value, time]),
      },
      connect: (target) => markerConnections.push(['gain', target]),
      disconnect: () => {},
    };
    createdGains.push(node);
    return node;
  },
};
const sidNode = {
  connect: (node) => sidConnections.push(node),
  disconnect: (node) => assert.equal(node, createdGains[0]),
};
const driveMaster = {
  connect: (node) => driveConnections.push(node),
  disconnect: (node) => assert.equal(node, createdGains[0]),
};
class RecorderContext {
  constructor(options) {
    recorderOptions = options;
    this.state = 'running';
  }
  createMediaStreamSource(input) {
    sourceInput = input;
    return {
      connect: (node) => sourceConnections.push(node),
      disconnect: (node) => assert.equal(node, recorderDest),
    };
  }
  createMediaStreamDestination() { return recorderDest; }
  close() {
    this.state = 'closed';
    recorderClosed++;
    return Promise.resolve();
  }
}

const bridge = createRecorderAudioBridge({
  audioCtx,
  sidNode,
  driveSounds: { master: driveMaster },
  AudioContextCtor: RecorderContext,
});

assert.ok(bridge, 'bridge is created for a live emulator AudioContext');
assert.equal(bridge.track, recorderDest.stream.audioTrack,
  'MediaRecorder receives the recorder-context track, not the suspendable upstream track');
assert.deepEqual(recorderOptions, { sampleRate: 44100 },
  'recorder context uses the emulator sample rate');
assert.equal(sourceInput, upstreamDest.stream,
  'recorder context consumes the emulator tap as a MediaStream');
assert.deepEqual(sidConnections, [createdGains[0]], 'SID feeds the recorder source gate');
assert.deepEqual(driveConnections, [createdGains[0]], 'drive sounds feed the recorder source gate');
assert.deepEqual(sourceConnections, [recorderDest], 'bridge source feeds the recorder destination');

bridge.setSourceMuted(true);
bridge.setSourceMuted(false);
assert.deepEqual(gainEvents.slice(-4), [
  ['cancel', 12.5], ['set', 0, 12.5],
  ['cancel', 12.5], ['set', 1, 12.5],
], 'recorder source gate writes silence without suspending its clock');

audioCtx.state = 'suspended';
await bridge.resumeSource();
assert.equal(sourceResumed, 1,
  'a source running before the share picker is resumed before recording starts');

bridge.close();
bridge.close();
assert.equal(upstreamDest.stream.audioTrack.stopped, true, 'upstream bridge track stops on close');
assert.equal(recorderDest.stream.audioTrack.stopped, true, 'recorder track stops on close');
assert.equal(recorderClosed, 1, 'recorder AudioContext closes exactly once');

assert.equal(createRecorderAudioBridge({ audioCtx: { state: 'closed' } }), null,
  'closed emulator AudioContext produces no bridge');

const pausedCtx = {
  state: 'suspended',
  sampleRate: 44100,
  createMediaStreamDestination: () => destination('paused-upstream'),
  createGain: audioCtx.createGain,
  resume: () => { throw new Error('a user-paused source must not resume'); },
};
const pausedBridge = createRecorderAudioBridge({
  audioCtx: pausedCtx,
  AudioContextCtor: RecorderContext,
});
await pausedBridge.resumeSource();
pausedBridge.close();

console.log('ok  - recorder audio uses an independent clock and tears down cleanly');

// The recorder's own clock is resumed only when it is the one suspended; a
// running clock is left alone.
{
  let resumed = 0;
  class SuspendedRecorder extends RecorderContext {
    constructor(options) { super(options); this.state = 'suspended'; }
    resume() { resumed++; this.state = 'running'; return Promise.resolve(); }
  }
  const ctx = {
    state: 'running', sampleRate: 48000,
    createMediaStreamDestination: () => destination('fresh-upstream'),
    createGain: audioCtx.createGain,
  };
  const b = createRecorderAudioBridge({ audioCtx: ctx, AudioContextCtor: SuspendedRecorder });
  assert.ok(b, 'a bridge is built on a suspended recorder context');
  await b.resume();
  assert.equal(resumed, 1, 'resume() wakes the recorder clock');
  await b.resume();
  assert.equal(resumed, 1, 'a running recorder clock is not resumed again');
  b.close();
  console.log('ok  - the recorder clock resumes only when suspended');
}

// When the recorder context cannot be built, nothing is left connected: the taps
// are undone, the upstream track stopped, and a half-built context closed.
{
  let sidDisconnects = 0, trackStops = 0, closed = 0;
  const upstream = destination('doomed-upstream');
  upstream.stream.audioTrack.stop = () => trackStops++;
  const ctx = {
    state: 'running', sampleRate: 48000,
    createMediaStreamDestination: () => upstream,
    createGain: audioCtx.createGain,
  };
  const sid = { connect() {}, disconnect() { sidDisconnects++; } };
  class Broken { constructor() { throw new Error('no audio here'); } }
  assert.equal(createRecorderAudioBridge({ audioCtx: ctx, sidNode: sid, AudioContextCtor: Broken }), null,
    'a recorder context that cannot be built yields no bridge');
  assert.equal(sidDisconnects, 1, 'the SID tap is undone');
  assert.equal(trackStops, 1, 'the upstream track is stopped');

  class NoTrack {
    constructor() { this.state = 'running'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [], getTracks: () => [] } }; }
    close() { this.state = 'closed'; closed++; return Promise.resolve(); }
  }
  assert.equal(createRecorderAudioBridge({ audioCtx: ctx, AudioContextCtor: NoTrack }), null,
    'a recorder context with no audio track yields no bridge');
  assert.equal(closed, 1, 'and the half-built recorder context is closed');
  assert.equal(trackStops, 2, 'with the upstream track stopped again');
  console.log('ok  - a failed bridge leaves nothing connected');
}
