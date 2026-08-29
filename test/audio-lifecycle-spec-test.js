import { shouldMuteOnAutoFreeze, shouldRestoreForegroundAudio, needsForegroundAudioRestore } from '../src/audio-lifecycle.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

expect(
  shouldMuteOnAutoFreeze({ running: true }) === true,
  'auto-freeze mutes the master gain while the emulator is powered on',
);
expect(
  shouldMuteOnAutoFreeze({ running: false }) === false,
  'auto-freeze must not pin the master gain while powered off',
);

expect(
  shouldRestoreForegroundAudio({ running: true, paused: false, hidden: false }) === true,
  'foreground user gesture restores audio for a visible running machine',
);
expect(
  shouldRestoreForegroundAudio({ running: true, paused: true, hidden: false }) === false,
  'foreground user gesture must not resume audio while manually paused',
);
expect(
  shouldRestoreForegroundAudio({ running: true, paused: false, hidden: true }) === false,
  'foreground user gesture must not resume audio while the document is hidden',
);
expect(
  shouldRestoreForegroundAudio({ running: false, paused: false, hidden: false }) === false,
  'foreground user gesture must not initialize audio while powered off',
);

console.log('ok  - audio lifecycle foreground/background mute policy');

// The gesture handler is on keydown, so "nothing to restore" must be the common
// answer — during ordinary play it must not re-run the restore path at all.
{
  const playing = { running: true, paused: false, hidden: false };
  expect(needsForegroundAudioRestore({ ...playing, ctxState: 'running', gainPinned: false }) === false,
    'ordinary play restores nothing');
  expect(needsForegroundAudioRestore({ ...playing, ctxState: 'suspended', gainPinned: false }) === true,
    'a suspended context is restored');
  expect(needsForegroundAudioRestore({ ...playing, ctxState: undefined, gainPinned: false }) === true,
    'no context yet is restored');
  expect(needsForegroundAudioRestore({ ...playing, ctxState: 'running', gainPinned: true }) === true,
    'a gain pinned to 0 by a background transition is restored');
  expect(needsForegroundAudioRestore({ running: true, paused: true, hidden: false, ctxState: 'suspended' }) === false,
    'a user-paused machine is left alone');
  expect(needsForegroundAudioRestore({ running: true, paused: false, hidden: true, ctxState: 'suspended' }) === false,
    'a hidden tab is left alone');
  console.log('ok  - gesture restore only acts when something is suspended or pinned');
}
