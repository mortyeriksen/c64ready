import assert from 'node:assert/strict';

export async function checkKeyboard(page) {
  await page.evaluate(async () => {
    const { closeAssembly64Dialogs } = await import('/src/assembly64/dom.js');
    closeAssembly64Dialogs();
    const { machine, running } = await import('/src/state.js');
    if (!running) throw new Error('Keyboard integration requires the running emulator');
    window.keyboardCalls = [];
    const original = machine.cia1.setKey;
    machine.cia1.setKey = function (...args) { window.keyboardCalls.push(args); return original.apply(this, args); };
    window.restoreKeyboard = () => { machine.cia1.setKey = original; };
  });
  const control = page.locator('#media-browser-body');
  const explore = control.getByRole('button', { name: 'EXPLORE', exact: true });
  const calls = () => page.evaluate(() => window.keyboardCalls.splice(0));
  try {
    // The C64 has the keyboard while its screen has focus; a control focused
    // from the keyboard keeps its keys, and the hint says how to hand them back.
    for (const [key, position] of [['a', [1, 2]], ['l', [5, 2]], ['Enter', [0, 1]], ['Space', [7, 4]]]) {
      await page.locator('#screen').focus(); await calls(); await page.keyboard.press(key);
      assert.deepEqual(await calls(), [[...position, true], [...position, false]], `${key} on the focused screen reaches and releases the C64 key`);
    }
    for (const key of ['a', 'l']) {
      await explore.focus(); await calls(); await page.keyboard.press(key);
      assert.deepEqual(await calls(), [], `${key} with a control focused does not reach the C64`);
      assert.equal(await explore.evaluate(node => node === document.activeElement), true, `${key} does not move control focus`);
    }
    assert.equal(await page.locator('#keyboard-focus-hint').isVisible(), true, 'with a control focused the hint says to click the screen');
    for (const key of ['Enter', 'Space']) {
      await explore.focus(); await calls(); await page.keyboard.press(key);
      assert.equal(await page.locator('.mb-overlay').count(), 1, `${key} presses the focused EXPLORE button`);
      assert.deepEqual(await calls(), [], `${key} on a button does not reach the C64`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.mb-overlay').count(), 0, 'Escape closes the browser again');
    }
    const tabOrder = [
      explore, control.getByRole('button', { name: 'FAVORITES', exact: true }),
      control.getByLabel('Search media', { exact: true }), control.getByLabel('Source', { exact: true }),
      control.getByLabel('Group / producer', { exact: true }), control.getByLabel('Type', { exact: true }),
      control.getByRole('button', { name: 'Quick search', exact: true }),
    ];
    await explore.focus(); await calls();
    for (const target of tabOrder.slice(1)) {
      await page.keyboard.press('Tab');
      assert.equal(await target.evaluate(node => node === document.activeElement), true, 'Tab advances through the compact control');
      assert.deepEqual(await calls(), [], 'Control Tab does not reach the C64');
    }
    for (const target of tabOrder.slice(0, -1).reverse()) {
      await page.keyboard.press('Shift+Tab');
      assert.equal(await target.evaluate(node => node === document.activeElement), true, 'Shift+Tab reverses through the compact control');
      assert.deepEqual(await calls(), [], 'Control Shift+Tab does not reach the C64');
    }
    await control.getByLabel('Search media', { exact: true }).focus();
    assert.equal(await page.locator('#keyboard-focus-hint').isVisible(), true, 'Typing fields show the keyboard focus hint');
    await page.locator('#screen').click();
    assert.equal(await page.locator('#keyboard-focus-hint').isVisible(), false, 'Clicking the screen clears the keyboard focus hint');
    // The C64 has no Tab key: from the running machine's screen, Tab moves on.
    await page.locator('#screen').focus(); await calls(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id !== 'screen'), true, 'Tab moves focus off the running C64 screen');
    assert.deepEqual(await calls(), [], 'Tab does not reach the C64');
    await page.locator('#screen').focus();
    await page.keyboard.down('ArrowRight');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine.joyPort2 & 8), 0, 'Arrow keys reach the configured C64 joystick');
    await page.keyboard.up('ArrowRight');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine.joyPort2 & 8), 8, 'Releasing an arrow releases the configured C64 joystick');
    // The key joystick's chips: a Tab stop each, held with Enter or Space.
    const upChip = page.locator('#cp-detail-p2 .cp-joy-dir[data-joy-dir="up"]');
    assert.equal(await upChip.getAttribute('tabindex'), '0', 'the joystick chips are Tab stops');
    await upChip.focus(); await calls(); await page.keyboard.down('Enter');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine.joyPort2 & 1), 0, 'Enter on the up chip holds joystick up');
    await page.keyboard.up('Enter');
    assert.equal(await page.evaluate(async () => (await import('/src/state.js')).machine.joyPort2 & 1), 1, 'releasing Enter lets go');
    assert.deepEqual(await calls(), [], 'pressing a chip types nothing on the C64');
    await page.locator('#screen').focus();
    for (const [key, mask] of [['j', 16], ['k', 1]]) {
      await page.keyboard.down(key);
      assert.equal(await page.evaluate(async mask => (await import('/src/state.js')).machine.joyPort2 & mask, mask), 0, key + ' asserts its default joystick fire line');
      await page.keyboard.up(key);
      assert.equal(await page.evaluate(async mask => (await import('/src/state.js')).machine.joyPort2 & mask, mask), mask, key + ' releases its default joystick fire line');
    }
    const input = control.getByLabel('Search media', { exact: true });
    await input.fill('demo'); await calls(); await page.keyboard.type(' tune');
    assert.equal(await input.inputValue(), 'demo tune', 'Quick search accepts spaces and text');
    assert.deepEqual(await calls(), [], 'Quick search typing does not reach the C64');
    const producer = control.getByLabel('Group / producer', { exact: true });
    await producer.fill('C64'); await calls(); await page.keyboard.type(' READY');
    assert.equal(await producer.inputValue(), 'C64 READY', 'The producer field accepts spaces and text');
    assert.deepEqual(await calls(), [], 'Producer typing does not reach the C64');
    await producer.fill('');
    await page.locator('#screen').focus(); await page.keyboard.down('Space');
    await input.focus(); await page.keyboard.up('Space');
    assert.deepEqual(await calls(), [[7, 4, true], [7, 4, false]], 'Focus moving into search still releases a held C64 key');
    await input.fill('');
    await control.getByLabel('Type', { exact: true }).click();
    await control.getByLabel('Type', { exact: true }).selectOption('Samples');
    assert.equal(await page.locator('#screen').evaluate(node => node === document.activeElement), true, 'Choosing Type with the mouse returns focus to the emulator');
    await input.focus();
    await control.getByRole('button', { name: 'Quick search', exact: true }).click();
    assert.equal(await page.locator('#screen').evaluate(node => node === document.activeElement), true, 'Clicking quick search releases search-field focus to the emulator');
    await calls(); await page.keyboard.press('a');
    assert.deepEqual(await calls(), [[1, 2, true], [1, 2, false]], 'Typing after a control click reaches the C64');
    await explore.click();
    const dialog = page.getByRole('dialog', { name: 'Assembly64 Browser', exact: true });
    const close = dialog.getByRole('button', { name: 'Close Assembly64 Browser' });
    await close.focus(); await calls(); await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement) && document.activeElement !== node.querySelector('.mb-close')), true, 'Dialog Tab moves focus within the modal');
    assert.deepEqual(await calls(), [], 'Dialog Tab does not reach the C64');
    // The results are one Tab stop; the arrow keys move through them.
    const titles = dialog.locator('.mb-result .mb-title');
    await titles.first().waitFor();
    if (await titles.count() > 1) {
      await titles.first().focus(); await page.keyboard.press('ArrowDown');
      assert.equal(await titles.nth(1).evaluate(node => node === document.activeElement), true, 'ArrowDown moves to the next result');
      assert.equal(await dialog.locator('.mb-results [tabindex="0"]').count(), 1, 'the result list is one Tab stop');
      await page.keyboard.press('ArrowRight');
      assert.equal(await titles.nth(1).evaluate(node => node !== document.activeElement && node.closest('.mb-result').contains(document.activeElement)), true, 'ArrowRight moves within the result row');
      assert.deepEqual(await calls(), [], 'moving through the results does not reach the C64');
    }
    await dialog.getByLabel('Search title', { exact: true }).focus();
    await page.keyboard.type('demo tune');
    assert.equal(await dialog.getByLabel('Search title', { exact: true }).inputValue(), 'demo tune', 'Dialog search accepts spaces');
    assert.deepEqual(await calls(), [], 'Dialog typing does not reach the C64');
    await close.focus(); await calls(); await page.keyboard.press('Space');
    assert.deepEqual(await calls(), [], 'Dialog Space does not reach the C64');
    assert.equal(await dialog.count(), 0, 'Space presses the focused close button');
    assert.equal(await page.locator('#screen').evaluate(node => node === document.activeElement), true, 'Closing Explore returns focus to the emulator');
    await explore.click();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0, 'Escape retains dialog-stack dismissal');
    assert.equal(await page.locator('#screen').evaluate(node => node === document.activeElement), true, 'Closing Explore returns focus to the emulator');
  } finally { await page.evaluate(() => window.restoreKeyboard()); }
  console.log('Assembly64 keyboard: keys to the C64 only from its screen, Enter/Space press focused buttons, Tab navigation, mouse clicks hand the keyboard back, editable fields and key release passed.');
}
