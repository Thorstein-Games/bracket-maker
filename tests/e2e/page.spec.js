// Page shell: loads cleanly, head metadata, assets and deployment list, title editing.
'use strict';
const fs = require('fs');
const path = require('path');
const { test, expect, APP, openApp } = require('../helpers');

const ROOT = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const pagesYml = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
const deployed = pagesYml.match(/cp (.+) _site\//)[1].trim().split(/\s+/);

test('loads with no console errors and an empty 8-seat bracket', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('h1')).toHaveText('Bracket Maker');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h2#title')).toHaveText('My Bracket');
  await expect(page.locator('#stage .match')).toHaveCount(7);
  await expect(page.locator('#size-select')).toHaveValue('8');
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#pool-count')).toHaveText('0 waiting · 0 in bracket');
  // The whole bracket starts in view.
  const [vp, stage] = [await page.locator('#viewport').boundingBox(), await page.locator('#stage').boundingBox()];
  expect(stage.x).toBeGreaterThanOrEqual(vp.x - 1);
  expect(stage.x + stage.width).toBeLessThanOrEqual(vp.x + vp.width + 1);
  // No sideways scrolling, including on phones.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('editable title syncs the document title and persists', async ({ page }) => {
  await openApp(page);
  const baseTitle = await page.title();
  expect(baseTitle).toContain('Bracket Maker');
  const title = page.locator('#title');
  await title.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('  Movie Night  ');
  await page.keyboard.press('Enter');
  await expect(title).not.toBeFocused();
  await expect(title).toHaveText('Movie Night');
  await expect(page).toHaveTitle('Movie Night – Bracket Maker');
  await page.reload();
  await expect(title).toHaveText('Movie Night');
  await expect(page).toHaveTitle('Movie Night – Bracket Maker');
  // Emptying it falls back to the default name and the default page title.
  await title.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.locator('h1').click();
  await expect(title).toHaveText('My Bracket');
  await expect(page).toHaveTitle(baseTitle);
});

test.describe('head and deployment', () => {
  test.skip(({ isMobile }) => isMobile, 'viewport-independent; checked once on desktop');

  test('SEO head tags', async ({ page }) => {
    await openApp(page);
    const attr = (sel, a = 'content') => page.locator(sel).getAttribute(a);
    await expect(page).toHaveTitle(/^Bracket Maker/);
    expect(await attr('meta[name="description"]')).toMatch(/bracket/i);
    expect(await attr('link[rel="canonical"]', 'href')).toBe('https://thorsteingames.com/bracket-maker');
    expect(await attr('meta[property="og:url"]')).toBe('https://thorsteingames.com/bracket-maker');
    expect(await attr('meta[property="og:image"]')).toBe('https://thorsteingames.com/bracket-maker/og-image.jpg');
    expect(await attr('meta[name="twitter:image"]')).toBe('https://thorsteingames.com/bracket-maker/og-image.jpg');
    expect(await attr('meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(await attr('meta[property="og:image:width"]')).toBe('1200');
    expect(await attr('meta[property="og:image:height"]')).toBe('630');
    expect(await attr('meta[name="viewport"]')).toContain('width=device-width');
    // og:image points at a file we actually deploy.
    expect(deployed).toContain('og-image.jpg');
  });

  test('JSON-LD parses, and the FAQ mirrors the visible FAQ', async ({ page }) => {
    await openApp(page);
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(blocks).toHaveLength(1);
    const ld = JSON.parse(blocks[0]);
    const types = ld['@graph'].map((x) => x['@type']);
    expect(types).toEqual(['WebApplication', 'FAQPage']);
    const app = ld['@graph'][0];
    expect(app.url).toBe('https://thorsteingames.com/bracket-maker');
    const faq = ld['@graph'][1].mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
    const visible = await page.locator('.about .faq dt').evaluateAll((dts) =>
      dts.map((dt) => [dt.textContent.trim(), dt.nextElementSibling.textContent.trim()]));
    expect(visible.length).toBeGreaterThan(0);
    expect(faq).toEqual(visible);
  });

  test('shared Thorstein Games bar, footer, more-games and ad slots are in place', async ({ page }) => {
    await openApp(page);
    expect(await page.locator('script[src="https://thorsteingames.com/tg-bar.js"]').count()).toBe(1);
    for (const tag of ['tg-bar', 'tg-footer', 'tg-more-games']) {
      await expect(page.locator(`${tag}[game="bracket-maker"]`)).toHaveCount(1);
    }
    await expect(page.locator('body > tg-bar:first-child')).toHaveCount(1);
    await expect(page.locator('main + tg-ad[format="banner"] + tg-footer')).toHaveCount(1);
    await expect(page.locator('#champion tg-ad[format="box"]')).toHaveCount(1);
    // Ads stay out of the bracket, the versus screen and the drag areas.
    await expect(page.locator('#viewport tg-ad, #versus tg-ad, #pool tg-ad')).toHaveCount(0);
  });

  test('every /bracket-maker/ asset in index.html is served and deployed', async ({ page, request }) => {
    const refs = [...new Set([...html.matchAll(/(?:href|src|content)="(\/bracket-maker\/[^"#?]*)"/g)].map((m) => m[1]))];
    expect(refs.sort()).toEqual(['/bracket-maker/app.js', '/bracket-maker/apple-touch-icon.png', '/bracket-maker/favicon.svg', '/bracket-maker/style.css']);
    for (const ref of refs) {
      const res = await request.get(ref);
      expect(res.status(), ref).toBe(200);
      expect(deployed, `${ref} must be in the pages.yml cp list`).toContain(ref.slice('/bracket-maker/'.length));
    }
    // Absolute https://thorsteingames.com/bracket-maker/... references (og:image etc.) too.
    for (const [, file] of html.matchAll(/https:\/\/thorsteingames\.com\/bracket-maker\/([^"#?]+)"/g)) expect(deployed).toContain(file);
    // Everything in the cp list exists, and nothing test-only is shipped.
    for (const file of deployed) expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    for (const file of deployed) expect(file).not.toMatch(/^(tests|node_modules|package|playwright)/);
    await page.goto(APP);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/bracket-maker/favicon.svg');
  });
});
