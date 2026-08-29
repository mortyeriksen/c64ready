// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/state.js – Shared, runtime-reassigned singletons.
//
// These bindings are created/replaced at runtime (power-on, audio init, reset,
// state-load) and are READ across main.js, input.js and media.js. ES module
// live bindings mean every importer observes the latest value automatically —
// but only when the reassignment goes through the setters here, because an
// imported binding is read-only at its use site (`import { machine }; machine =
// x` throws). So: read `machine` directly anywhere; write it only via
// `setMachine(...)`.
//
// Scope is deliberately minimal — only bindings genuinely shared across module
// boundaries live here. Core-private singletons (audioCtx, masterGain, loop
// timers) stay in main.js; media-domain caches (currentD64, drive9*, cached
// cart/tape) are owned and exported by media.js.

// The emulator machine + ROM loader. Created in main.js (cold boot and every
// _createAndWireMachine); read pervasively by input.js and media.js.
export let machine = null;
export let loader = null;
export function setMachine(m) { machine = m; }
export function setLoader(l)  { loader = l; }

// SID AudioWorkletNode. Created in main.js initAudio(); read by media.js when
// re-wiring audio after a state load.
export let sidNode = null;
export function setSidNode(n) { sidNode = n; }

// Main-loop run flag. Written by main.js (power on/off) AND media.js (pause the
// loop around save/load); read by input.js keyboard/paste handlers.
export let running = false;
export function setRunning(v) { running = v; }

// Cold-boot gates for the auto-load/boot-warp sequencer. Owned by main.js's
// sequencer but reset by media.js when a PRG/state load makes the current boot
// "not pristine". Kept together as a pair.
export let _pristineBoot = false;
export let _hasBeenReady = false;   // only clear _pristineBoot AFTER cold boot reaches READY
export function setPristineBoot(v) { _pristineBoot = v; }
export function setHasBeenReady(v) { _hasBeenReady = v; }
