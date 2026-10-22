// Saved across reloads (localStorage + IndexedDB) and shared by link into a fresh browser.
'use strict';
const { test, expect, APP, makePng, isolate, openApp, addNames } = require('../helpers');

// Text + uploaded image contenders in a 2-bracket, with the match played through the UI.
async function buildAndPlay(page) {
  await page.locator('#title').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Pets');
  await page.keyboard.press('Enter');
  await page.locator('#size-select').selectOption('4');
  await addNames(page, ['Goldfish']);
  await page.locator('#file-input').setInputFiles({ name: 'Fat_Cat.png', mimeType: 'image/png', buffer: makePng(120, 80, [240, 160, 20]) });
  await expect(page.locator('#pool .item')).toHaveCount(2);
  await addNames(page, ['Hamster']);
  await page.locator('#pool .item').first().click();
  await page.locator('#edit-desc').fill('Blub');
  await page.locator('#edit-dialog').getByRole('button', { name: 'Save' }).click();
  await page.locator('#auto-fill').click(); // Goldfish (1) v bye, Fat Cat (2) v Hamster (3)
  await page.locator('#run').click();
  await expect(page.locator('#versus .fighter-name')).toHaveText(['Fat Cat', 'Hamster']);
  await page.locator('#versus .fighter.p1').click();
  await page.locator('#vs-close').click();
}

async function expectPets(page) {
  await expect(page.locator('#title')).toHaveText('Pets');
  await expect(page).toHaveTitle('Pets – Bracket Maker');
  await expect(page.locator('#size-select')).toHaveValue('4');
  await expect(page.locator('#stage .slot.seed .item .name')).toHaveText(['Goldfish', 'Fat Cat', 'Hamster']);
  await expect(page.locator('.slot.won .name')).toHaveText('Fat Cat');
  await expect(page.locator('#run')).toHaveText('▶ Continue bracket');
  await expect(page.locator('#stage .item[title="Goldfish — Blub"]')).toHaveCount(1);
  // The uploaded image renders from IndexedDB.
  const img = page.locator('#stage .slot.seed .item', { hasText: 'Fat Cat' }).locator('img');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
}

test('bracket, results and uploaded images survive a reload', async ({ page }) => {
  await openApp(page);
  await buildAndPlay(page);
  await page.reload();
  await expectPets(page);
  // ...and the run continues where it left off.
  await page.locator('#run').click();
  await expect(page.locator('#vs-round')).toHaveText('Final');
  await expect(page.locator('#versus .fighter-name')).toHaveText(['Goldfish', 'Fat Cat']);
});

test('share link opens the same bracket in a fresh browser', async ({ page, browser, errors }, testInfo) => {
  await openApp(page);
  await buildAndPlay(page);
  await page.locator('#share').click();
  const dialog = page.locator('#share-dialog');
  await expect(dialog).toBeVisible();
  const url = page.locator('#share-url');
  await expect(url).toHaveValue(/\/bracket-maker\/#b=[\w-]+$/);
  await expect(page.locator('#share-note')).toHaveText(/thumbnails/);
  const withPicks = await url.inputValue();
  // Without picks: a different link.
  await page.locator('#share-picks').uncheck();
  await expect(url).not.toHaveValue(withPicks);
  await expect(url).toHaveValue(/#b=[\w-]+$/);
  const withoutPicks = await url.inputValue();
  await page.locator('#share-close').click();
  await expect(dialog).toBeHidden();

  const { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = testInfo.project.use;
  const open = async (link) => {
    const ctx = await browser.newContext({ viewport, isMobile, hasTouch, deviceScaleFactor, userAgent });
    await isolate(ctx);
    const p = await ctx.newPage();
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(link);
    await expect(p.locator('#toast')).toHaveText('Opened “Pets”.');
    return { ctx, p };
  };

  const a = await open(withPicks);
  await expectPets(a.p);
  expect(new URL(a.p.url()).hash).toBe('');
  await expect.poll(() => a.p.evaluate(() => JSON.parse(localStorage.getItem(STORE_KEY)).title)).toBe('Pets');
  await a.ctx.close();

  const b = await open(withoutPicks);
  await expect(b.p.locator('#stage .slot.seed .item .name')).toHaveText(['Goldfish', 'Fat Cat', 'Hamster']);
  await expect(b.p.locator('.slot.won')).toHaveCount(0);
  await expect(b.p.locator('#run')).toHaveText('▶ Run bracket');
  await b.ctx.close();
});

test('a broken share link shows a message and leaves the page usable', async ({ page }) => {
  await page.goto(APP + '#b=AAAAAAAAAAAA');
  await expect(page.locator('#toast')).toHaveText('That share link is broken or incomplete.');
  await expect(page.locator('#stage .match')).toHaveCount(7);
  await addNames(page, ['Still works']);
});

test('the share button needs contenders first', async ({ page }) => {
  await openApp(page);
  await page.locator('#share').click();
  await expect(page.locator('#toast')).toHaveText('Add some contenders first.');
  await expect(page.locator('#share-dialog')).toBeHidden();
});
