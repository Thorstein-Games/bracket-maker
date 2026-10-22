// Share links: encodeBracket() -> #b= link -> openSharedLink().
'use strict';
const zlib = require('zlib');
const { test, expect, openApp } = require('../helpers');

// A link made by the v1 encoder. Keep accepting it forever, whatever the encoder becomes.
const V1 = {
  v: 1, t: 'Best Snacks', z: 4,
  i: [{ n: 'Popcorn', d: 'Buttery' }, { n: 'Chips', u: 'https://img.example.com/chips.png' }, { n: 'Pretzel' }, { n: 'Nachos' }, { n: 'Pocky' }],
  s: [0, 3, 1, 2], p: [4], r: { '0-0': 0 },
};
const V1_CODE =
  'RYuxCoMwGAZfpXzzX42t0z-2exE6BgdJg4qahCSWquTdixTseNzdhje4IEQwbjrE09M0agggrOCS0IPlBgNGZZ2y3oDw2ts5Ru0XJPrZe9e7_ZrB6GJ0gfO8n9pMf5rJjTpTdsrV3mTOtMdVeR1XPR78aFRnw19bNSxINSGApaArFXSpCQ4sy5rgwRvEWYBFSl8';

let confirmAnswer;
test.beforeEach(async ({ page }) => {
  confirmAnswer = true;
  page.on('dialog', (d) => (confirmAnswer ? d.accept() : d.dismiss()));
  await openApp(page);
  await page.evaluate(() => {
    window.T = {
      decode: async (code) => JSON.parse(await pipeBytes(fromBase64Url(code), new DecompressionStream('deflate-raw')).text()),
      encodeRaw: async (obj) =>
        toBase64Url(new Uint8Array(await pipeBytes(JSON.stringify(obj), new CompressionStream('deflate-raw')).arrayBuffer())),
      open: async (code) => {
        history.replaceState(null, '', location.pathname + '#b=' + code);
        await openSharedLink();
      },
      png: async (w, h, noise = false) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (noise) {
          const img = ctx.createImageData(w, h);
          for (let i = 0; i < img.data.length; i++) img.data[i] = Math.random() * 256;
          ctx.putImageData(img, 0, 0);
        } else {
          ctx.fillStyle = '#3a7';
          ctx.fillRect(0, 0, w, h);
        }
        return new Promise((r) => c.toBlob(r, 'image/png'));
      },
      upload: async (id, name, noise = false, src) => {
        await imageDB.put(id, await T.png(200, 120, noise));
        state.items[id] = { id, name, desc: '', stored: true, ...(src && { src }) };
      },
      // Readable snapshot: names instead of random ids.
      snapshot: () => {
        const n = (id) => (id ? state.items[id]?.name ?? '??' : null);
        return {
          title: state.title, size: state.size, slots: state.slots.map(n), pool: state.pool.map(n),
          results: Object.fromEntries(Object.entries(state.results).map(([k, id]) => [k, n(id)])),
          items: Object.values(state.items).map(({ id, ...rest }) => rest).sort((a, b) => a.name.localeCompare(b.name)),
        };
      },
    };
  });
});

const toast = (page) => page.locator('#toast');

async function buildMixedBracket(page) {
  await page.evaluate(async () => {
    state = { title: 'Mixed Bag', size: 8, slots: Array(8).fill(null), results: {}, pool: [], items: {} };
    state.items.a = { id: 'a', name: 'Alpha', desc: 'First of all' };
    state.items.b = { id: 'b', name: 'Bravo', desc: '', url: 'https://img.example.com/bravo.png' };
    await T.upload('c', 'Charlie', false, 'https://upload.wikimedia.org/w/charlie.png'); // from search/URL
    await T.upload('d', 'Delta'); // uploaded file
    state.items.e = { id: 'e', name: 'Echo', desc: '' };
    state.slots = ['a', 'b', 'c', 'd', null, null, null, null];
    state.pool = ['e'];
    state.results = { '0-0': 'b', '0-1': 'd', '1-0': 'b' };
    commit();
  });
}

test('round trip keeps title, size, seeds, pool, picks, descriptions and images', async ({ page }) => {
  await buildMixedBracket(page);
  const before = await page.evaluate(() => T.snapshot());
  const code = await page.evaluate(() => encodeBracket({ picks: true, thumbs: true }));
  expect(code).toMatch(/^[\w-]+$/);

  const payload = await page.evaluate((c) => T.decode(c), code);
  expect(payload).toMatchObject({ v: 1, t: 'Mixed Bag', z: 8, s: [0, 1, 2, 3, -1, -1, -1, -1], p: [4], r: { '0-0': 1, '0-1': 3, '1-0': 1 } });
  expect(payload.i[0]).toEqual({ n: 'Alpha', d: 'First of all' });
  expect(payload.i[1]).toEqual({ n: 'Bravo', u: 'https://img.example.com/bravo.png' });
  expect(payload.i[2]).toEqual({ n: 'Charlie', u: 'https://upload.wikimedia.org/w/charlie.png' }); // web source, not a thumbnail
  expect(payload.i[3].e).toMatch(/^data:image\/webp;base64,/); // upload travels as a thumbnail
  expect(payload.i[3].u).toBeUndefined();

  // Open it as someone else would: a fresh state (cleared storage) with the link.
  await page.evaluate(async (c) => {
    await wipeImages();
    state = defaultState();
    commit();
    await T.open(c);
  }, code);
  const after = await page.evaluate(() => T.snapshot());
  expect(after.title).toBe(before.title);
  expect(after.size).toBe(8);
  expect(after.slots).toEqual(before.slots);
  expect(after.pool).toEqual(before.pool);
  expect(after.results).toEqual(before.results);
  expect(after.items).toEqual([
    { name: 'Alpha', desc: 'First of all' },
    { name: 'Bravo', desc: '', url: 'https://img.example.com/bravo.png', src: 'https://img.example.com/bravo.png' },
    { name: 'Charlie', desc: '', url: 'https://upload.wikimedia.org/w/charlie.png', src: 'https://upload.wikimedia.org/w/charlie.png' },
    { name: 'Delta', desc: '', stored: true },
    { name: 'Echo', desc: '' },
  ]);
  // The thumbnail landed in IndexedDB, at most SHARE_THUMB px.
  const thumb = await page.evaluate(async () => {
    const id = Object.values(state.items).find((it) => it.name === 'Delta').id;
    const blob = await imageDB.get(id);
    const bmp = await createImageBitmap(blob);
    return { type: blob.type, w: bmp.width, h: bmp.height, max: SHARE_THUMB };
  });
  expect(thumb.type).toBe('image/webp');
  expect(Math.max(thumb.w, thumb.h)).toBe(thumb.max);
  await expect(toast(page)).toHaveText('Opened “Mixed Bag”.');
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem(STORE_KEY)).title)).toBe('Mixed Bag');
});

test('without picks the link carries no results', async ({ page }) => {
  await buildMixedBracket(page);
  const payload = await page.evaluate(async () => T.decode(await encodeBracket({ picks: false, thumbs: true })));
  expect(payload.r).toEqual({});
});

test('share dialog: link and note; thumbnails dropped when the link would exceed SHARE_MAX', async ({ page }) => {
  // Text-only: no note.
  await page.evaluate(() => {
    state.items.a = { id: 'a', name: 'A', desc: '' };
    state.pool = ['a'];
    commit();
  });
  await page.evaluate(() => updateShareLink());
  await expect(page.locator('#share-url')).toHaveValue(/\/bracket-maker\/#b=[\w-]+$/);
  await expect(page.locator('#share-note')).toHaveText('');

  // A few small uploads fit as thumbnails.
  await page.evaluate(async () => {
    await T.upload('u1', 'Up 1');
    state.pool.push('u1');
    await updateShareLink();
  });
  await expect(page.locator('#share-note')).toHaveText(/shrunk to small thumbnails/);
  let code = (await page.locator('#share-url').inputValue()).split('#b=')[1];
  expect((await page.evaluate((c) => T.decode(c), code)).i[1].e).toMatch(/^data:image\/webp/);

  // Lots of incompressible uploads don't: fall back to no thumbnails.
  const full = await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      await T.upload(`n${i}`, `Noise ${i}`, true);
      state.pool.push(`n${i}`);
    }
    return (await encodeBracket({ picks: true, thumbs: true })).length;
  });
  expect(full).toBeGreaterThan(await page.evaluate(() => SHARE_MAX));
  await page.evaluate(() => updateShareLink());
  await expect(page.locator('#share-note')).toHaveText(/too big to fit in a link/);
  code = (await page.locator('#share-url').inputValue()).split('#b=')[1];
  expect(code.length).toBeLessThanOrEqual(await page.evaluate(() => SHARE_MAX));
  const payload = await page.evaluate((c) => T.decode(c), code);
  expect(payload.i).toHaveLength(32);
  expect(payload.i.some((it) => it.e)).toBe(false);
  // Opening it gives initials tiles (no image) for those uploads.
  await page.evaluate(async (c) => T.open(c), code);
  expect(await page.evaluate(() => Object.values(state.items).filter((it) => it.stored).length)).toBe(0);
  expect(await page.evaluate(() => Object.keys(state.items).length)).toBe(32);
});

test('v1 links made by the original encoder still open', async ({ page }) => {
  expect(JSON.parse(zlib.inflateRawSync(Buffer.from(V1_CODE, 'base64url')).toString())).toEqual(V1);
  await page.evaluate((c) => T.open(c), V1_CODE);
  const s = await page.evaluate(() => T.snapshot());
  expect(s).toMatchObject({
    title: 'Best Snacks', size: 4,
    slots: ['Popcorn', 'Nachos', 'Chips', 'Pretzel'],
    pool: ['Pocky'],
    results: { '0-0': 'Popcorn' },
  });
  expect(s.items.find((i) => i.name === 'Popcorn').desc).toBe('Buttery');
  expect(s.items.find((i) => i.name === 'Chips').url).toBe('https://img.example.com/chips.png');
  await expect(page.locator('#title')).toHaveText('Best Snacks');
});

test.describe('broken links are rejected without crashing or touching the bracket', () => {
  const cases = {
    'not base64': async () => 'a',
    'not deflate': async () => 'AAAAAAAAAAAAAAAA',
    'not JSON': (page) =>
      page.evaluate(async () => toBase64Url(new Uint8Array(await pipeBytes('hello {', new CompressionStream('deflate-raw')).arrayBuffer()))),
    'JSON null': (page) => page.evaluate(() => T.encodeRaw(null)),
    'unknown version': (page) => page.evaluate(() => T.encodeRaw({ v: 2, t: 'x', z: 2, i: [], s: [] })),
    'bad size': (page) => page.evaluate(() => T.encodeRaw({ v: 1, t: 'x', z: 7, i: [], s: [] })),
    'items not an array': (page) => page.evaluate(() => T.encodeRaw({ v: 1, t: 'x', z: 2, i: {}, s: [] })),
    'no seats': (page) => page.evaluate(() => T.encodeRaw({ v: 1, t: 'x', z: 2, i: [] })),
    'truncated': async (page) => (await page.evaluate(() => T.encodeRaw({ v: 1, t: 'A long enough title', z: 2, i: [{ n: 'A' }], s: [0, -1] }))).slice(0, 12),
  };
  for (const [what, make] of Object.entries(cases)) {
    test(what, async ({ page }) => {
      await page.evaluate(() => {
        state.title = 'Mine';
        state.items.a = { id: 'a', name: 'A', desc: '' };
        state.pool = ['a'];
        commit();
      });
      const code = await make(page);
      await page.evaluate((c) => T.open(c), code);
      await expect(toast(page)).toHaveText('That share link is broken or incomplete.');
      expect(await page.evaluate(() => [state.title, Object.keys(state.items)])).toEqual(['Mine', ['a']]);
      expect(await page.evaluate(() => location.hash)).toBe('');
    });
  }

  test('a hash that is not a share link is ignored', async ({ page }) => {
    await page.evaluate(async () => {
      history.replaceState(null, '', location.pathname + '#b=no spaces!');
      await openSharedLink();
    });
    expect(await page.evaluate(() => location.hash)).toBe('#b=no%20spaces!');
    expect(await page.evaluate(() => state.title)).toBe('My Bracket');
  });
});

test('hand-edited links are sanitised: duplicates, bad indices, unsafe URLs, long names', async ({ page }) => {
  const code = await page.evaluate(() =>
    T.encodeRaw({
      v: 1, t: 'T'.repeat(200), z: 4,
      i: [
        { n: 'N'.repeat(100), d: 'D'.repeat(500) },
        { n: 'Js', u: 'javascript:alert(1)' },
        { n: 'Bad data', e: 'data:text/html;base64,PGI+' },
        { n: 'Leftover' },
        null,
        { n: 42 },
      ],
      s: [0, 0, 99, 1], // 0 twice, 99 doesn't exist
      p: [1, 'x'], // 1 is already seated
      r: { '0-1': 77, '0-0': 0, '1-0': 1 }, // 77 doesn't exist; 0-0 is a bye, not a match
    }));
  await page.evaluate((c) => T.open(c), code);
  const s = await page.evaluate(() => T.snapshot());
  expect(s.title).toHaveLength(80);
  expect(s.slots).toEqual(['N'.repeat(40), null, null, 'Js']);
  expect(s.pool).toEqual(['Bad data', 'Leftover', 'Contender', '42']);
  expect(s.results).toEqual({ '1-0': 'Js' });
  const byName = Object.fromEntries(s.items.map((i) => [i.name, i]));
  expect(byName['N'.repeat(40)].desc).toHaveLength(200);
  expect(byName.Js.url).toBeUndefined();
  expect(byName['Bad data'].stored).toBeUndefined();
});

test('opening a link over an existing bracket asks first; declining keeps it', async ({ page }) => {
  await buildMixedBracket(page);
  confirmAnswer = false;
  await page.evaluate((c) => T.open(c), V1_CODE);
  expect(await page.evaluate(() => state.title)).toBe('Mixed Bag');
  confirmAnswer = true;
  await page.evaluate((c) => T.open(c), V1_CODE);
  expect(await page.evaluate(() => state.title)).toBe('Best Snacks');
  // The old bracket's images were wiped.
  expect(await page.evaluate(async () => [await imageDB.get('c'), await imageDB.get('d')])).toEqual([undefined, undefined]);
});
