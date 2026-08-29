// Spec test for src/switches.js: how a switch resolves at call time.
//
// The env var wins, then (in a browser) a query parameter of the same name, then
// the default. Only '1' and '0' count; anything else keeps looking.
import { switchOn, SWITCHES } from '../src/switches.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const name = 'lineBatchRender';
const env = SWITCHES[name].env[0];
const saved = process.env[env];
delete process.env[env];
try {
  expect(switchOn(name) === SWITCHES[name].default, 'with nothing set, the default applies');
  process.env[env] = '0';
  expect(switchOn(name) === false, "'0' forces the switch off");
  process.env[env] = '1';
  expect(switchOn(name) === true, "'1' forces it on");
  process.env[env] = 'yes';
  expect(switchOn(name) === SWITCHES[name].default, 'any other value keeps the default');
  delete process.env[env];

  // The browser's way in: ?NAME=0 on the URL, read from `location`.
  globalThis.location = { search: `?${env}=0` };
  expect(switchOn(name) === false, 'a ?NAME=0 query forces it off');
  globalThis.location = { search: `?x=2&${env}=1` };
  expect(switchOn(name) === true, 'a ?NAME=1 query forces it on');
  globalThis.location = { search: '?other=1' };
  expect(switchOn(name) === SWITCHES[name].default, 'an unrelated query changes nothing');
  globalThis.location = { search: `?${env}=maybe` };
  expect(switchOn(name) === SWITCHES[name].default, 'a query value that is not 1 or 0 changes nothing');
  globalThis.location = { search: '' };
  expect(switchOn(name) === SWITCHES[name].default, 'no query at all: the default');
  process.env[env] = '0';
  globalThis.location = { search: `?${env}=1` };
  expect(switchOn(name) === false, 'the env var outranks the query');
  delete process.env[env];
  delete globalThis.location;

  let threw = false;
  try { switchOn('noSuchSwitch'); } catch { threw = true; }
  expect(threw, 'asking for a switch that does not exist is a programming error');

  for (const [key, s] of Object.entries(SWITCHES)) {
    expect(typeof s.default === 'boolean', `${key} has a boolean default`);
    expect(Array.isArray(s.env) && s.env.length > 0 && s.env.every(e => /^[A-Z][A-Z0-9_]*$/.test(e)),
      `${key} names at least one SHOUTING_CASE env var`);
  }
} finally {
  if (saved === undefined) delete process.env[env]; else process.env[env] = saved;
  delete globalThis.location;
}

console.log('switches spec: PASS');
