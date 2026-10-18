// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/serve.mjs — `c64rdy serve`: the C64 READY. app on http://localhost with
// the user port relay beside it on the same origin, so network devices work in
// every browser without a mixed-content or local-network prompt.
//
// The app comes from the public site and is kept in a local cache, so it stays
// current while online and still starts offline. --app <dir> serves a local
// build instead. --device <file> pre-installs a user port device in the app and
// reloads it whenever the file changes: the loop for writing devices.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, UsageError } from './args.mjs';
import { say } from './report.mjs';
import { attachRelay } from './relay.mjs';
import { loadDevice } from './userport.mjs';
import { scanDeviceSource } from '../src/userport/scan.js';

// What users will be warned about when they install this device.
function reportScan(file, log) {
  const findings = scanDeviceSource(fs.readFileSync(file, 'utf8'));
  if (!findings.length) { log('install check: nothing risky found'); return; }
  for (const f of findings) {
    const where = f.lines.length ? ` (line ${f.lines.join(', ')})` : '';
    log(`install check: ${f.severity} – ${f.title}${where}${f.addresses ? ': ' + f.addresses.join(' ') : ''}`);
  }
}

const DEFAULT_PORT = 6464;
const DEFAULT_SITE = 'https://c64ready.com';
const FETCH_TIMEOUT_MS = 10000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

// What the app needs to run: cross-origin isolation for the SID worklet's
// SharedArrayBuffer, and the gamepad permission.
const APP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'gamepad=(self)',
};

function cacheRoot(site) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'c64rdy', 'app', new URL(site).host);
}

function noCache(p) {
  return p === '/' || p.endsWith('.html') || p === '/sw.js' || p.endsWith('.webmanifest');
}

// Map a request path to a file under `root`, never outside it.
function safeJoin(root, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

// The site's own path rules: /docs/ and /docs/name serve built HTML pages.
function sitePath(p) {
  if (p === '/' || p === '') return '/index.html';
  if (p === '/docs' || p === '/docs/') return '/docs/index.html';
  if (p.startsWith('/docs/') && !path.posix.basename(p).includes('.')) return `${p}.html`;
  return p;
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { ...APP_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}

function serveLocal(dir, p, res) {
  let file = safeJoin(dir, sitePath(p));
  if (!file) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(p)) return send(res, 404, 'Not found', 'text/plain');
    file = path.join(dir, 'index.html');
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), type, noCache(p) ? { 'Cache-Control': 'no-cache' } : {});
}

// Network first, so the app stays current; the cache answers when offline.
async function serveSite(site, cache, p, res) {
  const target = sitePath(p);
  const file = safeJoin(cache, target);
  // Only ever the site's own pages: a path like //other.host/x would otherwise
  // resolve to another host and be served on the app's origin.
  const upstream = new URL(target, site);
  if (!file || target.startsWith('//') || upstream.origin !== new URL(site).origin) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const r = await fetch(upstream, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (r.ok) {
      const body = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get('content-type') || TYPES[path.extname(target)] || 'application/octet-stream';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      fs.writeFileSync(`${file}.type`, type);
      return send(res, 200, body, type, noCache(p) ? { 'Cache-Control': 'no-cache' } : {});
    }
    if (r.status === 404) return send(res, 404, 'Not found', 'text/plain');
  } catch { /* offline: fall back to the cache */ }
  if (fs.existsSync(file)) {
    const type = fs.existsSync(`${file}.type`) ? fs.readFileSync(`${file}.type`, 'utf8') : TYPES[path.extname(file)] || 'application/octet-stream';
    return send(res, 200, fs.readFileSync(file), type, { 'Cache-Control': 'no-cache' });
  }
  send(res, 502, `Could not reach ${site} and nothing is cached for ${target} yet.`, 'text/plain');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print the URL instead */ }
}

/**
 * Start the server. Resolves to { server, url, close() } once listening.
 * Used by the command below and by the tests.
 */
export async function startServe({ port = DEFAULT_PORT, app = null, device = null, site = DEFAULT_SITE, log = say } = {}) {
  if (app && !fs.existsSync(path.join(app, 'index.html'))) throw new Error(`${app} has no index.html: build the app first (npm run build)`);
  if (device) {
    await loadDevice(device);                     // fail now on a broken file, not in the browser
    reportScan(path.resolve(device), log);
  }
  const appDir = app ? path.resolve(app) : null;
  const cache = cacheRoot(site);
  const deviceFile = device ? path.resolve(device) : null;
  const listeners = new Set();
  let watcher = null;
  if (deviceFile) {
    let timer = null;
    // The folder, not the file: editors that save by writing a new file and
    // renaming it over the old one would leave a file watcher on a dead inode.
    const name = path.basename(deviceFile);
    watcher = fs.watch(path.dirname(deviceFile), (event, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        log(`device changed: ${path.basename(deviceFile)}`);
        try { reportScan(deviceFile, log); } catch { /* mid-save */ }
        for (const res of listeners) res.write('event: device\ndata: changed\n\n');
      }, 100);
    });
  }

  const server = http.createServer(async (req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (p === '/__c64rdy/info') {
      return send(res, 200, JSON.stringify({
        relay: '/relay',
        device: deviceFile ? '/__c64rdy/device.js' : null,
        events: deviceFile ? '/__c64rdy/events' : null,
      }), 'application/json', { 'Cache-Control': 'no-store' });
    }
    if (p === '/__c64rdy/device.js' && deviceFile) {
      return send(res, 200, fs.readFileSync(deviceFile), 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    if (p === '/__c64rdy/events' && deviceFile) {
      res.writeHead(200, { ...APP_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': c64rdy\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return undefined;
    }
    try {
      if (appDir) serveLocal(appDir, p, res);
      else await serveSite(site, cache, p, res);
    } catch (err) {
      if (!res.headersSent) send(res, 500, String(err.message), 'text/plain');
    }
    return undefined;
  });
  attachRelay(server, { log: (t) => log(t) });
  // Every socket, upgraded relay ones included, so close() can end them all.
  const sockets = new Set();
  server.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: on the network this would be an open relay.
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  const url = `http://localhost:${actual}/`;
  return {
    server,
    url,
    close: () => new Promise((resolve) => {
      watcher?.close();
      for (const res of listeners) res.end();
      for (const c of sockets) c.destroy();
      server.close(() => resolve());
    }),
  };
}

export async function serve(argv) {
  const { args, flags } = parseArgs(argv, {
    port: { value: true }, app: { value: true }, device: { value: true }, site: { value: true }, open: {},
  });
  if (args.length) throw new UsageError('Usage: c64rdy serve [--port N] [--app <dir>] [--device <file.js>] [--open]');
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--port takes a port number, 1 to 65535');
  const { url } = await startServe({ port, app: flags.app ?? null, device: flags.device ?? null, site: flags.site ?? DEFAULT_SITE });
  say(`C64 READY. at ${url}  (user port relay at ${url.replace('http', 'ws')}relay)`);
  say(flags.app ? `serving ${flags.app}` : `app from ${flags.site ?? DEFAULT_SITE}, cached for offline use`);
  if (flags.device) say(`user port device ${flags.device} is installed in the app and reloads when the file changes`);
  say('Ctrl+C stops it.');
  if (flags.open) openBrowser(url);
  await new Promise(() => {});                     // runs until interrupted
  return 0;
}
