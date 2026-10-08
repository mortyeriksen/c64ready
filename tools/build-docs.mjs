// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Build step: compile docs/*.md into styled HTML under public/docs/.
//
// Produces:
//   public/docs/<NAME>.html   — one page per markdown source
//   public/docs/index.html    — landing page: emulator overview + links to all
//   public/docs/docs.css      — shared stylesheet (C64-READY. dark theme)
//   public/sitemap.xml        — canonical app + generated documentation URLs
//
// Runs both from Vite (see the c64:build-docs plugin in vite.config.js, which
// calls buildDocs() on buildStart for dev + production build) and standalone
// via `npm run build:docs`. Generated docs live under public/docs/, which is
// git-ignored; the .md files under docs/ are the source of truth.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { USER_GUIDE_ANCHORS } from './user-guide-anchors.mjs';
import { marked } from 'marked';
import { VERSION } from '../src/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS_SRC = join(ROOT, 'docs');
const DOCS_OUT = join(ROOT, 'public', 'docs');
const SITEMAP_OUT = join(ROOT, 'public', 'sitemap.xml');
const INDEX_OVERVIEW_FILE = 'DOCS-OVERVIEW.md';
const SITE_URL = 'https://c64ready.com';
// Matches index.html's og:image so a doc link and the landing page preview the
// same picture. Every superseded -sm*.png stays on disk deliberately: links
// shared before a bump still resolve to the exact image they were shared with,
// which a redirect to the new one would silently alter.
const SOCIAL_IMAGE_URL = `${SITE_URL}/c64rdy-3d-vibes-sm-v4.png`;
const SOCIAL_IMAGE_ALT = 'The Commodore 64, 1541 disk drive and 1702 monitor under a single overhead spotlight in a dark room, the BASIC READY screen lighting the CRT.';
const DOCS_DEFAULT_DESC = 'Guides, architecture notes, specifications, and credits for C64 READY., a cycle-accurate Commodore 64 emulator in your browser.';

// Preferred presentation order: overview first, then subsystem docs, then the
// perf notes. Anything not listed here is appended alphabetically, so a new
// docs/*.md shows up automatically without touching this list.
const ORDER = [
  'WHATS-NEW',
  'ABOUT',
  'GETTING-STARTED',
  'USER-GUIDE',
  'GUIDE-INTERFACE',
  'GUIDE-MEDIA',
  'GUIDE-INPUT',
  'GUIDE-LOOKS',
  'GUIDE-OPTIONS',
  'GUIDE-CLI',
  'SPECIFICATIONS',
  'FEATURES',
  'KNOWN-ISSUES',
  'TAPE-RESTORATION',
  'C64READY-AND-VICE',
  'COMPONENT-STATUS',
  'ARCHITECTURE',
  'MACHINE-ARCHITECTURE',
  'CPU-ARCHITECTURE',
  'VIC2-ARCHITECTURE',
  'SID-ARCHITECTURE',
  'MEMORY-ARCHITECTURE',
  'DRIVE-ARCHITECTURE',
  'DATASETTE-ARCHITECTURE',
  'RETROVIBES-ARCHITECTURE',
  'PERFORMANCE-ANALYSIS',
];

// Docs that are guides / overviews for *using* the emulator (plus the
// specifications & credits reference) rather than chip-by-chip internals. These
// lead the landing page in their own "Overview & guides" band; everything else
// falls into the "Architecture & internals" grid.
const GUIDES = new Set([
  'WHATS-NEW', 'GETTING-STARTED', 'USER-GUIDE', 'TAPE-RESTORATION', 'C64READY-AND-VICE', 'FEATURES',
  'KNOWN-ISSUES', 'SPECIFICATIONS', 'ABOUT',
]);

// The User Guide is a hub (USER-GUIDE.md) and these topic pages, in reading
// order. Each gets a "User Guide" breadcrumb and previous/next links, and all
// of them share a left menu listing the guide's pages (renderGuideNav).
const GUIDE_PAGES = ['GUIDE-INTERFACE', 'GUIDE-MEDIA', 'GUIDE-INPUT', 'GUIDE-LOOKS', 'GUIDE-OPTIONS', 'GUIDE-CLI'];

// Sources kept only so an old link to the file (GitHub, the CLI's published
// README) still says where it went; they are not built into pages. Their old
// page URLs redirect in public/_redirects.
const MOVED_SOURCES = new Set(['USER-GUIDE-CLI.md']);

// The guide was one page; a link to a heading that moved to a topic page
// (bookmarks, other sites, older release notes) is sent on to it by a small
// script on the hub. Old heading id → new page and id.
const GUIDE_REDIRECTS = USER_GUIDE_ANCHORS;

// Hand-written teasers for specific landing-page cards, overriding the
// auto-extracted first paragraph. Keyed by the lowercase basename (card href).
// These cards lead the Guides band, so they get short, purpose-built lines
// rather than the truncated opening sentence of the page.
const CARD_TEASERS = {
  'whats-new': 'What changed in each release, in plain language.',
  specifications: 'The hardware references, tools, and people this emulator is built on.',
  about: "What it is, what it stands for, and who's behind it.",
  'user-guide': 'Every panel, dialog and button, in topics from the interface and media to options and the command line.',
  'tape-restoration': 'How a worn cassette becomes a tape that loads again.',
  'c64ready-and-vice': 'How the two emulators differ, and which one suits what you want to do.',
};

const TEXT_DOCS = [
  { srcRel: 'LICENSE', href: 'license', title: 'License (GPL-3.0-or-later)',
    desc: 'The GNU General Public License, version 3 or later, that C64 READY. is released under, in full.' },
  { srcRel: 'NOTICE.txt', href: 'notice', title: 'Third-party notices',
    desc: 'Third-party notices for C64 READY.: the code, fonts and models it includes from others, and their licenses.' },
];

// Each doc names its own search and share description in a comment under its
// licence header, <!-- description: ... -->; test/docs-meta-spec-test.js keeps
// them whole sentences of a preview's length.
const DESCRIPTION = /^<!--\s*description:\s*([\s\S]*?)\s*-->\s*/;
// A page may name its share picture on the line after, <!-- share-image:
// /guide/name.webp -->, where its first picture is not the one: an SVG diagram,
// which link previews do not show, names a raster copy of itself. Its alt text
// is the page's own for the picture of the same name.
const SHARE_IMAGE = /^<!--\s*share-image:\s*(\/\S+)\s*-->\s*/;

// A page's share image: its first picture in a landscape shape a preview card
// shows whole (width 1.2 to 2 times the height). A page without one uses the
// site's card. Sizes come from the file headers, so nothing is decoded.
const SHARE_RATIO = [1.2, 2];
function imageSize(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
function namedShareImage(md, src) {
  const file = join(ROOT, 'public', src);
  const size = existsSync(file) && imageSize(file);
  if (!size) throw new Error(`share-image ${src}: no such raster picture in public/`);
  const stem = src.replace(/\.[a-z]+$/i, '');
  const same = [...md.matchAll(/!\[([^\]]*)\]\((\/[^)\s]+)\)/g)].find(([, , s]) => s.replace(/\.[a-z]+$/i, '') === stem);
  return { url: absoluteUrl(src), alt: same ? same[1] : '', ...size };
}
function shareImage(md) {
  for (const [, alt, src] of md.matchAll(/!\[([^\]]*)\]\((\/[^)\s]+)\)/g)) {
    const file = join(ROOT, 'public', src);
    if (!existsSync(file)) continue;
    const size = imageSize(file);
    if (!size) continue;
    const ratio = size.width / size.height;
    if (ratio >= SHARE_RATIO[0] && ratio <= SHARE_RATIO[1]) return { url: absoluteUrl(src), alt, ...size };
  }
  return null;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'section';

// Decode the handful of entities marked emits, so text pulled back out of its
// HTML (for slugs + the TOC) is clean before we re-escape it for display.
const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#3?9;/g, "'");

// Strip inline markdown down to plain text (for <title>, card blurbs, TOC).
const stripInline = (s) =>
  s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

const prettyName = (name) =>
  name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const absoluteUrl = (path) => `${SITE_URL}${path}`;

// Sitemap last-modified dates come from source history rather than filesystem
// mtimes, which are reset by a fresh Netlify checkout. Dirty sources use the
// current date because their next generated output includes those changes.
// If Git history is unavailable, omit lastmod instead of publishing a guess.
//
// The sitemap dates one URL per doc source, plus one for the app itself. Asking
// git per entry meant two process spawns each, ~46 in all, which was most of the
// time this build step took; three calls now answer everything. The app set is
// deliberately aggregate-only: walking src/ per file cost more than the rest of
// the docs build put together, for dates the sitemap never shows separately.
const DOC_SOURCE_PATHS = ['docs', 'LICENSE', 'NOTICE.txt'];
const APP_SOURCE_PATHS = ['index.html', 'src', 'package.json', 'vite.config.js'];

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;   // no git, or not a repo — callers fall back to no lastmod
  }
};

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// { dirty: Set<path>, dates: Map<docSourcePath, date>, appDate }.
function sourceHistory() {
  const dirty = new Set();
  const status = git(['status', '--porcelain', '--', ...DOC_SOURCE_PATHS, ...APP_SOURCE_PATHS]);
  for (const line of (status || '').split('\n')) {
    // "XY path", or "XY old -> new" for a rename: the new name is what counts.
    const path = line.slice(3).trim().split(' -> ').pop().replace(/^"|"$/g, '');
    if (path) dirty.add(path);
  }
  // `git log` is newest-first, so a file's first mention is its last change.
  const dates = new Map();
  let date;
  for (const line of (git(['log', '--format=@%cs', '--name-only', '--', ...DOC_SOURCE_PATHS]) || '').split('\n')) {
    if (line.startsWith('@')) { date = isDate(line.slice(1)) ? line.slice(1) : undefined; continue; }
    const file = line.trim();
    if (file && date && !dates.has(file)) dates.set(file, date);
  }
  const appDate = (git(['log', '-1', '--format=%cs', '--', ...APP_SOURCE_PATHS]) || '').trim();
  return { dirty, dates, appDate: isDate(appDate) ? appDate : undefined };
}

const _under = (path, base) => path === base || path.startsWith(`${base}/`);

// Newest change date across `paths` (files or directories), or today if any of
// them is dirty in the working tree.
function sourceLastmod(history, ...paths) {
  const matches = (p) => paths.some((base) => _under(p, base));
  for (const path of history.dirty) if (matches(path)) return today();
  let newest;
  for (const [file, date] of history.dates) {
    if (matches(file) && (!newest || date > newest)) newest = date;
  }
  return newest;
}

// The app-shell date, for the sitemap's "/" entry.
function appLastmod(history) {
  for (const path of history.dirty) if (APP_SOURCE_PATHS.some((base) => _under(path, base))) return today();
  return history.appDate;
}

// Pull a title (first H1) and a one-line blurb (first prose paragraph) from the
// raw markdown, skipping headings, code fences, tables, lists and blockquotes.
function extractMeta(md, fallbackName) {
  const lines = md.split('\n');
  let title = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^#\s+(.*)$/.exec(lines[i].trim());
    if (m) { title = stripInline(m[1]); i++; break; }
  }
  let desc = '';
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^#{1,6}\s/.test(l)) continue;
    if (/^(```|~~~)/.test(l)) {
      i++;
      while (i < lines.length && !/^(```|~~~)/.test(lines[i].trim())) i++;
      continue;
    }
    if (/^[|>]/.test(l) || /^[-*+]\s/.test(l) || /^\d+\.\s/.test(l) || /^-{3,}$/.test(l)) continue;
    desc = stripInline(l);
    break;
  }
  if (desc.length > 200) desc = desc.slice(0, 197).replace(/\s+\S*$/, '') + '…';
  return { title: title || prettyName(fallbackName), desc };
}

// Add stable ids to headings (for anchor links) and collect an on-this-page TOC
// from the h2/h3 levels. Version-independent: post-processes marked's output.
function addAnchorsAndToc(html) {
  const toc = [];
  const used = new Set();
  const out = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
    const base = slug(text);
    let id = base, n = 1;
    while (used.has(id)) id = `${base}-${++n}`;
    used.add(id);
    const lvl = Number(level);
    if (lvl === 2 || lvl === 3) toc.push({ level: lvl, id, text });
    // The # link is for pointing and copying; hidden from assistive tech, so
    // it stays out of the Tab order too.
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a></h${level}>`;
  });
  return { html: out, toc };
}

// Keyboard and screen-reader fixes on marked's output: a code block that may
// scroll sideways takes focus so the keyboard can scroll it, and an empty table
// header cell (a corner over a row-label column) is a plain cell.
const accessibleMarkup = (html) => html
  .replace(/<pre>/g, '<pre tabindex="0">')
  .replace(/<th>(\s*)<\/th>/g, '<td>$1</td>')
  .replace(/<th align="(\w+)">(\s*)<\/th>/g, '<td align="$1">$2</td>');

// Rewrite sibling links that point at the .md sources to the compiled .html.
// Output filenames are lowercased (see buildDocs), so lowercase the link target
// too — a `[x](CPU-ARCHITECTURE.md)` becomes `cpu-architecture.html`.
const rewriteDocLinks = (html) =>
  html.replace(/(<a\s[^>]*href=")([^":]+?)\.md((?:#[^"]*)?")/g,
    (_m, p1, p2, p3) => `${p1}${p2.toLowerCase()}.html${p3}`);

// The in-app About dialog (the credits modal in index.html) shows the SAME copy
// as the About page — fetched at runtime — so it is authored once, in ABOUT.md.
// Emit a bare, chrome-less fragment for it: the compiled body with the page's own
// <h1> removed (the modal supplies its own "ABOUT" header). Only off-site links
// open a new tab; internal /docs/ links navigate in place. The
// credits-link-inline class matches the modal's link style, so the fragment drops
// straight in where the old hardcoded markup was.
function writeAboutFragment(bodyHtml) {
  const licenseComment =
    '<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<!-- Copyright © 2026 Morten Øien Eriksen -->\n';
  // The dialog has its own title, so the page's sections sit a level lower.
  const fragment = licenseComment + bodyHtml
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, '')
    .replace(/<(\/?)h2\b/g, '<$1h3')
    .replace(/<a href="([^"]*)"/g, (_m, href) => {
      const offsite = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener"' : '';
      return `<a class="credits-link-inline"${offsite} href="${href}"`;
    });
  writeFileSync(join(DOCS_OUT, 'about-fragment.html'), fragment);
}

// The left menu of the User Guide's pages: the hub and every topic page, the
// one shown marked as current with its own sections listed beneath it.
function renderGuideNav(name, toc) {
  const pages = [['USER-GUIDE', 'Overview'], ...GUIDE_PAGES.map((n) => [n, guideTitle(n)])];
  const sections = (indent) => toc.filter((t) => t.text !== 'Topics')
    .map((t) => `${indent}<li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join('\n');
  const items = pages.map(([n, label]) => {
    const href = `/docs/${n.toLowerCase()}.html`;
    if (n !== name) return `          <li class="guide-doc"><a href="${href}">${escapeHtml(label)}</a></li>`;
    const subs = sections('              ');
    return `          <li class="guide-doc current"><a href="${href}" aria-current="page">${escapeHtml(label)}</a>${subs ? `
            <ul>
${subs}
            </ul>
          ` : ''}</li>`;
  }).join('\n');
  return `      <nav class="doc-toc guide-nav" aria-label="User Guide">
        <div class="toc-title"><a href="/docs/user-guide.html">User Guide</a></div>
        <ul>
${items}
        </ul>
      </nav>`;
}

function renderToc(toc) {
  if (toc.length < 2) return '';
  const items = toc
    .map((t) => `        <li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
    .join('\n');
  return `      <nav class="doc-toc" aria-label="On this page">
        <div class="toc-title">On this page</div>
        <ul>
${items}
        </ul>
      </nav>`;
}

// The C64 READY. wordmark — mirrors the app header: an ANSI shade ramp (█▓▒░)
// then "C64" (near-white glow) + "READY." (accent) in the PetMe64 system font.
const LOGO =
  '<span class="logo-text">' +
  '<span class="lt-blocks"><span class="b4">█</span><span class="b3">▓</span><span class="b2">▒</span><span class="b1">░</span></span>' +
  '<span class="lt-main"><span class="lt-c64">C64</span> <span class="lt-ready">READY.</span></span>' +
  '</span>';

function head(title, page = {}) {
  const desc = page.desc || DOCS_DEFAULT_DESC;
  const image = page.image || { url: SOCIAL_IMAGE_URL, width: 1200, height: 630, alt: SOCIAL_IMAGE_ALT };
  const url = absoluteUrl(page.path || '/docs/');
  return `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:site_name" content="C64 READY.">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:image" content="${escapeHtml(image.url)}">
  <meta property="og:image:width" content="${image.width}">
  <meta property="og:image:height" content="${image.height}">
  <meta property="og:image:alt" content="${escapeHtml(image.alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${escapeHtml(image.url)}">
  <meta name="twitter:image:alt" content="${escapeHtml(image.alt)}">
  <!-- Same icon set and ?v= as index.html; the icons live under /icons/. -->
  <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg?v=3">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png?v=3">
  <link rel="apple-touch-icon" href="/icons/favicon-180.png?v=3">
  <script>${APPEARANCE_PREPAINT}</script>
  <link rel="stylesheet" href="/fonts/fonts.css">
  <link rel="stylesheet" href="/docs/docs.css?v=${CSS_VERSION}">
</head>
<body>`;
}

// The CTA stays INSIDE .top-nav: an installed client can be offline on an older
// precached stylesheet, which only paints a .cta that sits in the nav. The
// .nav-links box holds the links so phones can drop them in one rule while the
// pill stays.
// Same three controls, and the same look, as the emulator's own header — see the
// .credits-link / .icon-link rules in src/styles/styles-header.css.
const GITHUB_SVG =
  '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
const YOUTUBE_SVG =
  '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.007 2.007 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.007 2.007 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31.4 31.4 0 0 1 0 7.68v-.123c.002-.215.01-.958.064-1.778l.007-.103.003-.052.008-.104.022-.26.01-.104c.048-.519.119-1.023.22-1.402a2.007 2.007 0 0 1 1.415-1.42c.487-.13 1.544-.21 2.654-.26l.17-.007.172-.006.086-.003.171-.007A99.788 99.788 0 0 1 7.858 2h.193zM6.4 5.209v4.818l4.157-2.408z"/></svg>';
const FACEBOOK_SVG =
  '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M16 8.05C16 3.6 12.42 0 8 0S0 3.6 0 8.05C0 12.07 2.93 15.4 6.75 16v-5.61H4.72V8.05h2.03V6.28c0-2.02 1.2-3.13 3.02-3.13.87 0 1.79.16 1.79.16v1.98h-1.01c-.99 0-1.3.62-1.3 1.26v1.5h2.22l-.36 2.34H9.25V16C13.07 15.4 16 12.07 16 8.05Z"/></svg>';

// Dark, light or the system's: the emulator's setting (c64emu.appearance), read
// before first paint and cycled by the top bar's button in the emulator's
// order. These mirror src/ui/appearance.js (APPEARANCE_KEY, nextAppearance and
// its icons); test/appearance-spec-test.js checks that the two agree.
const APPEARANCE_PREPAINT = `(function () {
    var a = null, dark = true;
    try { a = localStorage.getItem('c64emu.appearance'); } catch (e) {}
    try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
    var mode = a === 'dark' || a === 'light' ? a : (dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-mode', mode);
    document.documentElement.style.colorScheme = mode;
  })();`;
const APPEARANCE_BUTTON = `(function () {
    var KEY = 'c64emu.appearance';
    var ICONS = {
      dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
      light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      system: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'
    };
    var LABELS = { dark: 'Dark', light: 'Light', system: 'System' };
    var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var osDark = function () { return query ? query.matches : true; };
    var read = function () { var a = null; try { a = localStorage.getItem(KEY); } catch (e) {} return a === 'dark' || a === 'light' ? a : 'system'; };
    function docsNext(now, systemPrefersDark) {
      var os = systemPrefersDark ? 'dark' : 'light', other = systemPrefersDark ? 'light' : 'dark';
      return now === 'system' ? other : now === other ? os : 'system';
    }
    var btn = document.getElementById('appearance-btn');
    var appearance = read();
    function apply() {
      var mode = appearance === 'system' ? (osDark() ? 'dark' : 'light') : appearance;
      document.documentElement.setAttribute('data-mode', mode);
      document.documentElement.style.colorScheme = mode;
      if (!btn) return;
      var next = docsNext(appearance, osDark());
      btn.querySelector('svg').innerHTML = ICONS[appearance];
      var label = 'Appearance: ' + LABELS[appearance] + '. Switch to ' + LABELS[next].toLowerCase();
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    if (btn) btn.addEventListener('click', function () {
      appearance = docsNext(appearance, osDark());
      try { if (appearance === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, appearance); } catch (e) {}
      apply();
    });
    if (query && query.addEventListener) query.addEventListener('change', apply);
    window.addEventListener('storage', function (e) { if (e.key === KEY) { appearance = read(); apply(); } });
    apply();
  })();`;

const topbar = `  <header class="doc-top">
    <a class="brand" href="/docs/" aria-label="C64 READY. docs home">${LOGO}</a>
    <nav class="top-nav">
      <span class="nav-links">
        <button class="nav-btn nav-icon appearance-btn" id="appearance-btn" type="button"
          aria-label="Appearance"><svg viewBox="0 0 24 24" width="17" height="17" fill="none"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true" focusable="false"></svg></button>
        <a class="nav-btn" href="/docs/about.html">ABOUT</a>
        <a class="nav-btn nav-icon" href="https://github.com/mortyeriksen/c64ready"
          target="_blank" rel="noopener" title="Source code on GitHub"
          aria-label="Source code on GitHub">${GITHUB_SVG}</a>
        <a class="nav-btn nav-icon" href="https://www.youtube.com/@c64ready"
          target="_blank" rel="noopener" title="C64 READY. on YouTube"
          aria-label="C64 READY. on YouTube">${YOUTUBE_SVG}</a>
        <a class="nav-btn nav-icon" href="https://www.facebook.com/c64ready"
          target="_blank" rel="noopener" title="C64 READY. on Facebook"
          aria-label="C64 READY. on Facebook">${FACEBOOK_SVG}</a>
      </span>
      <a class="cta" href="/">Launch emulator ▸</a>
    </nav>
  </header>`;

const foot = `  <footer class="doc-foot">
    <span>C64 READY. — serious emulation, retro vibes.</span>
    <span>© 2026 Morten Øien Eriksen · <a href="/docs/whats-new.html"
      title="What changed in each release">v${VERSION}</a> · GPL-3.0-or-later</span>
  </footer>
  <script>${APPEARANCE_BUTTON}</script>
</body>
</html>`;

// A topic page's title, from its H1.
const guideTitle = (name) => extractMeta(readFileSync(join(DOCS_SRC, `${name}.md`), 'utf8'), name).title;

// Previous / next links between the User Guide's topic pages, the hub at
// either end.
function guidePager(name) {
  const i = GUIDE_PAGES.indexOf(name);
  const link = (n, rel) => {
    const [href, label] = n ? [`/docs/${n.toLowerCase()}.html`, guideTitle(n)] : ['/docs/user-guide.html', 'User Guide'];
    return `<a class="guide-pager-${rel}" href="${href}">${rel === 'prev' ? '‹ ' : ''}${escapeHtml(label)}${rel === 'next' ? ' ›' : ''}</a>`;
  };
  return `      <nav class="guide-pager" aria-label="User Guide pages">${link(GUIDE_PAGES[i - 1], 'prev')}${link(GUIDE_PAGES[i + 1], 'next')}</nav>`;
}

// On the hub: send a link to a heading that has moved on to its topic page.
const guideRedirectScript = () => `  <script>
    (function () {
      var moved = ${JSON.stringify(GUIDE_REDIRECTS)};
      function go() {
        var id = decodeURIComponent(location.hash.slice(1));
        if (id && !document.getElementById(id) && moved[id]) location.replace('/docs/' + moved[id]);
      }
      go();
      window.addEventListener('hashchange', go);
    })();
  </script>`;

function renderDocPage(meta, bodyHtml, toc) {
  const tocHtml = meta.name === 'USER-GUIDE' || GUIDE_PAGES.includes(meta.name) ? renderGuideNav(meta.name, toc) : renderToc(toc);
  const title = `${meta.title} · C64 READY. docs`;
  const path = meta.path || `/docs/${meta.href || slug(meta.title)}.html`;
  const inGuide = GUIDE_PAGES.includes(meta.name);
  const crumbs = inGuide
    ? `<a href="/docs/">Docs</a> <span>/</span> <a href="/docs/user-guide.html">User Guide</a> <span>/</span> ${escapeHtml(meta.title)}`
    : `<a href="/docs/">Docs</a> <span>/</span> ${escapeHtml(meta.title)}`;
  return `${head(title, { desc: meta.desc, path, image: meta.image })}
${topbar}
  <main class="doc-main${tocHtml ? ' has-toc' : ''}">
${tocHtml}
    <article class="doc-content">
      <p class="crumbs">${crumbs}</p>
${bodyHtml}
${inGuide ? guidePager(meta.name) + '\n' : ''}    </article>
  </main>
${meta.name === 'USER-GUIDE' ? guideRedirectScript() + '\n' : ''}${foot}`;
}

// Compile a plain-text file (LICENSE, NOTICE.txt) verbatim into a styled doc
// page, so the app is self-contained: the About page links to these local pages
// instead of the GitHub repo, and they work offline in the installed PWA. The
// text is escaped and dropped into a <pre> (the .doc-content pre style already
// gives horizontal scroll for the wide NOTICE separators / GPL lines).
function writeTextDoc(srcRel, outHref, title, desc) {
  const raw = readFileSync(join(ROOT, srcRel), 'utf8');
  const body = `      <h1>${escapeHtml(title)}</h1>
      <pre>${escapeHtml(raw)}</pre>`;
  writeFileSync(join(DOCS_OUT, `${outHref}.html`), renderDocPage({
    title,
    desc,
    href: outHref,
  }, body, []));
}

// <!-- gallery NAME --> … <!-- /gallery --> in a doc becomes a gallery: one
// image at a time: its caption above, Previous and Next below. Each image is a
// slide; the text before it is its caption, and a leading **bold** run is the slide's title. On
// GitHub the comments are invisible and the images simply follow each other.
// No script: each slide is a radio button and Previous / Next are labels for
// its neighbours, so the gallery works offline and from the keyboard (Tab to
// it, then the arrow keys).
function renderGalleries(html) {
  // An optional label="…" on the marker names what the slides are, shown before
  // each title ("Theme: Commando").
  return html.replace(/<!--\s*gallery\s+([a-z0-9-]+)(?:\s+label="([^"]*)")?\s*-->([\s\S]*?)<!--\s*\/gallery\s*-->/g, (match, name, kind, inner) => {
    const slides = [];
    let rest = inner;
    const imgRe = /<img\b[^>]*>/;
    for (let m = rest.match(imgRe); m; m = rest.match(imgRe)) {
      const before = rest.slice(0, m.index).replace(/<\/?p>/g, ' ').replace(/\s+/g, ' ').trim();
      const strong = before.match(/^<strong>([\s\S]*?)<\/strong>\s*:?\s*/);
      // "**Classic**: the C64's blue" reads as a sentence once the title moves out.
      const caption = (strong ? before.slice(strong[0].length) : before).replace(/^[a-z]/, (c) => c.toUpperCase());
      slides.push({ img: m[0], title: strong ? strong[1] : '', caption });
      rest = rest.slice(m.index + m[0].length);
    }
    if (!slides.length) return match;
    const n = slides.length;
    const id = (i) => `gallery-${name}-${((i + n) % n) + 1}`;
    const items = slides.map((s, i) => {
      const prefix = kind ? `${escapeHtml(kind)}: ` : '';
      const label = prefix + (s.title || `Image ${i + 1}`).replace(/<[^>]+>/g, '');
      return `<input type="radio" class="gallery-pick" name="gallery-${name}" id="${id(i)}" aria-label="${label}, ${i + 1} of ${n}"${i === 0 ? ' checked' : ''}>
<figure class="gallery-slide">${s.caption ? `\n<figcaption>${s.caption}</figcaption>` : ''}
${s.img}
<div class="gallery-nav">
<label class="gallery-step" for="${id(i - 1)}" aria-hidden="true">‹ Previous</label>
<span class="gallery-title">${s.title ? prefix + s.title : ''}<span class="gallery-count">${i + 1} / ${n}</span></span>
<label class="gallery-step" for="${id(i + 1)}" aria-hidden="true">Next ›</label>
</div>
</figure>`;
    }).join('\n');
    return `<div class="gallery" role="group" aria-label="Gallery">\n${items}\n</div>`;
  });
}

// The landing page leads with the same theme gallery the User Guide opens with,
// taken from the guide's source so the two never drift apart.
function overviewGallery() {
  const md = readFileSync(join(DOCS_SRC, 'USER-GUIDE.md'), 'utf8');
  const block = md.match(/<!--\s*gallery\s+overview\b[^>]*-->[\s\S]*?<!--\s*\/gallery\s*-->/);
  return block ? renderGalleries(marked.parse(block[0])).trim().split('\n').map((line) => `      ${line}`).join('\n') : '';
}

function readDocsIndexOverview() {
  const md = readFileSync(join(DOCS_SRC, INDEX_OVERVIEW_FILE), 'utf8')
    // Strip the source SPDX header comment so it doesn't leak into the page.
    .replace(/^<!--\s*SPDX-License-Identifier[\s\S]*?-->\s*<!--\s*Copyright[\s\S]*?-->\s*/, '');
  return rewriteDocLinks(marked.parse(md));
}

// The landing page lists the docs in two groups, one line each: a short name
// and a few words, in this order. A doc not named here goes at the end of its
// group (GUIDES decides which) under its own title and teaser. The User
// Guide's topic pages are left out: the guide's line leads to its hub, and the
// hub's menu to them.
const INDEX_LIST = {
  guides: [
    ['GETTING-STARTED', 'Getting Started', 'from blank screen to a running demo'],
    ['WHATS-NEW', "What's New", 'changes in each release'],
    ['USER-GUIDE', 'User Guide', 'every panel, dialog and button'],
    ['FEATURES', 'Feature list', 'everything it supports'],
    ['KNOWN-ISSUES', 'Known Issues', 'what is missing or rough'],
    ['ABOUT', 'About', 'what it is and who made it'],
    ['SPECIFICATIONS', 'Specifications & credits', 'references, formats and thanks'],
    ['TAPE-RESTORATION', 'Tape restoration', 'bringing worn cassettes back'],
    ['C64READY-AND-VICE', 'C64 READY. and VICE', 'how the two compare'],
  ],
  internals: [
    ['ARCHITECTURE', 'Architecture overview', 'the whole emulator on one page'],
    ['COMPONENT-STATUS', 'Component status', 'how close each part is to the hardware'],
    ['MACHINE-ARCHITECTURE', 'Machine', 'wiring, cycle order, interrupts'],
    ['CPU-ARCHITECTURE', '6510 CPU', 'microops, addressing, illegal opcodes'],
    ['VIC2-ARCHITECTURE', 'VIC-II', 'timing, bad lines, sprites, rendering'],
    ['SID-ARCHITECTURE', 'SID', 'voices, filter, audio worklet'],
    ['MEMORY-ARCHITECTURE', 'Memory', 'banking, I/O routing, cartridges'],
    ['DRIVE-ARCHITECTURE', '1541 disk drive', 'GCR, IEC bus, true drive emulation'],
    ['DATASETTE-ARCHITECTURE', 'Datasette', 'tape deck, TAP and WAV'],
    ['RETROVIBES-ARCHITECTURE', 'Retro Vibes', 'the 3D viewer'],
    ['PERFORMANCE-ANALYSIS', 'Performance', 'keeping a cycle-accurate C64 fast'],
    ['TESTING', 'Test suite', 'tests, tools and VICE cross-checks'],
  ],
};

function renderIndex(docs) {
  const listed = docs.filter((d) => !GUIDE_PAGES.includes(d.slugFile));
  const group = (named, inGroup) => {
    const rows = named.map(([name, label, note]) => {
      const d = listed.find((x) => x.slugFile === name);
      return d && { href: d.href, label, note };
    }).filter(Boolean);
    const extra = listed.filter((d) => inGroup(d) && !named.some(([name]) => name === d.slugFile))
      .map((d) => ({ href: d.href, label: d.title, note: d.desc }));
    return [...rows, ...extra].map((r) =>
      `        <li><a href="/docs/${r.href}.html">${escapeHtml(r.label)}</a><span class="doc-list-note">${escapeHtml(r.note)}</span></li>`).join('\n');
  };
  const guides = group(INDEX_LIST.guides, (d) => GUIDES.has(d.slugFile));
  const internals = group(INDEX_LIST.internals, (d) => !GUIDES.has(d.slugFile));
  const guidesSection = guides
    ? `      <h2 class="docs-group-heading">Overview &amp; guides</h2>
      <ul class="doc-list">
${guides}
      </ul>

`
    : '';
  const overviewHtml = readDocsIndexOverview();

  const title = 'Documentation · C64 READY.';
  return `${head(title, {
    desc: DOCS_DEFAULT_DESC,
    path: '/docs/',
  })}
${topbar}
  <main class="doc-main">
    <article class="doc-content">
      <header class="docs-hero">
        <h1>Documentation</h1>
        <p class="lede">A cycle-exact Commodore 64 that runs entirely in your
          browser — guides for using it, and deep-dives on how it is built,
          chip by chip.</p>
      </header>

      <section class="overview">
${overviewHtml.trim().split('\n').map((line) => `        ${line}`).join('\n')}
      </section>

${overviewGallery()}

${guidesSection}      <h2 class="docs-group-heading">Architecture &amp; internals</h2>
      <ul class="doc-list">
${internals}
      </ul>
    </article>
  </main>
${foot}`;
}

export function renderSitemap(docs, options = {}) {
  const textDocs = options.textDocs || TEXT_DOCS;
  const entries = [
    { path: '/', lastmod: options.rootLastmod },
    { path: '/docs/', lastmod: options.docsLastmod },
    ...docs.map((doc) => ({ path: `/docs/${doc.href}.html`, lastmod: doc.lastmod })),
    ...textDocs.map((doc) => ({ path: `/docs/${doc.href}.html`, lastmod: doc.lastmod })),
  ];
  const seen = new Set();
  const urls = entries
    .filter(({ path }) => !seen.has(path) && seen.add(path))
    .map(({ path, lastmod }) => {
      const modified = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : '';
      return `  <url>\n    <loc>${absoluteUrl(path)}</loc>${modified}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- Generated by tools/build-docs.mjs; do not edit by hand. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

const CSS = `/* Generated by tools/build-docs.mjs — do not edit by hand. */
:root {
  --crt-bg: #070a1c;
  --ui-bg: #0b0e24;
  --panel-bg: #11142e;
  --border: #2c2f63;
  --accent: #7471ec;
  --green: #8fe985;
  --amber: #e6dd6b;
  --red: #d76b70;
  --text: #ccd0ec;
  --dim: #8e8eb7;
  --text-bright: #ffffff;
  --on-accent: #070a1c;
  --accent-hover: #908df0;
  --page-glow: #10143a;
  --topbar-bg: rgba(11, 14, 36, 0.82);
  --zebra: rgba(255, 255, 255, 0.02);
  --logo-c64: #dff4ff;
  --logo-edge: var(--accent);
  --logo-glow: rgba(112, 109, 235, 0.7);
  --logo-shadow: #07071a;
  --ramp-4: #9b98ff;
  --ramp-2: #5a57b8;
  --ramp-1: #43407c;
  --maxw: 820px;
}
/* Light: Classic's light mode, chosen with the same setting as the emulator
   (c64emu.appearance, set by the header button here or there). */
:root[data-mode="light"] {
  --crt-bg: #e8e9f3;
  --ui-bg: #f4f5fb;
  --panel-bg: #ffffff;
  --border: #cfd2e7;
  --accent: #4c49c0;
  --green: #2a7337;
  --amber: #7a5d00;
  --red: #b8323b;
  --text: #23264d;
  --dim: #53567d;
  --text-bright: #12143a;
  --on-accent: #ffffff;
  --accent-hover: #3b3998;
  --page-glow: #d8d9f2;
  --topbar-bg: rgba(244, 245, 251, 0.88);
  --zebra: rgba(35, 38, 77, 0.035);
  --logo-c64: #16183a;
  --logo-edge: transparent;
  --logo-glow: transparent;
  --logo-shadow: transparent;
  --ramp-4: #3e3c9f;
  --ramp-2: #9d9bdc;
  --ramp-1: #c9c8ec;
}
:root[data-mode="light"] .logo-text::after { display: none; }   /* scanlines are for the dark tube */
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 84px; }
body {
  margin: 0;
  background:
    radial-gradient(1200px 600px at 50% -10%, var(--page-glow) 0%, transparent 60%),
    var(--crt-bg);
  color: var(--text);
  font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .brand, kbd { font-family: 'Share Tech Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ── top bar ─────────────────────────────────────────────── */
.doc-top {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 12px 24px;
  background: var(--topbar-bg);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.brand { display: inline-flex; align-items: center; }
.brand:hover { text-decoration: none; }
.brand:hover .logo-text { filter: brightness(1.12); }

/* ── C64 READY. logo (mirrors the app header) ────────────── */
.logo-text {
  display: inline-flex; align-items: flex-end; gap: 2px;
  font-family: 'PetMe64', 'Share Tech Mono', monospace;
  font-size: clamp(0.62rem, 3vw, 1.26rem);   /* same size as the emulator's header logo */
  line-height: 1; white-space: nowrap; letter-spacing: 1px;
  position: relative; padding: 0 0 3px;
}
.lt-main { position: relative; top: 0.2em; }
.lt-c64 {
  color: var(--logo-c64);
  text-shadow: 0 0 2px var(--logo-edge), 0 0 10px var(--logo-glow), 2px 2px 0 var(--logo-shadow);
}
.lt-ready {
  color: var(--accent); margin-left: calc(-0.333em - 3px);
  text-shadow: 0 0 2px var(--logo-edge), 0 0 12px var(--logo-glow), 2px 2px 0 var(--logo-shadow);
}
.lt-blocks {
  font-family: 'Share Tech Mono', monospace; font-size: 0.85em;
  text-shadow: 0 0 8px var(--logo-glow); margin-right: 6px;
}
.lt-blocks .b4 { color: var(--ramp-4); }
.lt-blocks .b3 { color: var(--accent); }
.lt-blocks .b2 { color: var(--ramp-2); }
.lt-blocks .b1 { color: var(--ramp-1); }
.logo-text::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 2;
  background: repeating-linear-gradient(0deg,
      rgba(0,0,0,0) 0, rgba(0,0,0,0) 2px, rgba(0,0,0,0.28) 3px, rgba(0,0,0,0) 4px);
}
.top-nav { display: flex; align-items: center; gap: 18px; }
.nav-links { display: flex; align-items: center; gap: 10px; }
.top-nav a { color: var(--dim); font-size: 0.92rem; letter-spacing: 0.5px; }
.top-nav a:hover { color: var(--text); text-decoration: none; }

/* ABOUT + the GitHub / YouTube / Facebook icons, matching the emulator's own header
   buttons (.credits-link in src/styles/styles-header.css) so the two bars read alike. */
.nav-btn {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.9rem;
  letter-spacing: 2px;
  color: var(--accent);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 16px;
  text-decoration: none;
  transition: all 0.15s;
}
button.nav-btn { background: transparent; cursor: pointer; line-height: 1; }
.top-nav .nav-btn:hover {
  color: var(--text-bright);
  border-color: var(--accent);
  box-shadow: 0 0 12px rgba(112, 109, 235, 0.45);
}
.nav-icon { display: inline-flex; align-items: center; justify-content: center; padding: 7px 11px; }
/* Launch emulator: filled in Classic's accent, labelled in its on-accent ink
   (dark on the light violet, white on the deep one), like the app's primary
   buttons. */
.doc-top .cta {
  color: var(--on-accent);
  font-weight: 700;
  border: 1px solid var(--accent); border-radius: 7px;
  padding: 7px 14px; background: var(--accent);
  white-space: nowrap;
}
.doc-top .cta:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--on-accent); text-decoration: none; }

/* ── layout ──────────────────────────────────────────────── */
.doc-main { max-width: 1160px; margin: 0 auto; padding: 34px 24px 80px; }
.doc-main.has-toc {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 42px; align-items: start;
}
.doc-content { max-width: var(--maxw); min-width: 0; }
.doc-main.has-toc .doc-content { max-width: none; }

.crumbs { color: var(--dim); font-size: 0.85rem; margin: 0 0 22px; }
.crumbs span { opacity: 0.5; margin: 0 4px; }
.guide-pager { display: flex; justify-content: space-between; gap: 16px; margin: 40px 0 0; padding-top: 18px; border-top: 1px solid var(--border); }
.guide-pager a { display: inline-block; padding: 4px 0; }
.guide-pager-next { margin-left: auto; text-align: right; }

/* ── on-this-page TOC ────────────────────────────────────── */
.doc-toc {
  position: sticky; top: 78px;
  font-size: 0.86rem; line-height: 1.5;
  border-left: 1px solid var(--border); padding-left: 16px;
  max-height: calc(100vh - 110px); overflow: auto;
}
.toc-title {
  color: var(--dim); text-transform: uppercase; letter-spacing: 2px;
  font-size: 0.7rem; margin-bottom: 10px;
}
.doc-toc ul { list-style: none; margin: 0; padding: 0; }
.doc-toc li { margin: 3px 0; }
.doc-toc a { display: inline-block; padding: 2px 0; }   /* 24 px touch targets */
.doc-toc a { color: var(--dim); }
.doc-toc a:hover { color: var(--text); text-decoration: none; }
.toc-l3 { padding-left: 14px; font-size: 0.82rem; }
.toc-title a { color: inherit; }
.guide-nav .guide-doc > a { color: var(--text); }
.guide-nav .guide-doc.current > a { color: var(--accent); font-weight: 600; }
.guide-nav .guide-doc > ul { margin: 2px 0 8px 10px; padding-left: 8px; border-left: 1px solid var(--border); }

/* ── prose ───────────────────────────────────────────────── */
.doc-content h1, .doc-content h2, .doc-content h3,
.doc-content h4, .doc-content h5, .doc-content h6 {
  font-family: 'Share Tech Mono', ui-monospace, monospace;
  color: var(--text); line-height: 1.25; scroll-margin-top: 84px;
}
.doc-content h1 { font-size: 2rem; margin: 0 0 18px; letter-spacing: 0.5px; }
.doc-content h2 {
  font-size: 1.4rem; margin: 60px 0 14px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border); color: var(--accent);
  text-shadow: 0 0 8px rgba(112, 109, 235, 0.3);
}
.doc-content h3 { font-size: 1.12rem; margin: 30px 0 10px; color: var(--green); }
.doc-content h4 { font-size: 1rem; margin: 24px 0 8px; color: var(--amber); }
.doc-content p, .doc-content li { color: var(--text); }
.doc-content strong { color: var(--text-bright); }
.doc-content em { color: var(--green); }
.doc-content ul, .doc-content ol { padding-left: 24px; }
.doc-content li { margin: 4px 0; }
.doc-content li::marker { color: var(--accent); }
/* Section breaks: no rule — the --- before each heading renders nothing; the
   heading's own top margin carries the separation as padding instead. */
.doc-content hr { display: none; }
/* Exception: a doc's closing footer note (the --- + paragraph that ends the
   article) gets a visible rule + breathing room above it. hr is display:none,
   so the following paragraph draws the line via border-top. Scoped with
   :last-child so only the final footer matches, never a mid-doc --- + text. */
.doc-content hr + p:last-child {
  border-top: 1px solid var(--border);
  margin-top: 48px;
  padding-top: 28px;
}
/* No frame by default: the panel/modal control screenshots already carry the
   card's own rounded border, so a wrapper border would double up in the
   corners. The full-window shots (overviews, header, 3D scene) have no frame of
   their own and sit on a near-identical page background, so they get one back. */
.doc-content img { max-width: 100%; height: auto; display: block; margin: 22px 0; border-radius: 8px; }
.doc-content img[src*="overview"],
.doc-content img[src*="/guide/header"],
.doc-content img[src*="retro-vibes"],
.doc-content img[src*="/guide/theme-"] { border: 1px solid var(--border); }

/* Galleries (renderGalleries): one slide at a time, picked by a hidden radio
   button; Previous / Next are labels for the neighbouring slides. */
.gallery { margin: 40px 0; }
.gallery-pick { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.gallery-slide { display: none; margin: 0; }
.gallery-pick:checked + .gallery-slide { display: block; }
.gallery-nav { display: flex; align-items: center; gap: 12px; border-radius: 8px; }
.gallery-pick:focus-visible + .gallery-slide .gallery-nav { outline: 2px solid var(--accent); outline-offset: 4px; }
.gallery-step {
  flex: none; cursor: pointer; user-select: none; padding: 6px 12px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--panel-bg);
  color: var(--text); font-family: 'Share Tech Mono', monospace; letter-spacing: 0.06em;
}
.gallery-step:hover { border-color: var(--accent); }
.gallery-title { flex: 1; text-align: center; font-weight: 600; }
.gallery-count { margin-left: 10px; font-weight: 400; color: var(--dim); font-family: 'Share Tech Mono', monospace; }
.gallery-slide img { margin: 12px 0; }
.gallery-slide figcaption { color: var(--text); font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* One line where there is room; a phone would cut it off, so there it wraps. */
@media (max-width: 700px) { .gallery-slide figcaption { white-space: normal; } }

/* underline inline prose links only — not the block-level doc cards */
.doc-content p a, .doc-content li a, .doc-content td a, .doc-content blockquote a {
  text-decoration: underline; text-underline-offset: 2px; text-decoration-color: rgba(112, 109, 235, 0.4);
}
h1 .anchor, h2 .anchor, h3 .anchor, h4 .anchor, h5 .anchor, h6 .anchor {
  margin-left: 10px; color: var(--dim); opacity: 0; text-decoration: none;
  font-weight: normal; transition: opacity 0.12s;
}
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor,
h4:hover .anchor, h5:hover .anchor, h6:hover .anchor { opacity: 0.6; }

/* code */
.doc-content :not(pre) > code {
  font-size: 0.88em; background: var(--panel-bg);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 1px 5px; color: var(--green);
}
.doc-content pre {
  background: var(--panel-bg); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 18px; overflow-x: auto;
  font-size: 0.86rem; line-height: 1.5;
  /* A real system monospace, NOT Share Tech Mono: that webfont has no
     box-drawing (─│┌┐) or block (█▓▒░) glyphs, so in the ASCII schematics those
     chars fall back to a different-width font and the columns drift. These
     system fonts carry those glyphs at a consistent cell width, so diagrams
     line up. Inline code keeps Share Tech Mono (it never uses box glyphs). */
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace;
}
.doc-content pre code { color: var(--text); background: none; border: 0; padding: 0; font-family: inherit; }

/* blockquote */
.doc-content blockquote {
  margin: 18px 0; padding: 2px 18px; color: var(--dim);
  border-left: 3px solid var(--accent);
  background: rgba(112, 109, 235, 0.06); border-radius: 0 8px 8px 0;
}

/* tables */
.doc-content table {
  border-collapse: collapse; width: 100%; margin: 20px 0;
  font-size: 0.9rem; display: block; overflow-x: auto;
}
.doc-content th, .doc-content td {
  border: 1px solid var(--border); padding: 7px 12px; text-align: left;
}
.doc-content thead th {
  background: var(--panel-bg); color: var(--accent);
  font-family: 'Share Tech Mono', monospace; font-weight: normal;
}
.doc-content tbody tr:nth-child(even) { background: var(--zebra); }

/* ── index / landing ─────────────────────────────────────── */
.docs-hero { margin-bottom: 8px; }
.docs-hero h1 {
  font-size: 1.5rem; margin: 0 0 12px; color: var(--dim);
  text-transform: uppercase; letter-spacing: 6px;
}
.lede { font-size: 1.15rem; color: var(--dim); max-width: 60ch; }
.overview p { color: var(--text); }
/* The landing page's grouped list: scoped under .doc-content so it wins over
   the article's own h2 / ul / li / link rules. */
.doc-content .docs-group-heading {
  font-family: 'Share Tech Mono', monospace; color: var(--dim);
  text-transform: uppercase; letter-spacing: 3px; font-size: 1.05rem;
  margin: 40px 0 10px; padding: 0; border: 0; text-shadow: none;
}
.doc-content .doc-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.doc-content .doc-list li {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 16px;
  margin: 0; padding: 9px 2px; border-bottom: 1px solid var(--border);
}
.doc-content .doc-list a {
  font-family: 'Share Tech Mono', monospace; color: var(--accent); min-width: 15rem;
  text-decoration: none;
}
.doc-content .doc-list a:hover { text-decoration: underline; }
.doc-list-note { color: var(--dim); font-size: 0.92rem; }

/* ── footer ──────────────────────────────────────────────── */
.doc-foot {
  border-top: 1px solid var(--border); color: var(--dim); font-size: 0.82rem;
  max-width: 1160px; margin: 0 auto; padding: 22px 24px 40px;
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
}
.doc-foot code { color: var(--dim); }
/* The version links to what changed in that release. Dim like the rest of the
   line, with the underline carrying the affordance: the accent colour every
   other link gets would shout from a footer. Matches the emulator's own About
   footer (.credits-footer in src/styles/styles-header.css). */
.doc-foot a {
  color: inherit; text-decoration: underline; text-underline-offset: 2px;
  text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.doc-foot a:hover { color: var(--text); text-decoration-color: var(--accent); }

@media (max-width: 860px) {
  .doc-main.has-toc { grid-template-columns: 1fr; gap: 0; }
  .doc-toc { display: none; }
  .docs-hero h1 { font-size: 1.9rem; }
}

/* ABOUT and the two icons are desktop-only. They need more room than the plain
   text link they replaced, and below this they push the bar past the viewport;
   the emulator drops its own header icons at the same width. The About page is
   still one tap away through the emulator's About dialog and the docs index. */
@media (max-width: 680px) {
  .nav-links { display: none; }
}

/* Phones: the logo and the CTA share the bar. With a single row the base 84px
   anchor clearance is enough again. */
@media (max-width: 560px) {
  .doc-top { padding: 10px 14px; gap: 10px; }
  /* Scale the pill with the viewport (as the logo does) so the two keep sharing
     the line down to ~300px. */
  .top-nav .cta { font-size: clamp(0.76rem, 3.1vw, 0.92rem); padding: 6px 11px; }
}
`;

// Cache-bust the stylesheet by content: docs.css keeps a fixed name and is
// precached, and a service worker only swaps its precache once the user accepts
// the Reload toast — so without the hash a page from a new deploy can render
// against the stylesheet a client already holds. src/sw.js strips the query
// before its own precache lookup, so an installed app still serves it offline.
const CSS_VERSION = createHash('sha256').update(CSS).digest('hex').slice(0, 8);

export async function buildDocs() {
  let files;
  try {
    files = readdirSync(DOCS_SRC).filter((f) => f.endsWith('.md') && f !== INDEX_OVERVIEW_FILE && !MOVED_SOURCES.has(f));
    // A moved page must not linger from an earlier build: Netlify skips a
    // redirect when a file exists at its path.
    for (const f of MOVED_SOURCES) rmSync(join(DOCS_OUT, `${f.replace(/\.md$/, '').toLowerCase()}.html`), { force: true });
  } catch {
    return; // no docs/ dir — nothing to build
  }
  mkdirSync(DOCS_OUT, { recursive: true });
  const history = sourceHistory();   // two git calls for every date below

  const docs = files.map((file) => {
    const name = file.replace(/\.md$/, '');
    // Output HTML is lowercase-named (getting-started.html, cpu-architecture.html
    // …). `name` (original case) is kept for ORDER/GUIDES matching + sorting;
    // `href` is the lowercase basename used for the filename and every link.
    const href = name.toLowerCase();
    let md = readFileSync(join(DOCS_SRC, file), 'utf8')
      // Strip the source SPDX header comment so it doesn't leak into the page
      // body; the compiled page carries its own license header in <head>.
      .replace(/^<!--\s*SPDX-License-Identifier[\s\S]*?-->\s*<!--\s*Copyright[\s\S]*?-->\s*/, '');
    const described = md.match(DESCRIPTION);
    md = md.replace(DESCRIPTION, '');
    const shared = md.match(SHARE_IMAGE);
    md = md.replace(SHARE_IMAGE, '');
    const meta = { ...extractMeta(md, name), ...(described ? { desc: described[1].replace(/\s+/g, ' ') } : {}),
      image: shared ? namedShareImage(md, shared[1]) : shareImage(md) };
    let bodyHtml = accessibleMarkup(marked.parse(md));
    bodyHtml = renderGalleries(rewriteDocLinks(bodyHtml));
    if (href === 'about') writeAboutFragment(bodyHtml);
    const { html, toc } = addAnchorsAndToc(bodyHtml);
    writeFileSync(join(DOCS_OUT, `${href}.html`), renderDocPage({ ...meta, href, name }, html, toc));
    // Cleaner label for the index cards: drop the "(src/…)" parentheticals the
    // doc H1s carry, while the page keeps its full title.
    const cardTitle = meta.title.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();
    return {
      slugFile: name,
      href,
      title: cardTitle,
      desc: CARD_TEASERS[href] || meta.desc,
      lastmod: sourceLastmod(history, `docs/${file}`),
    };
  });

  // Stable, curated order; unlisted docs appended alphabetically.
  docs.sort((a, b) => {
    const ia = ORDER.indexOf(a.slugFile), ib = ORDER.indexOf(b.slugFile);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.slugFile.localeCompare(b.slugFile);
  });

  writeFileSync(join(DOCS_OUT, 'index.html'), renderIndex(docs));
  writeFileSync(join(DOCS_OUT, 'docs.css'), CSS);
  // Self-contained license + third-party notices (linked from ABOUT), so the
  // app never depends on the GitHub repo to show them and they work offline.
  const textDocs = TEXT_DOCS.map((doc) => ({
    ...doc,
    lastmod: sourceLastmod(history, doc.srcRel),
  }));
  for (const doc of textDocs) writeTextDoc(doc.srcRel, doc.href, doc.title, doc.desc);
  writeFileSync(SITEMAP_OUT, renderSitemap(docs, {
    rootLastmod: appLastmod(history),
    docsLastmod: sourceLastmod(history, 'docs'),
    textDocs,
  }));
  return docs.length;
}

// Run standalone: `node tools/build-docs.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  buildDocs().then((n) => console.log(`Built ${n} doc page(s) → public/docs/`));
}
