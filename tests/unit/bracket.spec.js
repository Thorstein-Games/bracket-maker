// Bracket logic in app.js: seeding, derived matches, byes, pruning, champion, labels.
'use strict';
const { test, expect, openApp } = require('../helpers');

test.beforeEach(async ({ page }) => {
  await openApp(page);
  // In-page helpers: n contenders "C1".."Cn" with ids "c1".."cn".
  await page.evaluate(() => {
    window.T = {
      items: (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, { id: `c${i + 1}`, name: `C${i + 1}`, desc: '' }])),
      // Seat n contenders the way Auto-fill does (seed i -> spreadOrder seat).
      seeded: (size, n, results = {}) => {
        const items = T.items(n);
        state = { title: 'T', size, slots: seat(Object.keys(items), size), results, pool: [], items };
        return computeBracket();
      },
      // Pick side a (or a function's choice) for every playable match until done.
      playAll: (pick = (m) => m.a) => {
        for (let guard = 0; guard < 200; guard++) {
          const next = nextMatch(computeBracket());
          if (!next) break;
          state.results[next.key] = pick(next);
        }
        return computeBracket();
      },
    };
  });
});

test.describe('spreadOrder', () => {
  test('8 seats in standard seeding order: 1v8, 4v5, 2v7, 3v6', async ({ page }) => {
    const order = await page.evaluate(() => spreadOrder(8));
    expect(order).toEqual([0, 4, 6, 2, 3, 7, 5, 1]);
    // Read back as first-round pairs of 1-based seeds.
    const seatToSeed = [];
    order.forEach((seatIdx, seed) => (seatToSeed[seatIdx] = seed + 1));
    const pairs = [];
    for (let i = 0; i < 8; i += 2) pairs.push([seatToSeed[i], seatToSeed[i + 1]]);
    expect(pairs).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
  });

  test('small sizes', async ({ page }) => {
    expect(await page.evaluate(() => spreadOrder(2))).toEqual([0, 1]);
    expect(await page.evaluate(() => spreadOrder(4))).toEqual([0, 2, 3, 1]);
  });

  for (const size of [2, 4, 8, 16, 32, 64]) {
    test(`size ${size}: a permutation, every first-round pair sums to size+1, seeds 1 and 2 in opposite halves`, async ({ page }) => {
      const order = await page.evaluate((s) => spreadOrder(s), size);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, i) => i));
      const seatToSeed = [];
      order.forEach((seatIdx, seed) => (seatToSeed[seatIdx] = seed + 1));
      for (let i = 0; i < size; i += 2) expect(seatToSeed[i] + seatToSeed[i + 1]).toBe(size + 1);
      expect(order[0] < size / 2).not.toBe(order[1] < size / 2);
    });
  }
});

test.describe('computeBracket', () => {
  for (const size of [2, 4, 8, 16, 32, 64]) {
    test(`full bracket of ${size}: ${Math.log2(size)} rounds, all first-round matches playable, later ones waiting`, async ({ page }) => {
      const b = await page.evaluate((s) => T.seeded(s, s), size);
      expect(b.rounds.length).toBe(Math.log2(size));
      b.rounds.forEach((round, r) => {
        expect(round.length).toBe(size / 2 ** (r + 1));
        round.forEach((m, i) => {
          expect(m.key).toBe(`${r}-${i}`);
          expect(m.r).toBe(r);
          expect(m.m).toBe(i);
        });
      });
      expect(b.rounds[0].every((m) => m.playable && m.winner === null)).toBe(true);
      for (const round of b.rounds.slice(1)) expect(round.every((m) => m.a === null && m.b === null && !m.playable)).toBe(true);
      expect(b.champion).toBeNull();
    });
  }

  // Contender counts that don't fill the bracket: byes go to the top seeds and auto-advance.
  for (const [n, size] of [[3, 4], [5, 8], [6, 8], [13, 16], [33, 64]]) {
    test(`${n} contenders in a ${size} bracket: ${size - n} byes go to seeds 1–${size - n} and auto-advance`, async ({ page }) => {
      const res = await page.evaluate(([n, s]) => {
        const b = T.seeded(s, n);
        return { b, BYE };
      }, [n, size]);
      const { b, BYE } = res;
      const byes = size - n;
      const first = b.rounds[0];
      const byeMatches = first.filter((m) => m.a === BYE || m.b === BYE);
      expect(byeMatches.length).toBe(byes);
      expect(first.filter((m) => m.playable).length).toBe(n - size / 2);
      // Byes never face each other here, and the free pass goes to the top seeds.
      expect(byeMatches.every((m) => !m.playable && m.winner && m.winner !== BYE)).toBe(true);
      expect(byeMatches.map((m) => m.winner).sort()).toEqual(Array.from({ length: byes }, (_, i) => `c${i + 1}`).sort());
      // Their winners already sit in round 2.
      const round2 = b.rounds[1].flatMap((m) => [m.a, m.b]);
      for (const m of byeMatches) expect(round2).toContain(m.winner);
    });
  }

  test('3 in a 4: the top seed waits in the final for the 2v3 winner', async ({ page }) => {
    const b = await page.evaluate(() => T.seeded(4, 3));
    expect(b.rounds.length).toBe(2);
    const [m0, m1] = b.rounds[0];
    expect([m0.a, m0.b]).toEqual(['c1', 'bye']);
    expect(m0.winner).toBe('c1');
    expect([m1.a, m1.b].sort()).toEqual(['c2', 'c3']);
    expect(m1.playable).toBe(true);
    const final = b.rounds[1][0];
    expect(final.a).toBe('c1');
    expect(final.b).toBeNull(); // pending: waits on match 0-1
    expect(final.playable).toBe(false);
  });

  test('BYE vs BYE: an empty match produces a BYE that passes the opponent through', async ({ page }) => {
    const b = await page.evaluate(() => {
      state = { title: 'T', size: 4, slots: ['c1', 'c2', null, null], results: {}, pool: [], items: T.items(2) };
      return computeBracket();
    });
    const empty = b.rounds[0][1];
    expect([empty.a, empty.b, empty.winner, empty.playable]).toEqual(['bye', 'bye', 'bye', false]);
    const final = b.rounds[1][0];
    expect(final.a).toBeNull(); // waits on c1 v c2
    expect(final.b).toBe('bye');
    expect(final.playable).toBe(false);
  });

  test('a whole half of byes: the other half winner walks into the final and becomes champion', async ({ page }) => {
    const b = await page.evaluate(() => {
      state = { title: 'T', size: 8, slots: ['c1', 'c2', 'c3', 'c4', null, null, null, null], results: {}, pool: [], items: T.items(4) };
      return T.playAll();
    });
    expect(b.rounds[2][0].b).toBe('bye');
    expect(b.champion).toBe('c1');
  });

  test('an empty bracket has no champion and nothing playable', async ({ page }) => {
    const b = await page.evaluate(() => {
      state = defaultState();
      return computeBracket();
    });
    expect(b.rounds.flat().every((m) => !m.playable && m.winner === 'bye')).toBe(true);
    expect(b.champion).toBeNull();
  });

  test('a lone contender is not a champion (needs at least two)', async ({ page }) => {
    const b = await page.evaluate(() => T.seeded(8, 1));
    expect(b.rounds[2][0].winner).toBe('c1');
    expect(b.champion).toBeNull();
  });

  test('seats pointing at deleted items count as byes', async ({ page }) => {
    const b = await page.evaluate(() => {
      state = { title: 'T', size: 2, slots: ['c1', 'ghost'], results: {}, pool: [], items: T.items(1) };
      return computeBracket();
    });
    expect(b.rounds[0][0].b).toBe('bye');
    expect(b.rounds[0][0].winner).toBe('c1');
  });

  test('a stored result only counts if it names one of the two sides', async ({ page }) => {
    const b = await page.evaluate(() => T.seeded(4, 4, { '0-0': 'c3', '0-1': 'c2' }));
    // Seats: c1 c4 | c2 c3
    expect(b.rounds[0][0].winner).toBeNull();
    expect(b.rounds[0][1].winner).toBe('c2');
    expect(b.rounds[1][0].a).toBeNull();
    expect(b.rounds[1][0].b).toBe('c2');
  });

  for (const size of [2, 8, 16, 64]) {
    test(`playing every match of a full ${size} crowns the champion after ${size - 1} matches`, async ({ page }) => {
      const res = await page.evaluate((s) => {
        T.seeded(s, s);
        let count = 0;
        const b = T.playAll((m) => (count++, m.b));
        return { b, count, results: Object.keys(state.results).length };
      }, size);
      expect(res.count).toBe(size - 1);
      expect(res.results).toBe(size - 1);
      expect(res.b.champion).toBe(res.b.rounds.at(-1)[0].winner);
      expect(res.b.champion).toMatch(/^c\d+$/);
    });
  }

  test('nextMatch plays round by round, top to bottom', async ({ page }) => {
    const keys = await page.evaluate(() => {
      T.seeded(8, 8);
      const out = [];
      for (let m; (m = nextMatch(computeBracket())); ) {
        out.push(m.key);
        state.results[m.key] = m.a;
      }
      return out;
    });
    expect(keys).toEqual(['0-0', '0-1', '0-2', '0-3', '1-0', '1-1', '2-0']);
  });

  test('roundName', async ({ page }) => {
    const names = await page.evaluate(() => [0, 1, 2, 3, 4, 5].map((r) => roundName(r, 6)));
    expect(names).toEqual(['Round of 64', 'Round of 32', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Final']);
    expect(await page.evaluate(() => roundName(0, 1))).toBe('Final');
  });
});

test.describe('pruning results (commit)', () => {
  test('moving a contender upstream drops the results it affected and keeps the rest', async ({ page }) => {
    const res = await page.evaluate(() => {
      T.seeded(8, 8);
      T.playAll();
      commit();
      const before = { ...state.results };
      // Replace c1 (who won everything) with a new contender: 0-0 and c1's path (1-0, 2-0) must go.
      state.items.x = { id: 'x', name: 'X', desc: '' };
      state.slots[state.slots.indexOf('c1')] = 'x';
      commit();
      return { before, after: { ...state.results }, saved: JSON.parse(localStorage.getItem(STORE_KEY)).results };
    });
    expect(Object.keys(res.before).sort()).toEqual(['0-0', '0-1', '0-2', '0-3', '1-0', '1-1', '2-0']);
    expect(res.after).toEqual({ '0-1': res.before['0-1'], '0-2': res.before['0-2'], '0-3': res.before['0-3'], '1-1': res.before['1-1'] });
    expect(res.saved).toEqual(res.after);
  });

  test('changing an earlier pick clears later results that depended on the old winner', async ({ page }) => {
    const res = await page.evaluate(() => {
      T.seeded(4, 4);
      T.playAll((m) => m.a); // c1 beats c4, c2 beats c3, c1 beats c2
      commit();
      state.results['0-0'] = 'c4';
      commit();
      return { results: state.results, champion: computeBracket().champion };
    });
    expect(res.results).toEqual({ '0-0': 'c4', '0-1': 'c2' });
    expect(res.champion).toBeNull();
  });

  test('re-picking the same winner keeps later results', async ({ page }) => {
    const res = await page.evaluate(() => {
      T.seeded(4, 4);
      T.playAll();
      commit();
      state.results['0-0'] = 'c1';
      commit();
      return Object.keys(state.results).length;
    });
    expect(res).toBe(3);
  });

  test('removing a contender drops its results; its opponent advances on a bye', async ({ page }) => {
    const res = await page.evaluate(() => {
      T.seeded(4, 4);
      T.playAll();
      commit();
      removeItem('c4');
      commit();
      const b = computeBracket();
      return { results: state.results, items: Object.keys(state.items), slots: state.slots, champion: b.champion };
    });
    expect(res.items).not.toContain('c4');
    expect(res.slots).not.toContain('c4');
    // 0-0 is now c1 v bye: not playable, so its result goes; c1's final win stands.
    expect(res.results).toEqual({ '0-1': 'c2', '1-0': 'c1' });
    expect(res.champion).toBe('c1');
  });

  test('results for matches that are not playable are dropped', async ({ page }) => {
    const results = await page.evaluate(() => {
      T.seeded(4, 3, { '0-0': 'c1', '1-0': 'c1', '9-9': 'c2' });
      commit();
      return state.results;
    });
    expect(results).toEqual({});
  });
});

test.describe('rendering', () => {
  // A seat's contender name, or the placeholder text of an empty seat.
  const labels = (page, key) =>
    page.locator(`.match[data-key="${key}"] .slot`).evaluateAll((els) => els.map((s) => (s.querySelector('.name') || s).textContent));

  test('empty seats: "Bye" only facing a contender, "Empty" when both seats are empty, "—" later, "TBD" while waiting', async ({ page }) => {
    await page.evaluate(() => {
      state = { title: 'T', size: 8, slots: ['c1', null, 'c2', 'c3', null, null, null, null], results: {}, pool: [], items: T.items(3) };
      commit();
    });
    expect(await labels(page, '0-0')).toEqual(['C1', 'Bye']);
    expect(await labels(page, '0-1')).toEqual(['C2', 'C3']);
    expect(await labels(page, '0-2')).toEqual(['Empty', 'Empty']);
    expect(await labels(page, '0-3')).toEqual(['Empty', 'Empty']);
    expect(await labels(page, '1-0')).toEqual(['C1', 'TBD']);
    expect(await labels(page, '1-1')).toEqual(['—', '—']);
    expect(await labels(page, '2-0')).toEqual(['TBD', 'Bye']);
    await expect(page.locator('.match[data-key="0-0"] .slot').nth(1)).toHaveClass(/empty/);
    // Only real matches get a VS button and the "pending" pulse.
    await expect(page.locator('.match.playable')).toHaveCount(1);
    await expect(page.locator('.match.pending .match-go')).toHaveCount(1);
  });

  test('won/lost classes, live connectors, champion box and the Run button label', async ({ page }) => {
    await page.evaluate(() => { T.seeded(2, 2); commit(); });
    await expect(page.locator('#run')).toHaveText('▶ Run bracket');
    await expect(page.locator('#run')).toBeEnabled();
    await expect(page.locator('.champ-slot')).toHaveText(/Champion/);
    await page.evaluate(() => { state.results['0-0'] = 'c2'; commit(); });
    await expect(page.locator('.slot.won .name')).toHaveText('C2');
    await expect(page.locator('.slot.lost .name')).toHaveText('C1');
    await expect(page.locator('.champ-slot.crowned .name')).toHaveText('C2');
    await expect(page.locator('#run')).toHaveText('🏆 Show champion');

    await page.evaluate(() => { T.seeded(4, 4, { '0-0': 'c1' }); commit(); });
    await expect(page.locator('#run')).toHaveText('▶ Continue bracket');
    await expect(page.locator('#stage svg path.live')).toHaveCount(1);
    await expect(page.locator('#stage svg path')).toHaveCount(2);

    await page.evaluate(() => { T.seeded(4, 1); commit(); });
    await expect(page.locator('#run')).toBeDisabled();
  });

  test('stage sizes, round labels and first-round seats for each size', async ({ page }) => {
    for (const size of [2, 4, 8, 16, 32, 64]) {
      await page.evaluate((s) => { T.seeded(s, s); commit(); }, size);
      await expect(page.locator('#stage .match')).toHaveCount(size - 1);
      await expect(page.locator('#stage .slot.seed .item')).toHaveCount(size);
      const seatIdx = await page.locator('#stage .slot.seed').evaluateAll((els) => els.map((e) => Number(e.dataset.index)).sort((a, b) => a - b));
      expect(seatIdx).toEqual(Array.from({ length: size }, (_, i) => i));
      await expect(page.locator('.round-label', { hasText: /^Final$/ })).toHaveCount(1);
    }
  });

  test('versus screen: round name, match number and "Round X of Y" progress', async ({ page }) => {
    const read = async () => [await page.locator('#vs-round').textContent(), await page.locator('#vs-progress').textContent()];
    await page.evaluate(() => { T.seeded(8, 8); commit(); openMatch(computeBracket().rounds[0][2]); });
    expect(await read()).toEqual(['Quarterfinals · Match 3 of 4', 'Round 1 of 3']);
    await page.evaluate(() => { T.playAll(); commit(); openMatch(computeBracket().rounds[1][1]); });
    expect(await read()).toEqual(['Semifinals · Match 2 of 2', 'Round 2 of 3']);
    await page.evaluate(() => openMatch(computeBracket().rounds[2][0]));
    expect(await read()).toEqual(['Final', 'Round 3 of 3']);
    await expect(page.locator('#vs-status')).toHaveText('C1 won this one. Pick again to change it.');
    await page.evaluate(() => { vsDialog.close(); T.seeded(64, 64); commit(); openMatch(computeBracket().rounds[0][31]); });
    expect(await read()).toEqual(['Round of 64 · Match 32 of 32', 'Round 1 of 6']);
    await page.evaluate(() => { vsDialog.close(); T.seeded(2, 2); commit(); openMatch(computeBracket().rounds[0][0]); });
    expect(await read()).toEqual(['Final', '']);
  });
});
