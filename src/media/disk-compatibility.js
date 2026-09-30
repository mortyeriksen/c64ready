// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export function createDiskCompatibilityPrompt({ enabled, available, enable, disable, confirm, notify }) {
  // `rawGcr` marks a .g64: its loader and protection live in the raw track
  // layout, which only the emulated 1541 reads, and the built-in load can only
  // serve the standard sectors it finds there, so it turns TDE on rather than
  // asking. A .d81 is the opposite case: a 1581 disk is nothing the 1541 can
  // read, so the emulator serves it itself and TDE goes off for that drive,
  // again without asking. Without the drive ROM there is nothing to turn on or
  // off; the disk still mounts, and the caller's own message says what it will
  // and won't do.
  return async function prepareDisk({ targetDrive, signal, rawGcr = false, kind = 'd64' }) {
    signal?.throwIfAborted();
    if (kind === 'd81') {
      if (enabled(targetDrive) && available(targetDrive) && disable) {
        await disable(targetDrive);
        notify?.(`True Drive Emulation turned off for drive ${targetDrive}: a .d81 is a 1581 disk, which the 1541 cannot read.`);
      }
      return;
    }
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
