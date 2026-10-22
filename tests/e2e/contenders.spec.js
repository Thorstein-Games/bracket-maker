// Adding, editing and deleting contenders: names, uploads, image links, image search.
'use strict';
const { test, expect, makePng, mockWikimedia, openApp, addNames, appState } = require('../helpers');

const poolNames = (page) => page.locator('#pool .item .name').allTextContents();

test.beforeEach(async ({ page }) => openApp(page));

test('add text contenders', async ({ page }) => {
  await addNames(page, ['Pizza', 'Tacos', '  Sushi  ']);
  expect(await poolNames(page)).toEqual(['Pizza', 'Tacos', 'Sushi']);
  await expect(page.locator('#text-input')).toHaveValue('');
  await expect(page.locator('#text-input')).toBeFocused();
  await expect(page.locator('#pool-count')).toHaveText('3 waiting · 0 in bracket');
  // Name-only contenders get an initials tile.
  await expect(page.locator('#pool .item').first().locator('.portrait')).toHaveText('PI');
  // Blank names are ignored.
  await page.locator('#text-input').fill('   ');
  await page.locator('#text-form button').click();
  await expect(page.locator('#pool .item')).toHaveCount(3);
});

test('upload images', async ({ page }) => {
  await page.locator('#file-input').setInputFiles([
    { name: 'red_panda.png', mimeType: 'image/png', buffer: makePng(900, 600, [200, 40, 40]) },
    { name: 'blue-whale.png', mimeType: 'image/png', buffer: makePng(30, 30, [40, 40, 200]) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
  ]);
  await expect(page.locator('#toast')).toHaveText('Added 2 contenders. Click one to rename it.');
  expect(await poolNames(page)).toEqual(['red panda', 'blue whale']);
  const imgs = page.locator('#pool .item img');
  await expect(imgs).toHaveCount(2);
  for (const img of await imgs.all()) {
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  }
  // Stored in IndexedDB, downscaled.
  const sides = await page.evaluate(async () =>
    Promise.all(state.pool.map(async (id) => { const b = await createImageBitmap(await imageDB.get(id)); return Math.max(b.width, b.height); })));
  expect(sides).toEqual([512, 30]);
  // Only non-images: a hint, nothing added.
  await page.locator('#file-input').setInputFiles([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await expect(page.locator('#toast')).toHaveText('No image files found.');
  await expect(page.locator('#pool .item')).toHaveCount(2);
});

test('add an image by link: local copy when CORS allows, plain link when not, error when broken', async ({ page, errors }) => {
  // A host that blocks cross-origin fetches but still serves <img> (route.fulfill can't fake a CORS failure).
  await page.route('https://nocors.example.com/**', (r) =>
    r.request().resourceType() === 'fetch' ? r.abort('accessdenied') : r.fulfill({ status: 200, contentType: 'image/png', body: makePng(20, 20) }));
  await page.route('https://img.example.com/missing.png', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }));
  const url = page.locator('#url-input');

  await url.fill('https://img.example.com/cats/Fluffy_Cat.png');
  await url.press('Enter');
  await expect(page.locator('#pool .item')).toHaveCount(1);
  await expect(url).toHaveValue('');

  await url.fill('https://nocors.example.com/Grumpy%20Dog.png');
  await url.press('Enter');
  await expect(page.locator('#pool .item')).toHaveCount(2);

  await url.fill('https://img.example.com/missing.png');
  await url.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Couldn’t load an image from that link.');
  await expect(url).toHaveValue('https://img.example.com/missing.png');

  const s = await appState(page);
  const [a, b] = s.pool.map((id) => s.items[id]);
  expect(a).toMatchObject({ name: 'Fluffy Cat', stored: true, src: 'https://img.example.com/cats/Fluffy_Cat.png' });
  expect(b).toMatchObject({ name: 'Grumpy Dog', url: 'https://nocors.example.com/Grumpy%20Dog.png' });
  expect(b.stored).toBeUndefined();
  // The CORS block and the 404 are expected console noise here.
  expect(errors.every((e) => /Failed to load resource/.test(e))).toBe(true);
  errors.length = 0;
});

test('image search (mocked Wikimedia): results, load more, add, switch source', async ({ page }) => {
  const log = await mockWikimedia(page);
  await page.locator('#open-search').click();
  const dialog = page.locator('#search-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#search-input')).toBeFocused();
  await expect(page.locator('#search-status')).toHaveText(/Search for characters/);

  await page.locator('#search-input').fill('pizza');
  await page.locator('#search-input').press('Enter');
  const results = page.locator('#search-results .result');
  await expect(results).toHaveCount(3);
  expect(await results.locator('span').allTextContents()).toEqual(['pizza 1', 'pizza 2', 'pizza 3']); // sorted by index
  await expect(page.locator('#search-status')).toHaveText('Click an image to add it as a contender.');
  expect(log[0].hostname).toBe('en.wikipedia.org');
  expect(log[0].searchParams.get('origin')).toBe('*');
  expect(log[0].searchParams.get('gsrsearch')).toBe('pizza');

  await page.locator('#search-more').click();
  await expect(results).toHaveCount(6);
  await expect(page.locator('#search-more')).toBeHidden();
  expect(log[1].searchParams.get('gsroffset')).toBe('3');

  await results.nth(1).click();
  await expect(page.locator('#toast')).toHaveText('Added “pizza 2”.');
  await expect(results.nth(1)).toHaveClass(/added/);

  await page.locator('[data-source="commons"]').click();
  await expect(page.locator('[data-source="commons"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-source="wikipedia"]')).toHaveAttribute('aria-checked', 'false');
  await expect(results).toHaveCount(3); // the audio file is skipped
  expect(await results.locator('span').allTextContents()).toEqual(['pizza 1', 'pizza 2', 'pizza 3']);
  expect(log.at(-1).hostname).toBe('commons.wikimedia.org');
  expect(log.at(-1).searchParams.get('gsrnamespace')).toBe('6');
  await results.first().click();
  await expect(page.locator('#toast')).toHaveText('Added “pizza 1”.');

  await page.locator('#search-close').click();
  await expect(dialog).toBeHidden();
  const s = await appState(page);
  expect(s.pool.map((id) => s.items[id])).toEqual([
    expect.objectContaining({ name: 'pizza 2', stored: true, src: 'https://upload.wikimedia.org/w/pizza%202.png' }),
    expect.objectContaining({ name: 'pizza 1', stored: true, src: 'https://upload.wikimedia.org/c/pizza%201.png' }),
  ]);
  // "+ Add contender" opens the same dialog, keeping the last results.
  await page.locator('#add-item').click();
  await expect(dialog).toBeVisible();
  await expect(results).toHaveCount(3);
});

test('image search failure shows a message', async ({ page, errors }) => {
  await mockWikimedia(page, { fail: true });
  await page.locator('#add-item').click();
  await page.locator('#search-input').fill('anything');
  await page.locator('#search-form button[type="submit"]').click();
  await expect(page.locator('#search-status')).toHaveText('Search failed — check your connection and try again.');
  expect(errors.every((e) => /Failed to load resource/.test(e))).toBe(true);
  errors.length = 0;
});

test('edit a contender: rename, describe, cancel, delete', async ({ page }) => {
  await addNames(page, ['Pizza', 'Tacos']);
  const first = page.locator('#pool .item').first();
  await first.click();
  const dialog = page.locator('#edit-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#edit-name')).toHaveValue('Pizza');
  await expect(page.locator('#edit-preview')).toHaveText('PI');
  await page.locator('#edit-name').fill('  Deep   Dish  ');
  await page.locator('#edit-desc').fill('Chicago style');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(first.locator('.name')).toHaveText('Deep Dish');
  await expect(first).toHaveAttribute('title', 'Deep Dish — Chicago style');

  // Cancel keeps it as it was.
  await first.click();
  await page.locator('#edit-name').fill('Nope');
  await page.locator('#edit-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(first.locator('.name')).toHaveText('Deep Dish');

  // Saved across reloads.
  await page.reload();
  await expect(page.locator('#pool .item .name').first()).toHaveText('Deep Dish');

  await page.locator('#pool .item').first().click();
  await page.locator('#edit-delete').click();
  await expect(dialog).toBeHidden();
  expect(await poolNames(page)).toEqual(['Tacos']);
  expect(Object.keys((await appState(page)).items)).toHaveLength(1);
});
