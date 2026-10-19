// What is loaded, and what it is called (src/media/now-loaded.js): the title
// a room about it takes, best source first, and the slots keeping what was
// learned about a medium when its load hook fires again.

import { setLoaded, enrichLoaded, loadedItems, titleFromFileName, describe, _resetLoaded } from '../../src/media/now-loaded.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

{
  expect(titleFromFileName('Commando (1985)[a].d64') === 'Commando', 'tags and the year go');
  expect(titleFromFileName('the_last_ninja.prg') === 'The Last Ninja', 'underscores become spaces and a lower-case name gets capitals');
  expect(titleFromFileName('NINE.D64') === 'NINE', 'an upper-case name stays as it is');
  ok('a file name becomes a readable title');
}
{
  const release = { title: 'Nine', a64: { item: '42', cat: 3, file: '7', name: 'nine.d64' } };
  expect(describe({ kind: 'd64', fileName: 'x.d64', headerName: 'FAIRLIGHT', release }).title === 'Nine', 'the Assembly64 release title comes first');
  expect(describe({ kind: 'sid', fileName: 'cmd.prg', embeddedTitle: 'Commando' }).title === 'Commando', 'then a title stored in the file');
  expect(describe({ kind: 'd64', fileName: 'Commando.d64', headerName: 'FAIRLIGHT' }).title === 'Commando', 'then the file name, before the disk header');
  expect(describe({ kind: 'd64', fileName: null, headerName: 'COMMANDO' }).title === 'COMMANDO', 'the header when nothing else names it');
  expect(describe({ kind: 'd64', fileName: null, headerName: 'SIDE A' }).title === 'Untitled', 'a generic header names nothing');
  expect(describe({ kind: 'sid' }).kind === 'tune' && describe({ kind: 'crt' }).kind === 'cart' && describe({ kind: 't64' }).kind === 'tape', 'kinds map to the topic kinds');
  ok('the best source names the medium');
}
{
  _resetLoaded();
  const disk = {};
  setLoaded('drive8', { ref: disk, kind: 'd64', fileName: 'nine.d64', headerName: 'NINE' });
  enrichLoaded('drive8', { release: { title: 'Nine (Booze Design)', a64: null } }, 'nine.d64');
  setLoaded('drive8', { ref: disk, kind: 'd64', fileName: 'nine.d64', headerName: 'NINE' });
  expect(loadedItems()[0]?.title === 'Nine (Booze Design)', 'the same disk again keeps its release');
  setLoaded('drive8', { ref: {}, kind: 'd64', fileName: 'other.d64' });
  expect(loadedItems()[0]?.title === 'Other', 'a different disk starts afresh');
  enrichLoaded('drive8', { embeddedTitle: 'Wrong' }, 'not-this.prg');
  expect(loadedItems()[0]?.title === 'Other', 'facts about a file that went elsewhere label nothing');
  setLoaded('tape', { ref: 'cmd.tap', kind: 'tap', fileName: 'cmd.tap' });
  expect(loadedItems().map((i) => i.slot).join() === 'drive8,tape', 'items come in slot order');
  expect(loadedItems()[1].label === 'tape', 'with where they are');
  setLoaded('drive8', null);
  expect(loadedItems().length === 1, 'an eject empties the slot');
  ok('slots keep what they learned about a medium until it changes');
}

if (failing) { console.log(`\n${failing} of ${testNo} failed`); process.exit(1); }
console.log(`\nall ${testNo} passed`);
