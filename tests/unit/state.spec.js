// Saving/loading state, seating, and the small helpers in app.js.
'use strict';
const { test, expect, openApp } = require('../helpers');

test.beforeEach(async ({ page }) => openApp(page));

const load = (page, raw) =>
  page.evaluate((raw) => {
    if (raw === undefined) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, raw);
    return loadState();
  }, raw);

test.describe('loadState', () => {
  test('no save → default 8-seat bracket', async ({ page }) => {
    const s = await load(page, undefined);
    expect(s).toEqual({ title: 'My Bracket', size: 8, slots: Array(8).fill(null), results: {}, pool: [], items: {} });
  });

  test('reads the current save shape', async ({ page }) => {
    const saved = {
      title: 'Snacks', size: 4, slots: ['a', null, 'b', null], results: { '0-0': 'a' }, pool: ['c'],
      items: {
        a: { id: 'a', name: 'A', desc: 'd' },
        b: { id: 'b', name: 'B', desc: '', stored: true, src: 'https://img.example.com/b.png' },
        c: { id: 'c', name: 'C', desc: '', url: 'https://img.example.com/c.png' },
      },
    };
    expect(await load(page, JSON.stringify(saved))).toEqual(saved);
  });

  test('old saves without `results` (pre-results versions) still load', async ({ page }) => {
    const old = { title: 'Old', size: 2, slots: ['a', 'b'], pool: [], items: { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } } };
    expect(await load(page, JSON.stringify(old))).toEqual({ ...old, results: {} });
  });

  const bad = {
    'not JSON': '{oops',
    'JSON null': 'null',
    'a number': '42',
    'an unsupported size': JSON.stringify({ title: 'x', size: 6, slots: Array(6).fill(null), pool: [], items: {} }),
    'slots/size mismatch': JSON.stringify({ title: 'x', size: 8, slots: [null, null], pool: [], items: {} }),
    'pool not an array': JSON.stringify({ title: 'x', size: 2, slots: [null, null], pool: {}, items: {} }),
    'no items': JSON.stringify({ title: 'x', size: 2, slots: [null, null], pool: [] }),
  };
  for (const [what, raw] of Object.entries(bad)) {
    test(`falls back to the default for ${what}`, async ({ page }) => {
      expect((await load(page, raw)).title).toBe('My Bracket');
      expect((await load(page, raw)).size).toBe(8);
    });
  }

  test('a broken save does not break page load', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem(STORE_KEY, '{"size":'));
    await page.reload();
    await expect(page.locator('#stage .match')).toHaveCount(7);
    await expect(page.locator('#title')).toHaveText('My Bracket');
  });

  test('save() writes state under bracket-maker:v1', async ({ page }) => {
    const saved = await page.evaluate(() => {
      state.title = 'Saved!';
      save();
      return JSON.parse(localStorage.getItem('bracket-maker:v1'));
    });
    expect(saved.title).toBe('Saved!');
  });
});

test.describe('seating', () => {
  test('seat() puts contenders in seeding order; seeds 1 and 2 meet only in the final', async ({ page }) => {
    const slots = await page.evaluate(() => seat(['s1', 's2', 's3', 's4', 's5'], 8));
    expect(slots).toEqual(['s1', null, 's4', 's5', 's2', null, 's3', null]);
  });

  test('seat() with exactly enough contenders fills every seat', async ({ page }) => {
    const slots = await page.evaluate(() => seat(Array.from({ length: 16 }, (_, i) => `s${i}`), 16));
    expect(slots.filter(Boolean).length).toBe(16);
  });
});

test.describe('helpers', () => {
  test('cleanName turns file names into contender names', async ({ page }) => {
    const out = await page.evaluate(() =>
      ['big_red-dog.jpeg', 'Pizza.PNG', '  spaced   out  ', '.png', 'x'.repeat(60) + '.webp', 'v1.2 final'].map(cleanName));
    expect(out).toEqual(['big red dog', 'Pizza', 'spaced out', 'Contender', 'x'.repeat(40), 'v1.2 final']);
  });

  test('initials', async ({ page }) => {
    const out = await page.evaluate(() => ['Darth Vader', 'pizza', 'a b c', '  ', '😀 Smile', 'é'].map(initials));
    expect(out).toEqual(['DV', 'PI', 'AB', '?', '😀S', 'É']);
  });

  test('nameFromUrl', async ({ page }) => {
    const out = await page.evaluate(() =>
      ['https://x.org/a/Big%20Cat.png', 'https://x.org/', 'not a url', 'https://x.org/dir/'].map(nameFromUrl));
    expect(out).toEqual(['Big Cat.png', '', '', 'dir']);
  });

  test('hueFor is stable and in range', async ({ page }) => {
    const out = await page.evaluate(() => ['A', 'B', 'A', 'Pizza'].map(hueFor));
    expect(out[0]).toBe(out[2]);
    expect(out[0]).not.toBe(out[1]);
    for (const h of out) expect(h >= 0 && h < 360).toBe(true);
  });

  test('roundsFor', async ({ page }) => {
    expect(await page.evaluate(() => SIZES.map(roundsFor))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('addImageBlob downscales big images to MAX_IMAGE_SIDE WebP in IndexedDB and records the web source', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 1600;
      c.height = 800;
      const ctx = c.getContext('2d');
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `hsl(${i * 37} 70% 50%)`;
        ctx.fillRect(Math.random() * 1600, Math.random() * 800, 120, 120);
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await addImageBlob(blob, 'huge_photo.png', 'https://img.example.com/huge.png');
      const id = state.pool.at(-1);
      const stored = await imageDB.get(id);
      const bmp = await createImageBitmap(stored);
      return { item: state.items[id], type: stored.type, w: bmp.width, h: bmp.height, smaller: stored.size < blob.size };
    });
    expect(res.item).toMatchObject({ name: 'huge photo', stored: true, src: 'https://img.example.com/huge.png' });
    expect(res).toMatchObject({ type: 'image/webp', w: 512, h: 256, smaller: true });
  });
});
