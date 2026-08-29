// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/sw.js — custom service worker (vite-plugin-pwa `injectManifest` mode).
//
// Two jobs:
//   1. Precache the built app shell (JS/CSS/HTML/fonts/icons/SID worklet) so
//      the emulator loads and runs with no network.
//   2. Re-stamp Cross-Origin-Opener/Embedder-Policy onto the navigation
//      response. The emulator's audio path uses SharedArrayBuffer, which only
//      exists when the page is cross-origin isolated — and isolation is decided
//      by the *document* response headers. When that document is served from
//      cache offline, the headers come from us, not the host, so we must add
//      them back or audio silently dies.
//
// User content is deliberately NOT cached here: ROMs stay in localStorage and
// media stays in IndexedDB (their existing caches). /roms/ requests are passed
// straight through so roms.js keeps its localStorage → fetch → upload fallback.

import { precache, matchPrecache } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

// Populate + clean up the precache (install/activate handlers). We use
// precache() rather than precacheAndRoute() so Workbox does NOT install its own
// fetch route — we serve everything from our own handler below so we can attach
// the cross-origin-isolation headers.
precache(self.__WB_MANIFEST);

// Runtime caches (see the fetch handler below): the lazy-loaded 3D-viewer model
// GLBs, and the guide screenshots the docs embed. Versioned so bumping a suffix
// drops stale copies on activate.
const MODEL_CACHE = 'c64emu-models-v1';
const GUIDE_CACHE = 'c64emu-guide-v1';
const RUNTIME_CACHES = [MODEL_CACHE, GUIDE_CACHE];

// Network-only analytics markers (empty pages in public/, beacons in main.js).
// Keep in sync with the matching globIgnores in vite.config.js; a marker that
// lands in the precache is answered from cache and never reaches the host.
const ANALYTICS_MARKERS = new Set(
  ['/pwa.html', '/pwa-installed.html', '/roms-loaded.html', '/roms-vice.html']);

// Prompt-to-update flow: a new SW installs and WAITS (note: NO unconditional
// skipWaiting on install) so it never swaps code out from under a running
// session. The client (main.js registerSW 'prompt') surfaces a Reload toast; on
// accept it posts SKIP_WAITING (handled below), the new SW activates, and the
// page reloads into the new build. clientsClaim still lets the FIRST install
// control the already-loaded page (so offline works without a manual reload);
// on an update it takes effect only once the user-accepted skipWaiting fires.
clientsClaim();

// Drop superseded runtime caches (e.g. after MODEL_CACHE is bumped) so a stale
// GLB or screenshot can't linger once the app has moved to a new cache version.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => /^c64emu-(models|guide)-/.test(n) && !RUNTIME_CACHES.includes(n))
        .map((n) => caches.delete(n)),
    );
  })());
});

// Prompt-flow update trigger: updateSW(true) (main.js, on the Reload toast)
// posts SKIP_WAITING to the waiting SW; skipWaiting() then lets it activate and
// the page reload into the new build.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Return a copy of `resp` with the cross-origin-isolation headers re-applied.
// COOP/COEP on the document keep SharedArrayBuffer alive offline. CORP matters
// for SUBRESOURCES: under COEP require-corp, a response provided by a service
// worker must carry Cross-Origin-Resource-Policy to be embeddable. We MUST use
// `cross-origin` (not `same-origin`): reconstructing the response below gives it
// an empty URL → opaque origin, so a `same-origin` CORP check fails and blocks
// the resource — most visibly the AudioWorklet module ("Unable to load a
// worklet's module" → no SID sound). `cross-origin` is permissive and passes
// regardless of the (now-opaque) response origin.
function withCoiHeaders(resp) {
  if (!resp || resp.status === 0) return resp;      // opaque — can't rewrite, leave as-is
  const headers = new Headers(resp.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Permissions-Policy', 'gamepad=(self)');
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle our own origin; let anything cross-origin go to the network.
  if (url.origin !== self.location.origin) return;

  // ROMs: never intercept. Offline this fails and roms.js falls back to its
  // localStorage cache or the upload prompt — exactly the existing behaviour.
  if (url.pathname.startsWith('/roms/')) return;

  // Analytics markers — installed launch (/pwa.html, every launch), new install
  // (/pwa-installed.html), and ROM setup (/roms-loaded.html, /roms-vice.html),
  // each once per browser. Never intercept: let them go straight to the network
  // so Netlify's server-side log records the page view rather than the SW
  // answering from cache. None are precached (vite.config globIgnores); offline
  // they just fail silently.
  if (ANALYTICS_MARKERS.has(url.pathname)) return;

  // AudioWorklet module: network-FIRST. Returning a reconstructed/cached SW
  // response for it fails under COEP ("Unable to load a worklet's module" → no
  // SID sound). A direct same-origin network response is COEP-exempt and loads
  // exactly as it did before the SW existed, so prefer the network and only
  // fall back to cache when offline. We return the network response UNMODIFIED
  // (no header rewrite) so it keeps its real same-origin URL.
  if (/sid-worklet.*\.js$/.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await matchPrecache(request.url);
        return cached ? withCoiHeaders(cached) : new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 3D-viewer model GLBs (Retro Vibes): large, immutable, and lazy-loaded, so
  // they are deliberately kept OUT of the precache (not in globPatterns). Cache
  // them at RUNTIME instead — CacheFirst: fetch from network the first time the
  // viewer is opened, stash a copy in a dedicated Cache Storage bucket, then
  // serve every later open (and offline) from cache with no re-download. Only a
  // complete 200 is cached (never an opaque/partial/errored response). CORP is
  // re-applied on serve so the model stays embeddable under COEP require-corp.
  // NOTE: the filenames are unversioned (commodore_64*.glb) — if a model asset
  // is ever replaced, bump MODEL_CACHE below so clients drop the stale copy.
  // Guide screenshots (/guide/*): only the docs embed them, and they outweigh the
  // whole rest of the app, so they are kept OUT of the precache too (globIgnores)
  // and cached the same way — the first docs page that shows one pays for it, and
  // it is offline from then on. Bump GUIDE_CACHE when a shot is replaced, since
  // the filenames are stable (tools/guide-shots.mjs overwrites them in place).
  if (/\.glb$/i.test(url.pathname) || url.pathname.startsWith('/guide/')) {
    const bucket = url.pathname.startsWith('/guide/') ? GUIDE_CACHE : MODEL_CACHE;
    event.respondWith((async () => {
      const cache = await caches.open(bucket);
      const hit = await cache.match(request);
      if (hit) return withCoiHeaders(hit);
      try {
        const resp = await fetch(request);
        if (resp && resp.status === 200) cache.put(request, resp.clone()).catch(() => {});
        return withCoiHeaders(resp);
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  // The compiled docs are REAL static pages, not app-shell SPA routes: they must
  // fall through to the cache-first handler below, which serves the precached
  // docs page, rather than being answered with the emulator shell.
  const isDocsPage = url.pathname.startsWith('/docs/');

  // Real static files (robots.txt, sitemap.xml, .well-known probes, .ico, …) must
  // be served as themselves, not swallowed by the SPA-shell branch below. A
  // browser or bot opening /robots.txt fetches it as a top-level navigation
  // (request.mode === 'navigate'), which would otherwise be answered with
  // index.html — the file "not being served". Any path with a non-.html file
  // extension is such a static asset; let it fall through to the cache/network
  // handler (which returns the real file, or the precached copy offline).
  const isStaticFile = /\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith('.html');

  // The app-shell document — real navigations AND any request for the root or
  // index.html, e.g. the browser's installability probe of start_url ("/").
  // Routing all of these to the precached index.html (with COOP/COEP re-applied)
  // keeps the page cross-origin isolated offline and lets start_url resolve, so
  // the installability check passes and Chrome offers the install prompt.
  const isDocument =
    !isDocsPage && !isStaticFile && (
      request.mode === 'navigate' ||
      request.destination === 'document' ||
      url.pathname === '/' ||
      url.pathname === '/index.html');

  if (isDocument) {
    event.respondWith((async () => {
      const shell =
        (await matchPrecache('index.html')) || (await matchPrecache('/index.html'));
      if (shell) return withCoiHeaders(shell);
      try {
        return withCoiHeaders(await fetch(request));
      } catch {
        return new Response('Offline — open this app once while online to install it.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    })());
    return;
  }

  // Everything else (JS/CSS/fonts/icons/worklet): cache-first, network fallback,
  // with CORP re-applied so SW-served subresources stay embeddable under COEP
  // (the AudioWorklet module in particular). Never resolve with an error-type
  // response — that surfaces as a console "network error" and can trip the
  // installability check; use a plain 504.
  event.respondWith((async () => {
    let cached = await matchPrecache(request.url);
    // Cache-busted URLs (/docs/docs.css?v=<hash>, /favicon.svg?v=2) are keyed in
    // the precache by their bare path. The query is what makes a client on the
    // PREVIOUS service worker miss and pull the fresh file from the network.
    if (!cached && url.search) cached = await matchPrecache(url.origin + url.pathname);
    // The precache is keyed by the FILE the build wrote, while a docs page is
    // reachable at two spellings the host resolves for us: /docs/ (the directory)
    // and /docs/about (no extension — what Netlify's Pretty URLs rewrites our
    // links to). Resolve both, or a page that is sitting in the precache is served
    // from the network anyway and the docs stop working offline.
    if (!cached && url.pathname.endsWith('/')) {
      cached = await matchPrecache(`${url.origin}${url.pathname}index.html`);
    } else if (!cached && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      cached = await matchPrecache(`${url.origin}${url.pathname}.html`);
    }
    if (cached) return withCoiHeaders(cached);
    try {
      return withCoiHeaders(await fetch(request));
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
