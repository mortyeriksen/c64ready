import assert from 'node:assert/strict';
import {
  recordingSupported, recordingBrowserSupported, needsDirectFinish, recordingEndStatus,
  CAPTURE_PRESETS, DEFAULT_CAPTURE_PRESET, capturePreset, nextCapturePreset,
} from '../src/recording-support.js';

const getDisplayMedia = () => {};
class MediaRecorder {}
class MediaStream {}

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0';
const EDGE = CHROME + ' Edg/140.0.0.0';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

assert.equal(recordingSupported({
  mediaDevices: { getDisplayMedia },
  MediaRecorderCtor: MediaRecorder,
  MediaStreamCtor: MediaStream,
  userAgent: CHROME,
}), true, 'Chromium with the APIs present is supported');

assert.equal(recordingSupported({
  mediaDevices: {},
  MediaRecorderCtor: MediaRecorder,
  MediaStreamCtor: MediaStream,
  userAgent: CHROME,
}), false, 'recording requires display capture');

assert.equal(recordingSupported({
  mediaDevices: { getDisplayMedia },
  MediaRecorderCtor: undefined,
  MediaStreamCtor: MediaStream,
  userAgent: CHROME,
}), false, 'recording requires MediaRecorder');

assert.equal(recordingSupported({
  mediaDevices: { getDisplayMedia },
  MediaRecorderCtor: MediaRecorder,
  MediaStreamCtor: undefined,
  userAgent: CHROME,
}), false, 'recording requires MediaStream composition');

console.log('ok  - recorder support is detected from browser capabilities');

// A browser that ends the screen share by itself may leave its MediaRecorder
// already inactive — Safari does this on focus loss, e.g. to a native file
// dialog. stop() must then run the teardown directly, or the recording is lost
// and the button stays stuck on STOP RECORDING.
assert.equal(needsDirectFinish('inactive'), true, 'an already-inactive recorder needs a direct finish');
assert.equal(needsDirectFinish(undefined), true, 'a missing recorder needs a direct finish');
assert.equal(needsDirectFinish(null), true, 'a null state needs a direct finish');
assert.equal(needsDirectFinish('recording'), false, 'a live recorder stops through MediaRecorder');
assert.equal(needsDirectFinish('paused'), false, 'a paused recorder stops through MediaRecorder');
console.log('ok  - capture-loss teardown decision');

// A user-pressed stop that yields no data is a FAILURE, not a cancellation.
// Safari returned no blob at all and the old wording ("Recording cancelled")
// made a lost take read as something the user had chosen.
{
  const userStop = recordingEndStatus({ lost: false, hasData: false });
  assert.equal(userStop.tone, 'error', 'a stop with no data is reported as an error');
  assert.ok(!/cancel/i.test(userStop.message),
    `a stop with no data must not read as a cancellation (got "${userStop.message}")`);

  const userStopOk = recordingEndStatus({ lost: false, hasData: true });
  assert.equal(userStopOk.tone, 'idle', 'a normal stop with data is not an error');
  assert.ok(/saving/i.test(userStopOk.message), 'a normal stop says it is saving');

  const lostOk = recordingEndStatus({ lost: true, hasData: true });
  assert.equal(lostOk.tone, 'idle', 'a lost share with data still saves');
  assert.ok(/sharing ended/i.test(lostOk.message) && /saving/i.test(lostOk.message),
    'a lost share with data explains itself and says it is saving');

  const lostEmpty = recordingEndStatus({ lost: true, hasData: false });
  assert.equal(lostEmpty.tone, 'error', 'a lost share with no data is an error');
  assert.ok(/sharing ended/i.test(lostEmpty.message),
    'a lost share with no data blames the share, not the user');

  // All four outcomes must be distinguishable, or the message cannot be acted on.
  const all = [userStop, userStopOk, lostOk, lostEmpty].map(s => s.message);
  assert.equal(new Set(all).size, 4, 'each outcome has its own message');
  console.log('ok  - end-of-take status distinguishes all four outcomes');
}

{
  assert.equal(recordingBrowserSupported(CHROME), true, 'Chrome is allowed');
  assert.equal(recordingBrowserSupported(EDGE), true, 'Chromium forks are allowed');
  assert.equal(recordingBrowserSupported(SAFARI), true, 'desktop Safari is allowed');
  assert.equal(recordingBrowserSupported(FIREFOX), false, 'Firefox is gated out');
  assert.equal(recordingBrowserSupported(IOS_SAFARI), false, 'mobile Safari is gated out');
  assert.equal(recordingBrowserSupported(''), false, 'an unknown agent is gated out');
  const apis = { mediaDevices: { getDisplayMedia }, MediaRecorderCtor: function () {}, MediaStreamCtor: function () {} };
  assert.equal(recordingSupported({ ...apis, userAgent: SAFARI }), true,
    'Safari with the APIs present is supported');
  assert.equal(recordingSupported({ ...apis, userAgent: CHROME }), true,
    'Chrome with the APIs present is supported');
  console.log('ok  - recording admits desktop Chrome and Safari');
}

// The RECORDER size toggle: a preset is looked up by id, an unknown or missing id
// falls back to the default, and the toggle walks the list and wraps.
{
  assert.equal(capturePreset('720p').width, 1280, 'a known preset is found by id');
  assert.equal(capturePreset('nonsense').id, DEFAULT_CAPTURE_PRESET, 'an unknown id falls back to the default');
  assert.equal(capturePreset(undefined).id, DEFAULT_CAPTURE_PRESET, 'no id at all falls back to the default');
  assert.equal(capturePreset('native').width, 0, 'NATIVE carries no fixed size');
  const ids = CAPTURE_PRESETS.map(p => p.id);
  const walked = [];
  let id = ids[0];
  for (let i = 0; i < ids.length; i++) { walked.push(id); id = nextCapturePreset(id); }
  assert.deepEqual(walked, ids, 'the toggle visits every preset in order');
  assert.equal(id, ids[0], 'and wraps to the first');
  assert.equal(nextCapturePreset('nonsense'), ids[0], 'an unknown id starts over from the first');
  console.log('ok  - capture presets resolve and cycle');
}
