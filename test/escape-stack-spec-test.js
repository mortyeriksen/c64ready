// Spec test for the Escape key owner (src/escape-stack.js).
//
// The behaviour that matters is priority: Escape must close whatever the user
// sees on top, not whichever dialog's module happened to be imported first.
// Most assertions drive handleEscape() directly; the last block sends keydown
// events through a stand-in document, which has to exist before the import
// because the module attaches its listener only when `document` does.
import { installMiniDom, fire } from './_mini-dom.js';

const dom = installMiniDom();
const {
  pushEscapeLayer, popEscapeLayer, escapeLayerCount, handleEscape, _resetEscapeLayers,
} = await import('../src/escape-stack.js');

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A dialog: open until its own close() runs, so the stack sees a real state
// change rather than a layer that lies about being open.
function fakeDialog(name, log) {
  const d = {
    open: true,
    layer: {
      close: () => { d.open = false; log.push(name); },
      isOpen: () => d.open,
    },
  };
  return d;
}

// ── Topmost first ────────────────────────────────────────────────────────────
// Two dialogs open at once: the second one opened is the one Escape closes, and
// the first survives untouched.
{
  _resetEscapeLayers();
  const log = [];
  const under = fakeDialog('under', log);
  const over = fakeDialog('over', log);
  pushEscapeLayer(under.layer);
  pushEscapeLayer(over.layer);

  expect(handleEscape() === true, 'Escape is claimed while a layer is open');
  expect(log.join(',') === 'over', `topmost closes first, got "${log.join(',')}"`);
  expect(under.open, 'the layer underneath is left open');
  expect(escapeLayerCount() === 1, 'the closed layer pops itself off');

  expect(handleEscape() === true, 'the next Escape reaches the layer underneath');
  expect(log.join(',') === 'over,under', `then the one below, got "${log.join(',')}"`);
  expect(escapeLayerCount() === 0, 'stack empties as dialogs close');
}

// ── Nothing open ─────────────────────────────────────────────────────────────
// With no layers the key is not claimed, so it stays available to the browser
// (leaving fullscreen) and to the C64.
{
  _resetEscapeLayers();
  expect(handleEscape() === false, 'an empty stack does not claim Escape');
}

// ── Closing by another route ─────────────────────────────────────────────────
// A dialog dismissed by its ✕ or a backdrop click pops itself, so Escape falls
// through to whatever is beneath it.
{
  _resetEscapeLayers();
  const log = [];
  const under = fakeDialog('under', log);
  const over = fakeDialog('over', log);
  pushEscapeLayer(under.layer);
  pushEscapeLayer(over.layer);

  over.open = false;                 // ✕ clicked
  popEscapeLayer(over.layer);
  handleEscape();
  expect(log.join(',') === 'under', `Escape skips the dismissed dialog, got "${log.join(',')}"`);
}

// ── Self-healing on a missed pop ─────────────────────────────────────────────
// If a close path forgets to pop, the stale layer must not swallow Escape: it is
// discarded on sight and the key goes to the real topmost dialog. This is what
// keeps a single missed pop from wedging the key for the whole session.
{
  _resetEscapeLayers();
  const log = [];
  const under = fakeDialog('under', log);
  const leaky = fakeDialog('leaky', log);
  pushEscapeLayer(under.layer);
  pushEscapeLayer(leaky.layer);

  leaky.open = false;                // closed, but nobody popped it
  expect(handleEscape() === true, 'a stale top layer does not block the key');
  expect(log.join(',') === 'under', `stale layer is skipped, got "${log.join(',')}"`);
  expect(escapeLayerCount() === 0, 'the stale entry is dropped too');
}

// ── Re-opening does not duplicate ────────────────────────────────────────────
// open() running twice (or a dialog re-opened over itself) must leave one entry,
// or the second Escape would hit a layer that is already gone.
{
  _resetEscapeLayers();
  const log = [];
  const d = fakeDialog('d', log);
  pushEscapeLayer(d.layer);
  pushEscapeLayer(d.layer);
  expect(escapeLayerCount() === 1, 'pushing twice keeps one entry');
  handleEscape();
  expect(escapeLayerCount() === 0, 'and one close empties the stack');
}

// ── Re-push moves to the top ─────────────────────────────────────────────────
// A dialog re-opened while another is up becomes topmost, rather than staying at
// the depth it first had.
{
  _resetEscapeLayers();
  const log = [];
  const a = fakeDialog('a', log);
  const b = fakeDialog('b', log);
  pushEscapeLayer(a.layer);
  pushEscapeLayer(b.layer);
  pushEscapeLayer(a.layer);          // a re-opened over b
  handleEscape();
  expect(log.join(',') === 'a', `the re-pushed layer is topmost, got "${log.join(',')}"`);
}

// ── popEscapeLayer is safe on an absent layer ────────────────────────────────
{
  _resetEscapeLayers();
  const log = [];
  const d = fakeDialog('d', log);
  popEscapeLayer(d.layer);           // never pushed
  expect(escapeLayerCount() === 0, 'popping an unknown layer is a no-op');
}

// ── The document listener ────────────────────────────────────────────────────
// Escape on the document closes the top layer and is swallowed there, so neither
// the dialog's own key handler nor the C64 matrix sees it. Anything else, or
// Escape with nothing open, passes through untouched.
{
  _resetEscapeLayers();
  const log = [];
  const d = fakeDialog('d', log);
  pushEscapeLayer(d.layer);
  let ev = fire(dom.document, 'keydown', { code: 'Escape' });
  expect(log.join(',') === 'd', 'Escape on the document closes the top layer');
  expect(ev.defaultPrevented && ev.stoppedImmediate, 'and the key is claimed');
  ev = fire(dom.document, 'keydown', { code: 'Escape' });
  expect(!ev.defaultPrevented, 'with nothing open the key passes through');
  pushEscapeLayer(fakeDialog('e', log).layer);
  ev = fire(dom.document, 'keydown', { code: 'Enter' });
  expect(!ev.defaultPrevented && log.join(',') === 'd', 'other keys are none of its business');
}

console.log('escape-stack spec: all assertions passed');
