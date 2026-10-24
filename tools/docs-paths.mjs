// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import { readFileSync } from 'node:fs';

export const DOCS_PAGE_REDIRECTS = new Map(readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8')
  .split('\n').map(line => line.trim().split(/\s+/))
  .filter(([from, to, status]) => from.startsWith('/docs/') && to?.startsWith('/docs/') && status === '301')
  .map(([from, to]) => [from, to]));

// Match the production redirects and extensionless static documentation URLs.
export function docsPaths(req, res, next) {
  const [pathname, search = ''] = req.url.split('?');
  const q = search ? `?${search}` : '';
  const moved = DOCS_PAGE_REDIRECTS.get(pathname);
  if (moved || pathname === '/docs') {
    res.writeHead(301, { location: `${moved || '/docs/'}${q}` });
    return res.end();
  }
  if (pathname === '/docs/') req.url = `/docs/index.html${q}`;
  else if (pathname.startsWith('/docs/') && !pathname.slice(6).includes('.'))
    req.url = `${pathname}.html${q}`;
  next();
}
