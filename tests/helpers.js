// Shared test setup: no real network, console-error tracking, and small page helpers.
'use strict';
const base = require('@playwright/test');
const zlib = require('zlib');

const { expect } = base;
const APP = '/bracket-maker/';

// A valid w×h PNG filled with one colour, so uploads need no fixture files.
function makePng(w = 40, h = 30, [r, g, b] = [200, 60, 60]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CORS = { 'access-control-allow-origin': '*' };

// Every request leaving localhost is either mocked or blocked.
async function isolate(context) {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'thorsteingames.com') {
      // tg-bar.js (shared bar/footer/ads) is served by another repo; stub it out.
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* tg-bar stub */' });
    }
    if (url.hostname === 'upload.wikimedia.org' || url.hostname === 'img.example.com') {
      const colour = [...url.pathname].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 255, 7);
      return route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: makePng(48, 48, [colour, 90, 180]) });
    }
    return route.abort('blockedbyclient');
  });
}

// Fake Wikimedia API answers; `log` collects the request URLs.
function wikiResults(prefix, n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${from + i + 1}`, index: from + i + 1 }));
}

async function mockWikimedia(page, { fail = false } = {}) {
  const log = [];
  await page.route(/^https:\/\/(en\.wikipedia|commons\.wikimedia)\.org\/w\/api\.php/, (route) => {
    const url = new URL(route.request().url());
    log.push(url);
    if (fail) return route.fulfill({ status: 500, headers: CORS, body: 'nope' });
    const q = url.searchParams.get('gsrsearch');
    const offset = Number(url.searchParams.get('gsroffset') || 0);
    const commons = url.hostname.startsWith('commons');
    const pages = wikiResults(q, 3, offset).map((p) =>
      commons
        ? { ...p, title: `File:${p.title}.jpg`, imageinfo: [{ thumburl: `https://upload.wikimedia.org/c/${encodeURIComponent(p.title)}.png`, mime: 'image/jpeg' }] }
        : { ...p, thumbnail: { source: `https://upload.wikimedia.org/w/${encodeURIComponent(p.title)}.png` } },
    );
    // Commons also returns a non-image file, which must be skipped.
    if (commons) pages.push({ title: 'File:Clip.ogg', index: 99, imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x.ogg', mime: 'audio/ogg' }] });
    // Wikipedia also returns a page without a thumbnail, which must be skipped.
    else pages.push({ title: 'No picture', index: 99 });
    const body = { query: { pages: pages.reverse() } };
    if (!offset) body.continue = { gsroffset: 3, continue: 'gsroffset||' };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  });
  return log;
}

const test = base.test.extend({
  context: async ({ context }, use) => {
    await isolate(context);
    await use(context);
  },
  // Console errors and uncaught exceptions fail the test.
  errors: [
    async ({ page }, use) => {
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, 'console errors / page errors').toEqual([]);
    },
    { auto: true },
  ],
});

async function openApp(page, hash = '') {
  await page.goto(APP + hash);
  await expect(page.locator('#stage .match').first()).toBeAttached();
}

// Seed state directly (for e2e setup that isn't the thing under test) and re-render.
async function setState(page, s) {
  await page.evaluate((s) => {
    state = { title: 'My Bracket', results: {}, pool: [], ...s };
    commit();
    fitView();
  }, s);
}

const textItems = (names) => Object.fromEntries(names.map((n, i) => [`id${i}`, { id: `id${i}`, name: n, desc: '' }]));

async function addNames(page, names) {
  const input = page.locator('#text-input');
  const before = await page.locator('#pool .item').count();
  for (const n of names) {
    await input.fill(n);
    await input.press('Enter');
  }
  await expect(page.locator('#pool .item')).toHaveCount(before + names.length);
}

// Scroll the window so an element's centre sits mid-screen (the stage is clipped, so
// scrollIntoView on stage elements would scroll #viewport instead).
async function centre(locator, xFrac = 0.5) {
  await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - innerHeight / 2);
  });
  const box = await locator.boundingBox();
  return { x: box.x + box.width * xFrac, y: box.y + box.height / 2 };
}

// Pointer-event drag with the mouse, as a user would.
// xFrac: where across the target to drop (pool tiles insert before/after by half).
async function drag(page, source, target, { xFrac = 0.5 } = {}) {
  const from = await centre(source);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
  await expect(page.locator('body')).toHaveClass(/dragging/);
  const to = await centre(target, xFrac);
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/dragging/);
}

const appState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(state)));
const nameAt = (page, i) => page.evaluate((i) => state.items[state.slots[i]]?.name ?? null, i);

module.exports = { test, expect, APP, makePng, isolate, mockWikimedia, openApp, setState, textItems, addNames, centre, drag, appState, nameAt };
