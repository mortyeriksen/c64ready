// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Master test runner — spawns each test file as a subprocess and reports
// per-file PASS/SKIP/FAIL plus an overall summary. Fast unit/spec tests only —
// demo-scale checks are manual tools run directly (test-nine.js,
// demo-status.mjs, commit-screenshots.mjs).
//
// SKIP reporting: a test whose external asset is missing exits 0, which would
// otherwise be indistinguishable from a real pass. Tests therefore announce a
// skip with a TAP-style directive, and this runner reports it (see classify):
//   "# SKIP <reason>"          at line start — the file did no real work → SKIP
//   "ok - <check> # SKIP <r>"  on an ok line  — the file ran, one check did
//                               not → PASS, counted under "partially skipped"
// Skips never fail the run; they are listed in the summary so a green suite
// can't quietly hide a fixture that has gone missing.
//
// Usage:
//   node test/all-test.js                # default suite, 6 in parallel
//   node test/all-test.js --jobs=8       # override concurrency
//   node test/all-test.js --jobs=1       # force sequential

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TESTS = [
  // Quick unit tests (deterministic, fast)
  'test/docs-sitemap-spec-test.js',
  'test/docs-head-assets-spec-test.js',
  'test/audio-lifecycle-spec-test.js',
  'test/splash-spec-test.js',
  'test/panel-order-spec-test.js',
  'test/switches-spec-test.js',
  'test/machine-api-spec-test.js',
  'test/vibes-btn-patterns-spec-test.js',
  'test/vibes-screen-light-spec-test.js',
  'test/d64-write-prg-spec-test.js',
  'test/escape-stack-spec-test.js',
  'test/tap-audio-spec-test.js',
  'test/tape-record-audio-spec-test.js',
  'test/tap-directory-spec-test.js',
  'test/wav-tape-polarity-spec-test.js',
  'test/wav-tape-repair-spec-test.js',
  'test/wav-tape-level-spec-test.js',
  'test/turbo-mend-spec-test.js',
  'test/turbo-splice-spec-test.js',
  'test/wav-tape-rates-spec-test.js',
  'test/dmp-tape-spec-test.js',
  'test/wav-decode-spec-test.js',
  'test/tape-flag-cia-spec-test.js',
  'test/turbo-name-spec-test.js',
  'test/novaload-spec-test.js',
  'test/turbo-threshold-spec-test.js',
  'test/tape-seek-spec-test.js',
  'test/tape-play-spec-test.js',
  'test/console-hygiene-spec-test.js',
  'test/recorder-audio-bridge-spec-test.js',
  'test/recording-support-spec-test.js',
  'test/cpu-test.js',
  'test/cpu-indexed-store-rmw-false-read-spec-test.js',
  'test/cpu-nmi-branch-nocross-delay-spec-test.js',
  'test/cpu-nmi-preempt-clears-deferred-irq-spec-test.js',
  'test/cpu-page-cross-spec-test.js',
  'test/illegal-arr-spec-test.js',
  'test/cycle-audit-test.js',
  'test/vic2-badline-scenarios-test.js',
  'test/vic2-badline-goodline-integration-test.js',
  'test/vic2-fli-badline-every-line-spec-test.js',
  'test/vic2-badline-cancel-boundary-spec-test.js',
  'test/vic2-badline-late-caccess-line-local-spec-test.js',
  'test/vic2-sprite-ba-cycles-test.js',
  'test/clock-cycle-spec-test.js',
  'test/vic2-border-edge-spec-test.js',
  'test/vic2-midline-register-spec-test.js',
  'test/vic2-sprite-render-spec-test.js',
  'test/vic2-sprite-render-basics-spec-test.js',
  'test/vic2-gaccess-shifter-spec-test.js',
  'test/cia-timer-spec-test.js',
  'test/cia-timer-latch-zero-spec-test.js',
  'test/cia-force-load-edge-spec-test.js',
  'test/cia-irq-ackn-bug-spec-test.js',
  'test/cia-ir-latch-sticky-spec-test.js',
  'test/cia-timer-underflow-read-spec-test.js',
  'test/cia-timer-cascade-spec-test.js',
  'test/cia-irq-nmi-verified-behaviors-spec-test.js',
  'test/cia-portb-ddr-readback-spec-test.js',
  'test/vic2-display-state-spec-test.js',
  'test/vic2-sprite-lifecycle-spec-test.js',
  'test/pla-memory-spec-test.js',
  'test/pla-memory-config-spec-test.js',
  'test/pla-ba-io-read-spec-test.js',
  'test/cia-sdr-spec-test.js',
  'test/vic2-sprite-shifter-spec-test.js',
  'test/datasette-record-test.js',
  'test/kernal-tape-load-test.js',
  'test/kernal-tape-save-test.js',
  'test/turbo-tape-record-test.js',
  'test/cpu-port-ddr-spec-test.js',
  'test/cia-timerb-modes-spec-test.js',
  'test/cia-count-source-stop-symmetry-spec-test.js',
  'test/cia-peek-read-timer-aperture-match-spec-test.js',
  'test/cia-keyboard-ddra-column-select-spec-test.js',
  'test/soft-keyboard-spec-test.js',
  'test/input-key-ownership-spec-test.js',
  'test/app-accel-spec-test.js',
  'test/frame-rate-guard-spec-test.js',
  'test/vic2-sprite-x-comparator-spec-test.js',
  'test/vic2-frame-boundary-spec-test.js',
  'test/via6522-spec-test.js',
  'test/drive-cycle-ratio-spec-test.js',
  'test/illegal-opcodes-spec-test.js',
  'test/vic2-sprite-collision-irq-spec-test.js',
  'test/vic2-collision-irq-spec-test.js',
  'test/vic2-text-mode-rendering-spec-test.js',
  'test/vic2-ecm-gaccess-address-mask-spec-test.js',
  'test/vic2-fetch-address-glitch-spec-test.js',
  'test/vic2-invalid-mode-display-collision-spec-test.js',
  'test/vic2-invalid-modes-spec-test.js',
  'test/vic2-sprite-paccess-dma-off-spec-test.js',
  'test/vic2-dram-refresh-counter-wrap-spec-test.js',
  'test/vic2-idle-gaccess-cy56-57-ecm-independent-spec-test.js',
  'test/vic2-rsel-csel-border-growth-spec-test.js',
  'test/vic2-border-rule5-leftcompare-top-reset-spec-test.js',
  'test/vic2-color-ram-spec-test.js',
  'test/cia-port-arbitration-spec-test.js',
  'test/control-port-paddle-spec-test.js',
  'test/control-port-mouse1351-spec-test.js',
  'test/control-port-neos-spec-test.js',
  'test/control-port-keyboardjoy-spec-test.js',
  'test/control-port-keyboardjoy-wrap-spec-test.js',
  'test/control-port-touchjoy-spec-test.js',
  'test/rom-cache-spec-test.js',
  'test/rom-file-selector-spec-test.js',
  'test/vice-rom-pick-spec-test.js',
  'test/analytics-markers-spec-test.js',
  'test/model-asset-spec-test.js',
  'test/load-state-filter-spec-test.js',
  'test/state-rename-spec-test.js',
  'test/media-eject-ui-spec-test.js',
  'test/cartridge-controls-sync-spec-test.js',
  'test/save-state-default-name-spec-test.js',
  'test/irq-sampling-spec-test.js',
  'test/vic2-border-timing-precision-spec-test.js',
  'test/vic2-border-ff-spec-test.js',
  'test/vic2-sprite-midline-race-spec-test.js',
  'test/vic2-sprite-multiplexer-spec-test.js',
  'test/vic2-sprites-top-border-spec-test.js',
  'test/vic2-mode-flip-spec-test.js',
  'test/vic2-vborder-supremacy-spec-test.js',
  'test/vic2-vborder-phi1-ordering-spec-test.js',
  'test/vic2-topborder-rendering-spec-test.js',
  'test/vic2-openborder-idle-mcm-snapshot-spec-test.js',
  'test/cfetch-mode-segment-spec-test.js',
  'test/vic2-midline-mode-flip-rendering-spec-test.js',
  'test/vic2-pixel-mode-rendering-spec-test.js',
  'test/vic2-mxye-crunch-spec-test.js',
  'test/vic2-d017-rule1-level-sensitive-spec-test.js',
  'test/vic2-sprite-crunch-timing-spec-test.js',
  'test/vic2-sprite-crunch-addendum-spec-test.js',
  'test/irq-latency-spec-test.js',
  'test/vic2-sprite-cycle-accounting-spec-test.js',
  'test/illegal-opcode-cycle-audit-test.js',
  'test/cpu-lax-imm-magic-constant-spec-test.js',
  'test/legal-opcode-cycle-audit-test.js',
  'test/cycle-precision-spec-test.js',
  'test/bus-kind-audit-test.js',
  'test/vic2-sprite-saccess-duration-spec-test.js',
  'test/vic2-collision-timing-spec-test.js',
  'test/vic2-collision-under-csel-border-spec-test.js',
  'test/cpu-port-ba-spec-test.js',
  'test/write-during-ba-spec-test.js',
  'test/vic2-sprite-bg-collision-modes-spec-test.js',
  'test/vic2-ghost-byte-border-spec-test.js',
  'test/vic2-ghost-byte-idle-byte-spec-test.js',
  'test/vic2-side-border-open-spec-test.js',
  'test/vic2-sprite-x-wrap-spec-test.js',
  'test/vic2-sprite-final-row-idle-fetch-spec-test.js',
  'test/vic2-sprite-wrap-midline-x-spec-test.js',
  'test/vic2-sprite-wrap-lowx-rewrite-preserve-spec-test.js',
  'test/vic2-sprite-datarow-midline-spec-test.js',
  'test/vic2-sprite-d018-banking-spec-test.js',
  'test/vic2-d016-res-bit-spec-test.js',
  'test/vic2-grey-dot-spec-test.js',
  'test/vic2-grey-dot-samevalue-write-spec-test.js',
  'test/irq-ba-stall-spec-test.js',
  'test/vic2-nine-tricks-spec-test.js',
  'test/vic2-nine-open-top-border-ghost-spec-test.js',
  'test/vic2-nine-top-border-trick-spec-test.js',
  'test/vic2-invalid-mode-idle-collision-shinethrough-spec-test.js',
  'test/vic2-nine-vborder-open-top-propagation-spec-test.js',
  'test/vic2-nine-sprite-bottom-border-mask-spec-test.js',
  'test/vic2-nine-sprite-shifter-hygiene-spec-test.js',
  'test/vic2-nine-sprite-y-going-up-spec-test.js',
  'test/vic2-nine-irq-accept-cycle-spec-test.js',
  'test/vic2-nine-irq-accept-per-opcode-spec-test.js',
  'test/vic2-nine-sprite-x-midline-rewrite-spec-test.js',
  'test/vic2-line-batch-spec-test.js',
  'test/vic2-nine-sprite-ymatch-retrigger-spec-test.js',
  'test/vic2-sprite-x-samecycle-write-spec-test.js',
  'test/vic2-nine-top-border-d021-live-spec-test.js',
  'test/vic2-nine-crunch-d018-straddle-spec-test.js',
  'test/vic2-vertical-hyperscreen-spec-test.js',
  'test/sid-spec-test.js',
  'test/sid-combined-waveform-spec-test.js',
  'test/sid-wavetables-spec-test.js',
  'test/sid-digi-spec-test.js',
  'test/sid-shadow-spec-test.js',
  'test/sid-shadow-phaseonly-spec-test.js',
  'test/sid-outputstage-skip-equiv-spec-test.js',
  'test/sid-engine-switch-spec-test.js',
  'test/sid-wasm-engine-spec-test.js',
  'test/sid-worklet-backlog-spec-test.js',
  'test/mp4-remux-spec-test.js',
  'test/sid-event-gate-spec-test.js',
  'test/sid-paddle-spec-test.js',
  'test/osc3-cycle-test.js',
  'test/vic2-sprite-subpixel-phase-spec-test.js',
  'test/vic2-cycle-incremental-render-spec-test.js',
  'test/vic2-badline-latch-spec-test.js',
  'test/vic2-sprite-display-raster-wrap-spec-test.js',
  'test/vic2-csel-veto-sprite-rollback-spec-test.js',
  'test/vic2-csel-veto-window-spec-test.js',
  'test/vic2-sprite-corner-cases-spec-test.js',
  'test/vic2-raster-irq-chain-spec-test.js',
  'test/vic2-raster-irq-edge-trigger-spec-test.js',
  'test/vic2-raster-irq-follow-no-trigger-spec-test.js',
  'test/ba-aec-matrix-spec-test.js',
  'test/master-cycle-spec-test.js',
  'test/io-ordering-audit-test.js',
  'test/irq-pipeline-spec-test.js',
  'test/cpu-branch-irq-delay-spec-test.js',
  'test/cpu-irq-sampled-only-spec-test.js',
  'test/cpu-jam-halt-spec-test.js',
  'test/cpu-unstable-store-illegals-spec-test.js',
  'test/irq-chain-long-stability-spec-test.js',
  'test/stable-raster-jitter-absorb-spec-test.js',
  'test/vic2-d019-rmw-spec-test.js',
  'test/irq-nmi-mid-instruction-spec-test.js',
  'test/machine-master-cycle-gaps-spec-test.js',
  'test/c20e-handler-cycles-test.js',
  'test/ba-contour-3ad-spec-test.js',
  'test/savestate-roundtrip-spec-test.js',
  'test/ba-rmw-phase-spec-test.js',
  'test/handler-exit-cycle-spec-test.js',
  'test/vic2-midline-d018-vm-change-spec-test.js',
  'test/fpp-vm-switch-pixel-spec-test.js',
  'test/vic2-color-bar-pixel-spec-test.js',
  'test/vic2-fixup-batch-equivalence-spec-test.js',
  'test/vic2-capture-dedup-equivalence-spec-test.js',
  'test/vic2-sprite-idle-skip-equivalence-spec-test.js',
  'test/vic2-xscroll-pixel-advance-spec-test.js',
  'test/vic2-sprite-multiplex-pixel-position-spec-test.js',
  'test/ba-rising-edge-spec-test.js',
  'test/vic2-badline-cpu-cost-spec-test.js',
  'test/irq-entry-under-rdy-spec-test.js',
  'test/vic2-d018-cb-mid-line-spec-test.js',
  'test/vic2-badline-latch-boundary-spec-test.js',
  'test/vic2-csel-boundary-cycles-spec-test.js',
  'test/vic2-d018-sample-cycle-spec-test.js',
  'test/vic2-mid-line-bmm-flip-spec-test.js',
  'test/vic2-raster-compare-9bit-spec-test.js',
  'test/vic2-d016-xscroll-sample-cycle-spec-test.js',
  'test/vic2-sprite-ba-contour-per-sprite-spec-test.js',
  'test/vic2-d01b-sprite-priority-mid-line-spec-test.js',
  'test/rti-cycle-accounting-spec-test.js',
  'test/vic2-d010-x-msb-mid-line-spec-test.js',
  'test/vic2-d012-raster-read-race-spec-test.js',
  'test/vic2-d015-mid-line-enable-spec-test.js',
  'test/brk-opcode-spec-test.js',
  'test/cia1-timer-irq-integration-spec-test.js',
  'test/vic-irq-deassert-hold-spec-test.js',
  'test/branch-cycle-accounting-spec-test.js',
  'test/jsr-rts-cycle-spec-test.js',
  'test/abs-indexed-page-cross-spec-test.js',
  'test/indirect-y-cycle-spec-test.js',
  'test/stack-op-cycle-spec-test.js',
  'test/jmp-indirect-cycle-spec-test.js',
  'test/vic2-vc-vmli-counter-spec-test.js',
  'test/vic2-sprite-shifter-delay-spec-test.js',
  'test/cia2-nmi-integration-spec-test.js',
  'test/cia-nmi-irq-delay-symmetry-spec-test.js',
  'test/nested-irq-cli-spec-test.js',
  'test/vic2-raster-irq-accept-during-sei-spec-test.js',
  'test/stable-irq-sprite-ba-drift-spec-test.js',
  'test/cia-timer-during-ba-stall-spec-test.js',
  'test/vic2-badline-ba-aec-boundary-spec-test.js',
  'test/vic2-aec-ba-gap-contiguity-spec-test.js',
  'test/vic2-sprite-late-dma-byte0-openbus-spec-test.js',
  'test/vic2-fli-cancel-sprite-tail-spec-test.js',
  'test/vic2-fli-full-band-spec-test.js',
  'test/vic2-raster-time-mechanism-spec-test.js',
  'test/vic2-raster-time-dejitter-spec-test.js',
  'test/vic2-raster-time-spinner-spec-test.js',
  'test/vic2-raster-time-irq-during-spinner-spec-test.js',
  'test/vic2-bmm-inner-idle-bg-spec-test.js',
  'test/vic2-raster-compare-mid-line-write-spec-test.js',
  'test/vic2-sprite-color-mid-line-spec-test.js',
  'test/vic2-d011-den-toggle-spec-test.js',
  'test/rmw-illegal-under-ba-spec-test.js',
  'test/vic2-sprite-y-frame-edge-spec-test.js',
  'test/multi-irq-priority-spec-test.js',
  'test/vic2-register-masks-spec-test.js',
  'test/handler-bus-kind-audit-spec-test.js',
  'test/fpp-handler-63cy-sum-spec-test.js',
  'test/vic2-sprite-right-border-paint-spec-test.js',
  'test/vic2-sprite-side-border-spec-test.js',
  'test/vic2-midline-mode-switch-column-spec-test.js',
  'test/vic2-dma-delay-vsp-spec-test.js',
  'test/vic2-vsp-idle-byte-glitch-spec-test.js',
  'test/vic2-rc-carryover-screenpos-spec-test.js',
  'test/vic2-cy58-idle-display-entry-spec-test.js',
  'test/vic2-cy58-write-no-spurious-badline-spec-test.js',
  'test/crt-test.js',
  'test/datasette-test.js',
  'test/cart-memory-test.js',
  'test/memory-reset-spec-test.js',
  'test/pla-test.js',
  'test/easyflash-test.js',
  'test/generic-cart-test.js',
  'test/magicdesk-cart-test.js',
  'test/final3-cart-test.js',
  'test/action-replay-cart-test.js',
  'test/cartridge-crt-state-spec-test.js',
  'test/reu-registers-spec-test.js',
  'test/reu-transfer-spec-test.js',
  'test/reu-dma-timing-spec-test.js',
  'test/drive-test.js',
  'test/drive-rom-test.js',
  'test/fastloader-test.js',
  'test/iec-handshake-test.js',
  'test/iec-inter-block-handshake-spec-test.js',
  'test/iec-2bit-transfer-spec-test.js',
  'test/iec-edge-latency-spec-test.js',
  'test/cpu-bvc-clv-spec-test.js',
  'test/drive-so-delay-spec-test.js',
  'test/drive-soe-gating-spec-test.js',
  'test/drive-ca1-byteready-spec-test.js',
  'test/drive-mechanical-timing-spec-test.js',
  'test/gcr-readpath-format-spec-test.js',
  'test/gcr-writeback-spec-test.js',
  'test/drive-save-spec-test.js',
  'test/d64-petscii-directory-spec-test.js',
  'test/d64-del-directory-spec-test.js',
  'test/d64-format-spec-test.js',
  'test/d64-error-table-dos-spec-test.js',
  'test/kernal-load-wildcard-spec-test.js',
  'test/klaus-test.js',
  'test/nosdos-bootstrap-test.js',
  'test/vic2-bitmap-mode-spec-test.js',
  'test/vic2-bad-line-window-spec-test.js',
  'test/vic2-spec-tables-spec-test.js',
  'test/vic2-color-registers-spec-test.js',
  'test/vic2-nine-demo-deps-spec-test.js',
  'test/vic2-sprite-collision-spec-test.js',
  'test/vic2-sprite-bg-collision-midline-d011-spec-test.js',
  'test/vic2-sprite-sprite-collision-table-spec-test.js',
  'test/vic2-sprite-collision-cycle-visibility-spec-test.js',
  'test/vic2-sprite-collision-read-clears-pipeline-spec-test.js',
  'test/vic2-sprite-spec-coverage-spec-test.js',
  'test/vic2-fld-fli-linecrunch-spec-test.js',
  'test/vic2-vsp-spec-test.js',
  'test/vic2-d015-midline-spec-test.js',
  'test/vic2-bank-routing-spec-test.js',
  'test/vic2-sprite-multiplexer-deps-spec-test.js',
  'test/vic2-sprite-render-output-spec-test.js',
  'test/vic2-sprite-crunch-rule-7a-spec-test.js',
  'test/vic2-sprite-overlay-spec-test.js',
  'test/vic2-d017-timing-spec-test.js',
  'test/vic2-irq-prelude-spec-test.js',
  'test/vic2-kernal-irq-prelude-spec-test.js',
  'test/autoload-ready-detect-spec-test.js',
  'test/lightpen-spec-test.js',
  'test/lightpen-cia-wiring-spec-test.js',
  'test/vic2-badline-tricks-spec-test.js',
  'test/vic2-sprite-priority-collision-spec-test.js',
  'test/vic2-irq-sources-spec-test.js',
  'test/vic2-sprite-idle-bus-leak-spec-test.js',
  'test/open-bus-de00-spec-test.js',
  'test/open-bus-color-ram-spec-test.js',
  'test/open-bus-cpu-internal-spec-test.js',
  'test/open-bus-port-zero-one-spec-test.js',
  'test/open-bus-machine-integration-spec-test.js',
  'test/vic2-readonly-regs-spec-test.js',
  'test/vic2-clear-raster-irq-spec-test.js',
  'test/vic2-sprite-ba-cycle55-ordering-spec-test.js',
  'test/vic2-sprite-cy58-display-mxe-gate-spec-test.js',
  'test/vic2-sprite-dma-restart-preserves-display-spec-test.js',
  'test/vic2-bg-color-output-stage-timing-spec-test.js',
  'test/vic2-bitmap-vc-wrap-spec-test.js',
  'test/vic2-bitmap-live-vc-spec-test.js',
  'test/vic2-bitmap-xscroll-left-filler-spec-test.js',
  'test/vic2-reset-state-spec-test.js',
  'test/vic2-memory-default-spec-test.js',
  'test/vic2-sprite-crunch-pending-leak-spec-test.js',
  'test/vic2-sprite-collision-idempotency-spec-test.js',
  'test/vic2-sprite-x164-boundary-garbage-spec-test.js',
  'test/vic2-sprite-sb-fetch-spec-test.js',
  'test/frame-trace-irq-state-spec-test.js',
  'test/vic2-vborder-cycle63-live-d011-spec-test.js',
  'test/vic2-vborder-rule4-leftcompare-spec-test.js',
  'test/cia2-vic-bank-spec-test.js',
  'test/vic2-dec-d017-rmw-crunch-spec-test.js',
  'test/vic2-csel-veto-collision-idempotency-spec-test.js',
  'test/irq-d016-cycle-alignment-spec-test.js',
  'test/irq-cia2-dd02-bank-cycle-spec-test.js',
  'test/vic2-nmos-bank-delay-spec-test.js',
  'test/vic2-c64c-bank-glitch-spec-test.js',
  'test/vic2-badline-rc-reset-timing-spec-test.js',
  'test/vic2-badline-pre-c14-abort-displayactive-spec-test.js',
  'test/vic2-d018-write-no-row-fetch-residue-spec-test.js',
  'test/vic2-badline-late-line-reactivate-spec-test.js',
  'test/vic2-idle-state-no-stale-row-render-spec-test.js',
  'test/vic2-cy58-display-state-capture-spec-test.js',
  'test/vic2-open-bus-idle-gaccess-gate-spec-test.js',
  'test/vic2-idle-g-access-spec-test.js',
  'test/vic2-den-line30-phi2-boundary-latch-spec-test.js',
];

// A test signals a skip with a TAP directive on stdout (see the header). Full
// skips sit at line start; a passing file can still report skipped checks.
const FULL_SKIP_RE = /^[ \t]*#[ \t]*SKIP[ \t]*(.*)$/m;
const CHECK_SKIP_RE = /^[ \t]*ok\b.*?#[ \t]*SKIP[ \t]*(.*)$/gm;

function classify(r) {
  if (r.code !== 0) return { status: 'FAIL' };
  const full = FULL_SKIP_RE.exec(r.stdout);
  if (full) return { status: 'SKIP', reason: full[1].trim() };
  const checks = [...r.stdout.matchAll(CHECK_SKIP_RE)].map((m) => m[1].trim());
  if (checks.length) return { status: 'PASS', skippedChecks: checks };
  return { status: 'PASS' };
}

/** Keep the summary scannable — the head of a reason carries the actionable part. */
function trim(reason, max = 140) {
  if (!reason) return '(no reason given)';
  return reason.length > max ? reason.slice(0, max - 1) + '…' : reason;
}

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn('node', [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      resolve({ file, code, ms: Date.now() - t0, stdout, stderr });
    });
  });
}

function parseJobs(argv) {
  for (const a of argv) {
    const m = /^--jobs=(\d+)$/.exec(a);
    if (m) return Math.max(1, parseInt(m[1], 10) | 0);
  }
  return 6; // default concurrency
}

// Run `tasks` (array of arg-tuples for `runOne`) with a fixed worker pool.
// `onResult(r, doneCount, totalCount)` fires as each task completes; results
// are returned in completion order. Each test's stdout / stderr stays
// captured per-task (no interleaved log lines on the parent process).
async function runPool(items, concurrency, runFn, onResult) {
  const results = [];
  let next = 0;
  let done = 0;
  const total = items.length;
  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const r = await runFn(items[i]);
      results.push(r);
      done++;
      if (onResult) onResult(r, done, total);
    }
  });
  await Promise.all(workers);
  return results;
}

// The suite boots a full machine; without the (user-supplied, copyrighted)
// C64 ROMs nearly every test fails with an unhelpful ENOENT — check up front.
// See test/external-assets.json ("roms") and docs/GETTING-STARTED.md.
function checkRoms() {
  const romsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'roms');
  const missing = ['kernal.bin', 'basic.bin', 'chargen.bin']
    .filter(f => !fs.existsSync(path.join(romsDir, f)));
  if (missing.length) {
    console.error(`Missing C64 ROMs: ${missing.map(f => 'roms/' + f).join(', ')}`);
    console.error('Supply your own ROM images (copyrighted — not distributed with this repo);');
    console.error('see test/external-assets.json ("roms") and docs/GETTING-STARTED.md → Set up ROMs.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(romsDir, '1541.bin'))) {
    console.error('note: roms/1541.bin not found — the true-drive (1541) tests are skipped until you supply it.\n');
  }
}

async function main() {
  checkRoms();
  const jobs = parseJobs(process.argv);
  const suite = TESTS;

  console.log(`Running ${suite.length} test file(s) — ${jobs} in parallel\n`);

  const wallStart = Date.now();
  const totalDigits = String(suite.length).length;
  const results = await runPool(suite, jobs, runOne, (r, doneCount, total) => {
    r.verdict = classify(r);
    const status = r.verdict.status;
    const idx = String(doneCount).padStart(totalDigits, ' ');
    process.stdout.write(
      `  [${idx}/${total}] ${path.basename(r.file).padEnd(40)} ${status}  (${(r.ms / 1000).toFixed(1)}s)\n`
    );
    if (r.code !== 0) {
      // Print the failing test's tail so the cause is visible.
      const tail = (r.stdout + r.stderr).trim().split('\n').slice(-15).join('\n');
      console.log('  --- last 15 lines ---');
      console.log(tail.split('\n').map((l) => `    ${l}`).join('\n'));
      console.log('  ---------------------');
    }
  });
  const wallMs = Date.now() - wallStart;

  const skippedFiles = results.filter((r) => r.verdict.status === 'SKIP');
  const partial = results.filter((r) => r.verdict.skippedChecks?.length);
  const failed = results.filter((r) => r.verdict.status === 'FAIL').length;
  const passed = results.length - failed - skippedFiles.length;
  const cpuMs = results.reduce((a, r) => a + r.ms, 0);

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Total:   ${results.length}`);
  console.log(`Passed:  ${passed}`);
  console.log(`Skipped: ${skippedFiles.length}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Wall:    ${(wallMs / 1000).toFixed(1)}s (CPU: ${(cpuMs / 1000).toFixed(1)}s, ${jobs}× parallel)`);

  const width = Math.max(
    0,
    ...[...skippedFiles, ...partial].map((r) => path.basename(r.file).length)
  );
  if (skippedFiles.length) {
    console.log('');
    console.log('Skipped files (nothing ran — missing asset; see test/external-assets.json):');
    for (const r of skippedFiles.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  ${path.basename(r.file).padEnd(width)}  ${trim(r.verdict.reason)}`);
    }
  }
  if (partial.length) {
    console.log('');
    console.log('Partially skipped (the file passed, but these checks did not run):');
    for (const r of partial.sort((a, b) => a.file.localeCompare(b.file))) {
      for (const c of r.verdict.skippedChecks) {
        console.log(`  ${path.basename(r.file).padEnd(width)}  ${trim(c)}`);
      }
    }
  }
  if (failed > 0) {
    console.log('');
    console.log('Failed files:');
    for (const r of results.filter((x) => x.code !== 0)) {
      console.log(`  ${r.file} (exit ${r.code})`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
