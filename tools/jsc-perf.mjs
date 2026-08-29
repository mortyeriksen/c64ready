// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Idle perf on JavaScriptCore (Safari's engine) via Playwright WebKit.
// Serves the repo over HTTP, loads jsc-perf-harness.html, runs the idle
// measurement, prints median ms/frame. Pair with a git-stash A/B to compare
// the pre-built opcode table vs the original switch on the *mobile* engine.
//   node tools/jsc-perf.mjs [label]
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
  '.bin': 'application/octet-stream', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/jsc-perf-harness.html';
  const fp = path.join(root, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream',
      'cache-control': 'no-store',
      // Cross-origin isolation → SharedArrayBuffer available (the SID ring needs
      // it), matching vite.config.js. localhost is already a secure context.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp' });
    res.end(d);
  });
});

const label = process.argv[2] || 'JSC';
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const browser = await webkit.launch();
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://localhost:${port}/tools/jsc-perf-harness.html`);
  await page.waitForFunction('typeof window.__run === "function"', null, { timeout: 30000 });
  const res = await page.evaluate(() => window.__run());
  console.log(`${label} idle: median=${res.median.toFixed(3)} ms/frame  best=${res.best.toFixed(3)}  ` +
    `(${(1000 / res.median).toFixed(0)} fps = ${(1000 / res.median / 50).toFixed(1)}× realtime)`);
  if (errs.length) console.log('page errors:', errs.join('\n'));
} finally {
  await browser.close();
  server.close();
}
