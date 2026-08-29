import assert from 'assert';
import { renderSitemap } from '../tools/build-docs.mjs';

const sitemap = renderSitemap([
  { href: 'first-page', lastmod: '2026-01-02' },
  { href: 'second-page', lastmod: '2026-02-03' },
], {
  rootLastmod: '2026-03-04',
  docsLastmod: '2026-04-05',
  textDocs: [
    { href: 'license', lastmod: '2026-05-06' },
    { href: 'notice', lastmod: '2026-06-07' },
  ],
});

const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

assert.deepStrictEqual(locations, [
  'https://c64ready.com/',
  'https://c64ready.com/docs/',
  'https://c64ready.com/docs/first-page.html',
  'https://c64ready.com/docs/second-page.html',
  'https://c64ready.com/docs/license.html',
  'https://c64ready.com/docs/notice.html',
], 'sitemap lists the app, docs index, and every generated documentation page');
assert.ok(
  sitemap.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'),
  'sitemap declares the standard sitemap XML namespace',
);
assert.deepStrictEqual(
  [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]),
  ['2026-03-04', '2026-04-05', '2026-01-02', '2026-02-03', '2026-05-06', '2026-06-07'],
  'sitemap includes accurate per-page source modification dates',
);
assert.ok(!sitemap.includes('<changefreq>'), 'sitemap omits ignored change-frequency hints');
assert.ok(!sitemap.includes('/pwa.html'), 'sitemap excludes the installed-launch beacon');

console.log('ok - docs generator renders a complete canonical sitemap');
