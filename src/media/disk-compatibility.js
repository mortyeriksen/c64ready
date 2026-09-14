// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
export function createDiskCompatibilityPrompt({ enabled, available, enable, confirm }) {
  return async function prepareDisk({ targetDrive, signal }) {
    signal?.throwIfAborted();
    if (enabled(targetDrive) || !available(targetDrive)) return;
    const yes = await confirm(
      `True Drive Emulation improves compatibility with disk loaders and demos. Enable it for drive ${targetDrive}? Loading may take longer.`,
      { title: 'Better disk compatibility?', okLabel: 'Turn TDE on', cancelLabel: 'Keep TDE off', signal },
    );
    signal?.throwIfAborted();
    if (yes) await enable(targetDrive);
  };
}
