import assert from 'node:assert/strict';

export async function checkApiLoad(page, requests) {
  const counts = {};
  function checkpoint(name, expected) {
    const count = requests.splice(0).length;
    counts[name] = count;
    assert.equal(count, expected, `${name}: bounded Assembly64 request count`);
  }
  checkpoint('Initialization', 2);
  const control = page.locator('#media-browser-body');
  const input = control.getByLabel('Search media', { exact: true });
  const waitQuick = () => page.waitForFunction(() => document.querySelectorAll('#media-browser-body .mb-quick-result').length === 10 && [...document.querySelectorAll('#media-browser-body .mb-quick-result .btn')].every(node => node.dataset.checking === 'false'));
  await control.getByLabel('Type', { exact: true }).selectOption('Samples');
  await input.press('Enter'); await waitQuick();
  checkpoint('First quick search including ten file lists', 11);
  await input.press('Enter'); await waitQuick();
  checkpoint('Repeated quick search', 0);
  await control.locator('.mb-quick-result .mb-title').first().click();
  const details = page.locator('.mb-details');
  await details.locator('.mb-file').first().waitFor();
  checkpoint('Open release after quick search', 1);
  await page.keyboard.press('Escape');
  await control.locator('.mb-quick-result .mb-title').first().click();
  await details.locator('.mb-file').first().waitFor();
  checkpoint('Reopen release', 0);
  await page.keyboard.press('Escape');
  await control.getByRole('button', { name: 'REFINE SEARCH', exact: true }).click();
  const catalog = page.locator('.mb-browser');
  const waitCatalog = count => page.waitForFunction(count => document.querySelector('.mb-browser .mb-results')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.mb-browser .mb-result').length === count, count);
  await waitCatalog(10); checkpoint('Refine cached quick search', 0);
  const search = catalog.getByLabel('Search title', { exact: true });
  await search.fill('Sample'); await page.waitForTimeout(400);
  checkpoint('Typing without submitting', 0);
  await search.press('Enter'); await waitCatalog(10);
  checkpoint('Submit new browser search', 1);
  await catalog.getByRole('button', { name: 'LOAD MORE ↓', exact: true }).click(); await waitCatalog(20);
  checkpoint('Load more', 1);
  await catalog.getByLabel('Source', { exact: true }).selectOption('Lab');
  await catalog.getByLabel('Type / category', { exact: true }).selectOption('demos');
  await catalog.getByLabel('Type / category', { exact: true }).selectOption('Samples');
  await waitCatalog(10); await page.waitForTimeout(350);
  checkpoint('Rapid filter changes', 1);
  await catalog.getByRole('button', { name: 'Reset', exact: true }).click(); await waitCatalog(10);
  checkpoint('Reset', 1);
  await catalog.locator('.mb-star').first().click();
  await catalog.getByRole('button', { name: 'Favorites', exact: true }).click();
  await catalog.getByRole('button', { name: 'Saved searches', exact: true }).click();
  await page.waitForTimeout(800);
  checkpoint('Favorites, saved searches and idle', 0);
  console.log('Mocked Assembly64 API request audit:', JSON.stringify(counts));
  await page.keyboard.press('Escape');
}
