// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export function createDiskCompatibilityPrompt({ enabled, available, enable, confirm, notify }) {
  // `rawGcr` marks a .g64: its loader and protection live in the raw track
  // layout, which only the emulated 1541 reads, and the built-in load can only
  // serve the standard sectors it finds there, so it turns TDE on rather than
  // asking. Without the drive ROM there is nothing to turn on; the disk still
  // mounts, and the caller's own message says what it will and won't do.
  return async function prepareDisk({ targetDrive, signal, rawGcr = false }) {
    signal?.throwIfAborted();
    if (enabled(targetDrive) || !available(targetDrive)) return;
    if (rawGcr) {
      await enable(targetDrive);
      notify?.(`True Drive Emulation turned on for drive ${targetDrive}: a .g64 needs the real 1541.`);
      return;
    }
    const yes = await confirm(
      `True Drive Emulation improves compatibility with disk loaders and demos. Enable it for drive ${targetDrive}? Loading may take longer.`,
      { title: 'Better disk compatibility?', okLabel: 'Turn TDE on', cancelLabel: 'Keep TDE off', signal },
    );
    signal?.throwIfAborted();
    if (yes) await enable(targetDrive);
  };
}
