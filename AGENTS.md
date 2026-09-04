# AGENTS.md

Notes for AI agents on this repo. Read once, in full. This is the must-follow
contract, not the runbook — keep it short.

## Git: Commit And Push Only When Told

- Never commit, and never push to `main` on GitHub, unless the user says to in
  the current conversation. Finishing a task, passing tests or a green build is
  not permission; ask, then wait. A previous go-ahead does not carry over.
- Every commit message is proposed to the user first, in full (subject and body),
  and is used only after the user confirms it. If the user asks for changes,
  propose the revised message and confirm again. No exceptions — this applies to
  every commit, including fix-ups, doc-only changes and version bumps.
- Never amend, rebase, force-push or reset published history; never run `git
  add -A` without showing the file list first.

## First Stops

- Testing, diagnostics, VICE workflows: `docs/TESTING.md`.
- Performance methodology + harnesses: `docs/PERFORMANCE-ANALYSIS.md`.
- Subsystem models: `docs/*-ARCHITECTURE.md` (`VIC2-`, `MACHINE-`, `SID-`,
  `DRIVE-`, `DATASETTE-`, `MEMORY-`, `CPU-`, `RETROVIBES-`).
- Screenshot-tool specifics: each tool's header comment
  (`test/commit-screenshots.mjs`, `test/demo-status.mjs`, `tools/guide-shots.mjs`,
  `tools/guide-extra-shots.mjs`, `tools/guide-dialog-shots.mjs`,
  `tools/guide-setup-shot.mjs`, `tools/vibes-guide-shots.mjs`,
  `tools/vibes-strip.mjs`, `tools/datasette-anim.mjs`, `tools/pick-frames.mjs`).
  `tools/guide-shots.mjs` heads the full guide-asset regeneration order.

## ROMs

The C64 + 1541 ROMs (`kernal.bin` 8K, `basic.bin` 8K, `chargen.bin` 4K,
`1541.bin` 16K) are copyrighted and NOT in this repository. The developer
supplies them in `roms/` (git-ignored); the tests read them from there via
`test/external-assets.json`, while the app takes them through its ROM setup
dialog and keeps them in browser storage (`src/roms.js`). Never commit a ROM,
embed ROM bytes in source or tests, or copy ROMs into `public/` (`public/roms/`
is git-ignored and excluded from the PWA precache for that reason).

## Workspace Hygiene

- Temp scripts + scratch output go under `investigation/` (git-ignored; create it
  on demand). At end of run, prune
  transient files (`.log`, `.txt`, `.csv`, `.bin`, `.mon`, `.png`, `.cpuprofile`,
  `.bak*`, `.DS_Store`); keep scripts (`.mjs`, `.js`, `.sh`, `.py`, `.asm`).
- Never touch `investigation/commitscreenshots/` or `demo-status-shots/` — the
  user owns those.
- No `.d64`/`.prg`/disk images in `investigation/`; reference external
  collections by real path (see Screenshot And Demo Tools). Committed test inputs
  go under `test/`.
- Never hand-edit generated `public/docs/`; edit source docs and run the build.
- `public/sitemap.xml` is a tracked `build:docs` byproduct: whenever the docs build
  updates it, that change ships with the push to `main` — never leave it behind as
  unrelated work-in-progress.

## Code And Docs

- Add tests for new features. Register every `test/*-test.js` in `test/all-test.js`.
- Env switches go in `src/switches.js`, read via `switchOn('name')` — no inline
  `process?.env`.
- Don't create new `*.md` docs without an explicit request.
- No em dashes in docs prose: none in paragraphs, lists, or table cells.
  Use a comma, colon, parentheses, or a sentence split instead. The
  `## <version> — <date>` release titles in `WHATS-NEW.md` keep theirs.
- Keep user docs current in the same change (`FEATURES`, `GETTING-STARTED`,
  `COMPONENT-STATUS`, `KNOWN-ISSUES`, `TESTING`, `SPECIFICATIONS`,
  `PERFORMANCE-ANALYSIS`). Docs state current behavior, not history — remove
  fixed known-issues, don't annotate them.
- Update `docs/*-ARCHITECTURE.md` when a change alters a subsystem model,
  pipeline, timing rule, device mode, or perf design; skip it for small fixes.
- No comments referencing fix history, callers, tickets, or the current task. Fix
  inaccurate comments near what you change; add present-tense ones where needed.
- Every shipped source file gets the two-line SPDX/copyright header (`src/`,
  `docs/`, `index.html`, build config, `tools/*.mjs`); `test/` and
  `investigation/` only on request.
- A user-facing change is written up in `docs/WHATS-NEW.md` as it lands, under
  the **Next release** section at the top of the file — plain language, no
  internals, since it is a published docs page. Add that section if it is gone
  (a bump consumed it); leave it out when the change is invisible to users.
- Bump `src/version.js` (`YEAR.MONTH.FIX`) only on request. In the same commit:
  retitle **Next release** to `## <version> — <Month D, YYYY>`, write its lead
  paragraph if the release deserves one, and sync `package.json`'s `version`.
- Shipped sections are history and are never revised: each says what that version
  did, so a later change to the same feature belongs in Next release, not edited
  into the old one. Next release itself is still open — an entry there may be
  rewritten or dropped until it ships.

## Test Methodology

- Assert spec invariants, not implementation timing. Don't pin "happens at cycle
  X" unless X is the observable spec boundary.
- Derive expected values from specs (Bauer, 6502, CIA, VIA, IEC), never by
  observing this implementation. A red spec-derived test is a bug signal — fix
  the bug, don't relax the assertion.
- One assertion per spec rule; the failure message names the rule.
- IEC bus lines are active-low through 7406 inverters both ends — read the top of
  `src/drive1541.js` before touching bus polarity.
- Don't derive expectations from demo binaries (`nine.prg`, `orbituntold.prg`);
  synthesize state and clock the machine.
- `softAssert(cond, msg)` (`test/_vic2-helpers.js`) warns without failing — only
  for known, intentionally shipped deviations.

## Screenshot And Demo Tools

- Demo/game assets are wired up in `test/external-assets.json`; the tools resolve
  them automatically (`collections` → `demo-status`/`commit-screenshots`, named
  `assets` like `raster-time-demo` → guide shots). Run them with no disk args —
  don't pass paths or bake synthetic disks. Missing files are SKIPs, not errors —
  print `# SKIP <reason>` (nothing ran) or `ok  - <check> # SKIP <reason>` (one
  check didn't) so `all-test.js` reports it instead of counting a silent PASS.
- Run `commit-screenshots.mjs` and `demo-status.mjs` only when the user asks (not
  just because you're committing); `demo-status` is a long run. Both accumulate +
  diff against the previous run in their `investigation/` output dirs.
- Don't run `tools/guide-shots.mjs` or regenerate `public/guide/*.webp` unless
  asked — editing UI or `USER-GUIDE.md` doesn't authorize it.
- Guide shots go through `tools/guide-image.mjs`: 1920-capped WebP, needs `cwebp`
  and `img2webp` (`brew install webp`). `public/guide/` is docs-only and runtime-
  cached, NOT precached (`src/sw.js`), so a shot the app itself shows needs a
  precached copy under `public/screens/` — the writer's `MIRRORS` map does that.

## Performance

- A/B comparisons must be same-thermal: measure candidate, stash only touched
  files, measure baseline, pop, measure candidate again back-to-back.
- `tools/perf-workloads.mjs` for Node/V8, `tools/jsc-perf.mjs` for Safari/JSC.
  Prefer allocation evidence (`allocsites`) for mobile jank; desktop time alone
  misses JSC allocation pressure.
- Keep hot paths (per-cycle, rAF loop, audio worklet, display-rate input) free of
  allocation, shape/type churn, and forced layout — no per-call allocs, no
  `getBoundingClientRect` interleaved with DOM writes (cache it, as the touch
  stick caches its pad rect on `pointerdown`). JSC charges for all three.

## VICE And References

- Always run VICE headless (`SDL_VIDEODRIVER=dummy` for scripted launches); never
  open a visible VICE window.
- Pass `-VICIImodel 0` when comparing VIC-II — this project models PAL 6569;
  VICE's default may be 8565 (false 1-cycle / 8-pixel offset).
- VICE monitor `CYC` is 0-based; our `cycleInLine` (and Bauer) are 1-based — VICE
  `CYC N` = our cycle `N+1`.
- Use `test/ref-compare.mjs` for testprog reference PNGs (switch to the Pepto
  palette first for raw-RGB VICE compares; it handles index compare + the 1-line
  crop offset).
- Match demos by visible state, not frame/cycle count — boot/autostart timing
  drifts between VICE and this emulator.

## Regression Investigations

Ask the user before treating a bug as a regression. Don't bisect, diff earlier
commits, revert, or toggle recently landed flags without confirmation. First
diagnose current behavior: where, what layer, raster/cycle if relevant, expected
spec rule.

## VIC-II Work

- Cycle-accurate against Bauer's VIC-II article + the VICE addendum; keep the
  model in `docs/VIC2-ARCHITECTURE.md`.
- A CPU register write at cycle N is visible to the VIC on cycle N+1 (master-cycle
  order) — never assert a same-cycle rendering effect.
- Don't mutate VIC flip-flops synchronously from `vic2.write()`; enqueue into
  `_pendingFFTransitions` so phi1 latch windows hold.
- Debug by layer before pixels: prove which of sprite/graphics/border/fixup wrote
  the bad pixel. Compare broken repeated elements to working neighbors in the same
  frame. A mismatch between incremental and deferred/fixup paths is itself a bug.

## SID Work

The SID model lives in both the audio worklet and the main-thread shadow voices;
update them together or `$D41B`/`$D41C` model detection breaks:

- Worklet: `sidNode.port.postMessage({ type: 'model', is8580 })` (also on `init`
  and `reset`).
- Shadow: `machine.setSidModel(is8580)`, from `main.js`'s
  `_applySidVariantPref()` after `new C64Machine()` and on toggle.

See `docs/SID-ARCHITECTURE.md` for why they're separate.

## PWA / Service Worker

`vite-plugin-pwa` `injectManifest` + custom `src/sw.js`, **prompt** flow
(`registerType: 'prompt'`): a new build's SW waits; `main.js` `onNeedRefresh`
shows a "New version — Reload" toast that skip-waits + reloads only on accept.
Never re-add `install → skipWaiting` (drops the running machine mid-session).

- The flow the client is ALREADY running handles updates. Installed clients have
  been on the prompt flow since before this repository was published, so any
  no-toast auto-reload is a bug (suspect a macOS "Add to Dock" WebKit PWA).
- `/pwa.html` = installed-launch beacon: network-only, never cached.
