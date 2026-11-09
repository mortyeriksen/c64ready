// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { buildDocs } from './tools/build-docs.mjs';
import { docsPaths } from './tools/docs-paths.mjs';
import { attachRelay } from './cli/relay.mjs';
import { createChatServer } from './server/chat.mjs';
import { createAccounts } from './server/accounts.mjs';
import { openDatabase } from './server/db.mjs';
import { gameRoutes, gameById, loadSets } from './server/games.mjs';
import { createAdminData } from './server/admin-data.mjs';
import { createAdminPasskeys } from './server/admin-passkeys.mjs';
import { createBans } from './server/bans.mjs';
import { switchOn } from './src/switches.js';

// Cross-origin isolation for the SID worklet's SharedArrayBuffer. Dev + preview only;
// the production host sends them for the first load, then src/sw.js re-stamps the
// cached navigation.
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Permissions-Policy': 'gamepad=(self)',
};

// The SID worklet runs in the AudioWorkletGlobalScope, out of HMR's reach: an
// import.meta.hot.accept boundary anywhere under it would leave the stale worklet
// executing. Force the reload, so a fresh AudioContext re-runs addModule().
const sidWorkletFullReload = {
  name: 'c64:sid-worklet-full-reload',
  hotUpdate({ file }) {
    if (!/[\\/]src[\\/]sid[\\/]sid-(worklet|voice)\.js$/.test(file)) return;
    this.environment.hot.send({ type: 'full-reload' });
    return [];   // exactly one reload, not default HMR propagation
  },
};

// docs/*.md → public/docs/*.html. buildStart fires for both dev and build, and runs
// before Vite copies publicDir into the bundle. See tools/build-docs.mjs.
const buildDocsPlugin = {
  name: 'c64:build-docs',
  async buildStart() {
    if (!switchOn('viteBuildsDocs')) return;
    const n = await buildDocs();
    if (n) this.info(`compiled ${n} doc page(s) → public/docs/`);
  },
  // buildStart fires once, so an edit would never reach the served HTML. Recompile all
  // (cheap, ~a dozen files) and full-reload; the docs aren't in the module graph.
  async hotUpdate({ file }) {
    if (this.environment.name !== 'client') return;   // rebuild once, not per-env
    if (!/[\\/]docs[\\/][^\\/]+\.md$/.test(file)) return;
    if (!switchOn('viteBuildsDocs')) return;
    const n = await buildDocs();
    this.info(`recompiled ${n} doc page(s) → public/docs/`);
    this.environment.hot.send({ type: 'full-reload' });
    return [];   // we've handled it — skip default HMR propagation
  },
  // Vite answers unknown html navigations with the app shell, so /docs/ would serve the
  // emulator. Give the static docs the host's path resolution (see public/_redirects).
  // These middlewares run before Vite's, which is what beats the SPA fallback.
  configureServer: (server) => { server.middlewares.use(docsPaths); },
  configurePreviewServer: (server) => { server.middlewares.use(docsPaths); },
};

// The user port relay (/relay/<host>/<port>) on the dev and preview servers, the
// same one `c64rdy serve` runs, so network devices work while developing.
const relayOptions = (server) => ({
  exclusive: false,
  allowLocal: switchOn('relayAllowLocal'),
  block: (t) => server.config.logger.warn(t),
});
const userportRelayPlugin = {
  name: 'c64:userport-relay',
  configureServer: (server) => { if (server.httpServer) attachRelay(server.httpServer, relayOptions(server)); },
  configurePreviewServer: (server) => { if (server.httpServer) attachRelay(server.httpServer, relayOptions(server)); },
};

// A chat server of the dev server's own (/chat), with its admin console at
// /admin. In development the app uses it (src/chat/connection.js), unless
// localStorage's c64emu.chat.server names another. Until the console has a
// passkey, a one-time setup key is made at each start and printed with the
// server's address, so a dev server reachable from the network never has a known one. There is no chat log in development.
// Accounts (/api) are kept in server/.data/c64ready.db (git-ignored), so a
// passkey made on this machine keeps working across restarts (in memory with
// the viteAccountsInMemory switch).
const chatDevPlugin = {
  name: 'c64:chat',
  configureServer: (server) => {
    if (!server.httpServer) return;
    const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server', '.data');
    let dbPath = ':memory:';
    if (!switchOn('viteAccountsInMemory')) { fs.mkdirSync(dataDir, { recursive: true }); dbPath = path.join(dataDir, 'c64ready.db'); }
    const db = openDatabase(dbPath);
    const info = (t) => server.config.logger.info(`  ${t}`);
    loadSets(db, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server', 'sets'), info);
    const bans = createBans({ db });
    // No fair-play flags on the dev server: guide shots and local play post results straight away.
    const accounts = createAccounts({ db, allowLoopback: true, extend: (ctx) => gameRoutes({ ...ctx, fairPlay: false }), log: info, bans, onDeleted: (uid) => chat.dropAccount(uid) });
    const adminPasskeys = createAdminPasskeys({ db });
    const chat = createChatServer({
      allowLoopback: true,
      // The console signs in with a passkey: the first is set up with the key shown below.
      admin: { passkeys: adminPasskeys, keyUsed: adminPasskeys.keyUsed, useKey: adminPasskeys.useKey },
      adminData: createAdminData({ db, accounts, bans }),
      bans,
      authenticate: (token) => accounts.userForToken(token),
      findGame: (id) => gameById(db, id),
      removePicture: (uid) => accounts.removePicture(uid),
      log: (t) => server.config.logger.warn(t),
    });
    const setupKey = chat.adminSetupKey();
    server.middlewares.use((req, res, next) => {
      if ((req.url || '').startsWith('/api/') && accounts.handleRequest(req, res)) return;
      if (!(req.url || '').startsWith('/admin') || !chat.handleRequest(req, res)) next();
    });
    server.httpServer.on('upgrade', (req, sock, head) => { chat.handleUpgrade(req, sock, head); });
    server.httpServer.on('close', () => { chat.close(); accounts.close(); });
    server.httpServer.once('listening', () => {
      server.config.logger.info(setupKey ? `  chat admin: /admin  (set up a passkey with the key ${setupKey})` : '  chat admin: /admin  (sign in with your admin passkey)');
    });
  },
};

export default defineConfig({
  server: { headers: COI_HEADERS },
  preview: { headers: COI_HEADERS },
  // One copy of three, or the dev optimizer reports "Multiple instances of Three.js".
  // It stays lazy (only the dynamic pausedemo/retrovibes import pulls it), so no
  // optimizeDeps entry: that would pre-bundle it at dev-server startup.
  resolve: { dedupe: ['three'] },
  build: {
    // three.js is a ~560 kB lazy vendor chunk we can't split further; our own main
    // chunk is ~330 kB. Lift the 500 kB nag past three, still catch new bloat.
    chunkSizeWarningLimit: 700,
  },
  plugins: [
    buildDocsPlugin,
    userportRelayPlugin,
    chatDevPlugin,
    sidWorkletFullReload,
    VitePWA({
      strategies: 'injectManifest',   // custom SW (src/sw.js) — needed for COI header re-stamping
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'prompt',         // new SW waits; we surface a Reload toast (onNeedRefresh in main.js)
      injectRegister: false,          // we register via virtual:pwa-register in main.js
      injectManifest: {
        // The app shell. .ttf is load-bearing: the licensed C64 faces ship as .ttf, and
        // without them an offline install falls back to system fonts. No jpg, because
        // every one belongs to the splash (see the splash ignores below).
        globPatterns: ['**/*.{js,css,html,woff2,ttf,png,webp,svg,webmanifest}'],
        globIgnores: [
          // User-provided copyrighted blobs, even if a /roms/ dir exists at build time.
          '**/roms/**',
          // Docs-only and huge; runtime-cached on first view (see /guide/ in src/sw.js).
          '**/guide/**',
          // The 3D assets (models, lightmaps, light probes): runtime-cached in
          // the model bucket (see src/sw.js), only for viewers who open Retro Vibes.
          '**/models/**',
          // Splash art and the teaser loop: the splash shows once, on a first visit,
          // which is online by definition.
          '**/screens/splash-*',
          '**/media/**',
          '**/logos/c64ready-logo.png',
          '**/logos/c64ready-logo-tagline.png',   // brand-shots.mjs input, no page loads it
          // Link-preview cards and README art: ~7 MB the app itself never displays.
          // Matched on the stem, since they ship as both .png and .webp.
          '**/c64rdy-3d-vibes*',
          '**/c64rdy-emulator*',
          // Network-only analytics markers (see ANALYTICS_MARKERS in src/sw.js).
          '**/pwa.html',
          '**/pwa-installed.html',
          '**/roms-loaded.html',
          '**/roms-vice.html',
          '**/roms-fetched.html',
          '**/returned.html',
          '**/rom-sources.json',
          '**/roms-theme-classic.html',
          '**/roms-theme-geos.html',
          '**/roms-theme-breadbin.html',
          '**/roms-theme-phosphor.html',
          '**/roms-theme-outrun.html',
          '**/roms-theme-commando.html',
          '**/roms-theme-artdeco.html',
          '**/roms-theme-lookout.html',
          '**/roms-theme-custom.html',
        ],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024, // three.js chunk headroom
      },
      manifest: {
        name: 'C64 READY',
        short_name: 'C64 READY.',
        description: 'Serious emulation, retro vibes. A Commodore 64 emulator in your browser.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',   // follow the device's rotation, not locked landscape
        background_color: '#020008',
        theme_color: '#020008',
        icons: [
          // ?v= bumped on artwork changes so Chrome re-reads the manifest (its icon
          // snapshot is keyed by src URL). Keep in sync with index.html and
          // tools/build-docs.mjs; a test pins the three together.
          { src: '/icons/icon-192.png?v=3', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png?v=3', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png?v=3', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: false,   // keep the SW out of dev; test offline via build + preview
      },
    }),
  ],
});
