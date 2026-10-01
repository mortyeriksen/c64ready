// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export function createDiskCompatibilityPrompt({ enabled, available, enable, disable, confirm, notify }) {
  // Raw GCR needs the emulated 1541; D71/D81 need the virtual drive.
  // Without a drive ROM, mounting still works through the virtual drive.
  return async function prepareDisk({ targetDrive, signal, rawGcr = false, kind = 'd64' }) {
    signal?.throwIfAborted();
    if (kind === 'd71' || kind === 'd81') {
      if (enabled(targetDrive) && available(targetDrive) && disable) {
        await disable(targetDrive);
        notify?.(`True Drive Emulation turned off for drive ${targetDrive}: .${kind} uses the virtual drive for ${kind === 'd71' ? '1571' : '1581'} images.`);
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
