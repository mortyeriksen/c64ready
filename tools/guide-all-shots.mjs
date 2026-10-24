// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Regenerate guide screenshots in Phosphor dark, with explicit theme galleries.
// Usage: node tools/guide-all-shots.mjs [baseURL]
// Requires the running dev server, external-assets.json inputs and WebP tools.
import { spawn } from 'node:child_process';

const base = process.argv[2] || 'http://localhost:5173';
const panes = 'investigation/guide-refresh/vibes';
async function run(tool, args = [base]) {
  console.log(`\n=== ${tool} ===`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`tools/${tool}.mjs`, ...args], {
      stdio: 'inherit', env: { ...process.env, GUIDE_BASE: base },
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${tool} exited ${code}`)));
  });
}
await Promise.all([run('guide-shots'), run('guide-theme-shots')]);
await run('guide-extra-shots');
await run('guide-mobile-shots');
await run('guide-assembly64-shots');
await run('guide-setup-shot');
await run('guide-dialog-shots');
await run('vibes-guide-shots', [base, panes]);
await run('vibes-strip', [panes, process.env.GUIDE_OUT || 'public/guide']);
await run('datasette-anim', []);
console.log('\nGuide screenshot regeneration complete.');
