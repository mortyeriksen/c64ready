import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { docsPaths } from '../tools/docs-paths.mjs';

function request(url) {
  const req = { url }, result = { next: false, ended: false };
  const res = {
    writeHead(status, headers) { Object.assign(result, { status, ...headers }); },
    end() { result.ended = true; },
  };
  docsPaths(req, res, () => { result.next = true; });
  return { ...result, url: req.url };
}
assert.equal(existsSync(new URL('../docs/USERPORT-DEVICES.md', import.meta.url)), false, 'the moved User Port guide has no source stub');
for (const path of ['/docs/userport-devices', '/docs/userport-devices.html']) {
  const result = request(`${path}?from=bookmark`);
  assert.equal(result.status, 301, `${path} permanently redirects`);
  assert.equal(result.location, '/docs/device-plugins.html?from=bookmark', `${path} preserves the query at the combined guide`);
  assert.equal(result.next, false, `${path} does not fall through to the app`);
  assert.equal(result.ended, true, `${path} ends the redirect response`);
}
assert.equal(request('/docs/user-guide-cli.html').location, '/docs/guide-cli.html', 'the CLI guide uses its production redirect');
assert.equal(request('/docs?from=menu').location, '/docs/?from=menu', 'the docs index retains its trailing-slash redirect');
assert.equal(request('/docs/').url, '/docs/index.html', 'the docs index serves its static page');
assert.equal(request('/docs/device-plugins').url, '/docs/device-plugins.html', 'the combined guide resolves without a file extension');
assert.equal(request('/docs/device-plugins.html').next, true, 'the canonical combined guide has no redirect loop');
console.log('ok - moved documentation redirects match production and preserve queries');
