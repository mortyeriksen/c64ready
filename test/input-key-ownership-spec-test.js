import { MatrixKeyOwnership, SoftKeyboardInsertState } from '../src/input-key-ownership.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

{
  const ownership = new MatrixKeyOwnership(['Backspace']);
  assert(!ownership.release('Backspace'),
    'an unmatched soft-keyboard keyup cannot release a synthetic matrix tap');
}

{
  const ownership = new MatrixKeyOwnership(['Backspace']);
  ownership.claim('Backspace');
  assert(ownership.release('Backspace'),
    'a matched physical keyup releases its physical matrix press');
}

{
  const ownership = new MatrixKeyOwnership(['Backspace']);
  ownership.claim('Backspace');
  ownership.release('Backspace');
  assert(!ownership.release('Backspace'),
    'a physical matrix-key claim is consumed by its first keyup');
}

{
  const state = new SoftKeyboardInsertState();
  state.normalize(' ');
  assert(state.normalize('. ') === ' ',
    'Gboard double-Space replacement adds one Space instead of period-Space');
}

{
  const state = new SoftKeyboardInsertState();
  assert(state.normalize('. ') === '. ',
    'period-Space text is unchanged without a preceding Space tap');
}

{
  const state = new SoftKeyboardInsertState();
  state.normalize(' ');
  state.reset();
  assert(state.normalize('. ') === '. ',
    'reset clears double-Space replacement context');
}

console.log('\nAll input key-ownership and insert-state spec tests passed.');
