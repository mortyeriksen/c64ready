import assert from 'node:assert/strict';

// The UI half of the NEOS mouse: the machine owns the protocol (neosPorts, the
// strobe sequencer, POTX), and input.js plugs the mouse in or out to match the
// port selects and forwards host buttons and motion. Drives the real controls
// and reads the machine back, across a port swap and a RESET (a rebuilt machine).
export async function checkNeos(page) {
  const state = () => page.evaluate(async () => {
    const { machine } = await import('/src/state.js');
    return {
      p1: !!machine.neosPorts[1], p2: !!machine.neosPorts[2], potX: machine.potXOverride,
      left1: !!machine.neosPorts[1]?.leftBtn, dx1: machine.neosPorts[1]?.pendingDX ?? null,
    };
  });
  const before = { 1: await page.locator('#cp-device-p1').inputValue(), 2: await page.locator('#cp-device-p2').inputValue() };
  try {
    await page.locator('#cp-device-p1').selectOption('mouseNeos');
    await page.locator('#cp-device-p2').selectOption('none');
    let s = await state();
    assert.equal(s.p1, true, 'Choosing NEOS on port 1 plugs a NEOS mouse into the machine on port 1');
    assert.equal(s.p2, false, 'and not on port 2');
    assert.equal(s.potX, 0x00, 'With the right button up, NEOS drives POTX released ($00)');

    const screen = page.locator('#screen');
    await screen.dispatchEvent('mousedown', { button: 2 });
    s = await state();
    assert.equal(s.potX, 0xFF, 'The right button reaches the machine as POTX pressed ($FF)');
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })));
    assert.equal((await state()).potX, 0x00, 'Releasing the right button releases POTX');
    await screen.dispatchEvent('mousedown', { button: 0 });
    assert.equal((await state()).left1, true, 'The left button reaches the NEOS port');
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })));
    assert.equal((await state()).left1, false, 'Releasing the left button clears it');

    // Motion is only read under pointer lock, which a headless page cannot take.
    const dx = await page.evaluate(async () => {
      const canvas = document.getElementById('screen');
      Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => canvas });
      try {
        canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: 40, movementY: 0, bubbles: true }));
      } finally { delete document.pointerLockElement; }
      return (await import('/src/state.js')).machine.neosPorts[1].pendingDX;
    });
    assert.ok(dx < 0, `Host motion to the right reaches the NEOS port as a negative delta (${dx})`);

    await page.locator('#btn-swap-ports').click();
    s = await state();
    assert.deepEqual([s.p1, s.p2], [false, true], 'Swapping the ports moves the NEOS mouse to port 2');
    await page.locator('#btn-swap-ports').click();

    await page.evaluate(async () => { window.neosOldMachine = (await import('/src/state.js')).machine; });
    await page.locator('#btn-reset').click();
    // An async predicate does not make waitForFunction wait, so poll by hand.
    for (let i = 0; i < 50; i++) {
      if (await page.evaluate(async () => (await import('/src/state.js')).machine !== window.neosOldMachine)) break;
      await page.waitForTimeout(100);
    }
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine !== window.neosOldMachine), true, 'RESET builds a new machine');
    s = await state();
    assert.equal(s.p1, true, 'A rebuilt machine (RESET) gets the NEOS mouse plugged back in');
    assert.equal(s.potX, 0x00, 'and its POTX driven again');

    await page.locator('#cp-device-p1').selectOption('none');
    s = await state();
    assert.equal(s.p1, false, 'Choosing no device unplugs the NEOS mouse');
    assert.equal(s.potX, null, 'With no NEOS mouse, nothing overrides POTX');
    console.log('NEOS mouse: port select, buttons, POTX, motion, port swap, RESET rebuild and unplug passed.');
  } finally {
    await page.locator('#cp-device-p1').selectOption(before[1]);
    await page.locator('#cp-device-p2').selectOption(before[2]);
  }
}
