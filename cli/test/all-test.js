// CLI test runner — spawns each spec test and reports PASS/FAIL plus a summary,
// the same shape as the app repo's runner so graduation is a move and a merge.
// No emulator boots in this suite; run and loadtest are checked by hand.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TESTS = [
  'cli-args-spec-test.js',
  'cli-formats-spec-test.js',
  'cli-dir-spec-test.js',
  'cli-wav2tap-spec-test.js',
  'cli-disk-spec-test.js',
  'cli-roms-spec-test.js',
  'cli-apng-spec-test.js',
  'cli-collage-spec-test.js',
  'cli-run-spec-test.js',
  'cli-tapeload-spec-test.js',
  'cli-loader-spec-test.js',
  'cli-t64-spec-test.js',
  'cli-tapewrite-spec-test.js',
  'cli-tapcat-spec-test.js',
  'cli-turbo-spec-test.js',
  'cli-crt-spec-test.js',
  'cli-jobs-spec-test.js',
];

let failed = 0;
for (const name of TESTS) {
  const t0 = Date.now();
  const code = await new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(here, name)], { stdio: 'inherit' });
    p.on('close', resolve);
  });
  if (code !== 0) { failed++; console.error(`FAIL  ${name}`); }
  else console.log(`      ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

console.log(failed ? `\n${failed} of ${TESTS.length} test files failed` : `\nAll ${TESTS.length} test files passed`);
process.exit(failed ? 1 : 0);
