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
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
  'SPECIFICATIONS',
  'FEATURES',
  'KNOWN-ISSUES',
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
  'WHATS-NEW', 'GETTING-STARTED', 'USER-GUIDE', 'FEATURES', 'KNOWN-ISSUES',
  'SPECIFICATIONS', 'ABOUT',
]);

// Hand-written teasers for specific landing-page cards, overriding the
// auto-extracted first paragraph. Keyed by the lowercase basename (card href).
// These cards lead the Guides band, so they get short, purpose-built lines
// rather than the truncated opening sentence of the page.
const CARD_TEASERS = {
  'whats-new': 'What changed in each release, in plain language.',
  specifications: 'The hardware references, tools, and people this emulator is built on.',
  about: "What it is, what it stands for, and who's behind it.",
};

const TEXT_DOCS = [
  { srcRel: 'LICENSE', href: 'license', title: 'License (GPL-3.0-or-later)' },
  { srcRel: 'NOTICE.txt', href: 'notice', title: 'Third-party notices' },
];

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
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-hidden="true">#</a></h${level}>`;
  });
  return { html: out, toc };
}

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
  const fragment = licenseComment + bodyHtml
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, '')
    .replace(/<a href="([^"]*)"/g, (_m, href) => {
      const offsite = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener"' : '';
      return `<a class="credits-link-inline"${offsite} href="${href}"`;
    });
  writeFileSync(join(DOCS_OUT, 'about-fragment.html'), fragment);
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
  <meta property="og:image" content="${SOCIAL_IMAGE_URL}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(SOCIAL_IMAGE_ALT)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${SOCIAL_IMAGE_URL}">
  <!-- Same icon set and ?v= as index.html; the icons live under /icons/. -->
  <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg?v=3">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png?v=3">
  <link rel="apple-touch-icon" href="/icons/favicon-180.png?v=3">
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
// .credits-link / .icon-link rules in src/styles-header.css.
const GITHUB_SVG =
  '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
const YOUTUBE_SVG =
  '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M8.051 1.999h.089c.822.003 4.987.033 6.11.335a2.01 2.01 0 0 1 1.415 1.42c.101.38.172.883.22 1.402l.01.104.022.26.008.104c.065.914.073 1.77.074 1.957v.075c-.001.194-.01 1.108-.082 2.06l-.008.105-.009.104c-.05.572-.124 1.14-.235 1.558a2.007 2.007 0 0 1-1.415 1.42c-1.16.312-5.569.334-6.18.335h-.142c-.309 0-1.587-.006-2.927-.052l-.17-.006-.087-.004-.171-.007-.171-.007c-1.11-.049-2.167-.128-2.654-.26a2.007 2.007 0 0 1-1.415-1.419c-.111-.417-.185-.986-.235-1.558L.09 9.82l-.008-.104A31.4 31.4 0 0 1 0 7.68v-.123c.002-.215.01-.958.064-1.778l.007-.103.003-.052.008-.104.022-.26.01-.104c.048-.519.119-1.023.22-1.402a2.007 2.007 0 0 1 1.415-1.42c.487-.13 1.544-.21 2.654-.26l.17-.007.172-.006.086-.003.171-.007A99.788 99.788 0 0 1 7.858 2h.193zM6.4 5.209v4.818l4.157-2.408z"/></svg>';
const FACEBOOK_SVG =
  '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<path d="M16 8.05C16 3.6 12.42 0 8 0S0 3.6 0 8.05C0 12.07 2.93 15.4 6.75 16v-5.61H4.72V8.05h2.03V6.28c0-2.02 1.2-3.13 3.02-3.13.87 0 1.79.16 1.79.16v1.98h-1.01c-.99 0-1.3.62-1.3 1.26v1.5h2.22l-.36 2.34H9.25V16C13.07 15.4 16 12.07 16 8.05Z"/></svg>';

const topbar = `  <header class="doc-top">
    <a class="brand" href="/docs/" aria-label="C64 READY. docs home">${LOGO}</a>
    <nav class="top-nav">
      <span class="nav-links">
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
</body>
</html>`;

function renderDocPage(meta, bodyHtml, toc) {
  const tocHtml = renderToc(toc);
  const title = `${meta.title} · C64 READY. docs`;
  const path = meta.path || `/docs/${meta.href || slug(meta.title)}.html`;
  return `${head(title, { desc: meta.desc, path })}
${topbar}
  <main class="doc-main${tocHtml ? ' has-toc' : ''}">
${tocHtml}
    <article class="doc-content">
      <p class="crumbs"><a href="/docs/">Docs</a> <span>/</span> ${escapeHtml(meta.title)}</p>
${bodyHtml}
    </article>
  </main>
${foot}`;
}

// Compile a plain-text file (LICENSE, NOTICE.txt) verbatim into a styled doc
// page, so the app is self-contained: the About page links to these local pages
// instead of the GitHub repo, and they work offline in the installed PWA. The
// text is escaped and dropped into a <pre> (the .doc-content pre style already
// gives horizontal scroll for the wide NOTICE separators / GPL lines).
function writeTextDoc(srcRel, outHref, title) {
  const raw = readFileSync(join(ROOT, srcRel), 'utf8');
  const body = `      <h1>${escapeHtml(title)}</h1>
      <pre>${escapeHtml(raw)}</pre>`;
  writeFileSync(join(DOCS_OUT, `${outHref}.html`), renderDocPage({
    title,
    desc: `${title} for C64 READY.`,
    href: outHref,
  }, body, []));
}

function readDocsIndexOverview() {
  const md = readFileSync(join(DOCS_SRC, INDEX_OVERVIEW_FILE), 'utf8')
    // Strip the source SPDX header comment so it doesn't leak into the page.
    .replace(/^<!--\s*SPDX-License-Identifier[\s\S]*?-->\s*<!--\s*Copyright[\s\S]*?-->\s*/, '');
  return rewriteDocLinks(marked.parse(md));
}

function renderIndex(docs) {
  const cardHtml = (d) => `      <a class="doc-card" href="/docs/${d.href}.html">
        <h3>${escapeHtml(d.title)}</h3>
        <p>${escapeHtml(d.desc)}</p>
        <span class="read">Read ▸</span>
      </a>`;

  // The overview & guides (using the emulator) lead the page in their own band;
  // everything else is the chip-by-chip internals grid below them. About sits
  // second in the first band: the top-bar link to it is hidden on phones, so the
  // card is the only way there at that width.
  const guides = docs.filter((d) => GUIDES.has(d.slugFile)).map(cardHtml).join('\n');
  const internals = docs.filter((d) => !GUIDES.has(d.slugFile)).map(cardHtml).join('\n');
  const guidesSection = guides
    ? `      <h2 class="cards-heading">Overview &amp; guides</h2>
      <div class="doc-cards">
${guides}
      </div>

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

      <img src="/guide/overview.webp" width="1920" height="1122"
        alt="The C64 READY. emulator: the monitor booted to BASIC beside the control panels">

${guidesSection}      <h2 class="cards-heading">Architecture &amp; internals</h2>
      <div class="doc-cards">
${internals}
      </div>
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
  --accent: #706deb;
  --green: #8fe985;
  --amber: #e6dd6b;
  --red: #d76b70;
  --text: #ccd0ec;
  --dim: #6e6ea4;
  --maxw: 820px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 84px; }
body {
  margin: 0;
  background:
    radial-gradient(1200px 600px at 50% -10%, #10143a 0%, transparent 60%),
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
  background: rgba(11, 14, 36, 0.82);
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
  color: #dff4ff;
  text-shadow: 0 0 2px var(--accent), 0 0 10px rgba(112, 109, 235, 0.7), 2px 2px 0 #07071a;
}
.lt-ready {
  color: var(--accent); margin-left: calc(-0.333em - 3px);
  text-shadow: 0 0 2px var(--accent), 0 0 12px rgba(112, 109, 235, 0.6), 2px 2px 0 #07071a;
}
.lt-blocks {
  font-family: 'Share Tech Mono', monospace; font-size: 0.85em;
  text-shadow: 0 0 8px rgba(112, 109, 235, 0.4); margin-right: 6px;
}
.lt-blocks .b4 { color: #9b98ff; }
.lt-blocks .b3 { color: var(--accent); }
.lt-blocks .b2 { color: #5a57b8; }
.lt-blocks .b1 { color: #43407c; }
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
   buttons (.credits-link in src/styles-header.css) so the two bars read alike. */
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
.top-nav a.nav-btn:hover {
  color: #fff;
  border-color: var(--accent);
  box-shadow: 0 0 12px rgba(112, 109, 235, 0.45);
}
.nav-icon { display: inline-flex; align-items: center; justify-content: center; padding: 7px 11px; }
.doc-top .cta {
  color: #08240c;
  font-weight: 700;
  border: 1px solid #a9ff9f; border-radius: 7px;
  padding: 7px 14px; background: #a9ff9f;   /* Colodore light green (VIC #13) — the power signal */
  box-shadow: 0 0 14px rgba(169, 255, 159, 0.4);
  white-space: nowrap;
}
.doc-top .cta:hover { background: #c6ffbf; border-color: #c6ffbf; color: #08240c; text-decoration: none; }

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
.doc-toc a { color: var(--dim); }
.doc-toc a:hover { color: var(--text); text-decoration: none; }
.toc-l3 { padding-left: 14px; font-size: 0.82rem; }

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
.doc-content strong { color: #fff; }
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
.doc-content img[src*="retro-vibes"] { border: 1px solid var(--border); }

/* underline inline prose links only — not the block-level doc cards */
.doc-content p a, .doc-content li a, .doc-content td a, .doc-content blockquote a {
  text-decoration: underline; text-underline-offset: 2px; text-decoration-color: rgba(112, 109, 235, 0.4);
}
.doc-card, .doc-card:hover { text-decoration: none; }
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
.doc-content tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }

/* ── index / landing ─────────────────────────────────────── */
.docs-hero { margin-bottom: 8px; }
.docs-hero h1 {
  font-size: 1.5rem; margin: 0 0 12px; color: var(--dim);
  text-transform: uppercase; letter-spacing: 6px;
}
.lede { font-size: 1.15rem; color: var(--dim); max-width: 60ch; }
.overview p { color: var(--text); }
.cards-heading {
  font-family: 'Share Tech Mono', monospace; color: var(--dim);
  text-transform: uppercase; letter-spacing: 3px; font-size: 0.8rem;
  margin: 40px 0 16px;
}
.doc-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.doc-card {
  display: flex; flex-direction: column;
  background: var(--panel-bg); border: 1px solid var(--border);
  border-radius: 12px; padding: 18px 18px 16px; color: var(--text);
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.doc-card:hover {
  border-color: var(--accent); transform: translateY(-2px); text-decoration: none;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
.doc-card h3 { font-family: 'Share Tech Mono', monospace; color: var(--accent); margin: 0 0 8px; font-size: 1.05rem; }
.doc-card p { color: var(--dim); font-size: 0.9rem; margin: 0 0 14px; flex: 1; }
.doc-card .read { color: var(--green); font-size: 0.85rem; font-family: 'Share Tech Mono', monospace; }

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
   footer (.credits-footer in src/styles-header.css). */
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
    files = readdirSync(DOCS_SRC).filter((f) => f.endsWith('.md') && f !== INDEX_OVERVIEW_FILE);
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
    const md = readFileSync(join(DOCS_SRC, file), 'utf8')
      // Strip the source SPDX header comment so it doesn't leak into the page
      // body; the compiled page carries its own license header in <head>.
      .replace(/^<!--\s*SPDX-License-Identifier[\s\S]*?-->\s*<!--\s*Copyright[\s\S]*?-->\s*/, '');
    const meta = extractMeta(md, name);
    let bodyHtml = marked.parse(md);
    bodyHtml = rewriteDocLinks(bodyHtml);
    if (href === 'about') writeAboutFragment(bodyHtml);
    const { html, toc } = addAnchorsAndToc(bodyHtml);
    writeFileSync(join(DOCS_OUT, `${href}.html`), renderDocPage({ ...meta, href }, html, toc));
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
  for (const doc of textDocs) writeTextDoc(doc.srcRel, doc.href, doc.title);
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
