import assert from 'node:assert/strict';

export async function checkReleaseDetails(page) {
  const requests = [];
  const record = request => requests.push(request.url());
  page.on('request', record);
  try {
    for (const originalUrl of ['https://csdb.dk/release/?id=42', null, 'javascript:alert(1)']) {
      await page.evaluate(async originalUrl => {
        const { Assembly64Controller } = await import('/src/assembly64/controller.js');
        const { openDetailsDialog } = await import('/src/assembly64/details-dialog.js');
        const controller = new Assembly64Controller({ transport: fetch });
        await controller.search();
        const item = await controller.getDetails(controller.state.items[0]);
        item.originalUrl = originalUrl;
        await openDetailsDialog(controller, item, async () => ({}), item);
        controller.dispose();
      }, originalUrl);
      const details = page.locator('.mb-details');
      await details.locator('.mb-file').first().waitFor();
      const link = details.getByRole('link', { name: 'Original release page ↗' });
      if (originalUrl?.startsWith('https:')) {
        assert.equal(await link.getAttribute('href'), originalUrl, 'Verified original URLs are preserved');
        assert.equal(await link.getAttribute('target'), '_blank', 'Original pages open in a new tab');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer', 'Original pages cannot access the opener');
      } else assert.equal(await link.count(), 0, 'Missing or unsafe original URLs do not produce links');
      assert.equal(await details.locator('img, .mb-preview, .mb-preview-status').count(), 0, 'Details contain no screenshot UI or placeholders');
      assert.ok(await details.getByRole('button', { name: 'DOWNLOAD', exact: true }).count() > 0, 'Media downloads remain available');
      await page.keyboard.press('Escape');
    }
    assert.ok(requests.every(url => !url.includes('/leet/metadata/') && !url.includes('csdb.dk')), 'Details do not request screenshot metadata or external images');
  } finally { page.off('request', record); }
  console.log('Assembly64 details: no screenshot requests, safe original links and media availability passed.');
}
