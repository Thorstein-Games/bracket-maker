// Building the bracket: size, auto-fill, shuffle, clear, drag & drop, pan & zoom.
'use strict';
const { test, expect, openApp, addNames, appState, nameAt, drag, centre, setState, textItems } = require('../helpers');

const seat = (page, i) => page.locator(`#stage .slot.seed[data-index="${i}"]`);
const poolItem = (page, name) => page.locator('#pool .item', { has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
const seededNames = (page) => page.evaluate(() => state.slots.map((id) => (id ? state.items[id].name : null)));
const poolNames = (page) => page.evaluate(() => state.pool.map((id) => state.items[id].name));
const scale = (page) => page.evaluate(() => view.scale);

test.beforeEach(async ({ page }) => openApp(page));

test('auto-fill seats contenders in seeding order with byes for the top seeds', async ({ page }) => {
  await page.locator('#auto-fill').click();
  await expect(page.locator('#toast')).toHaveText('No contenders waiting — add some below.');
  await addNames(page, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  await page.locator('#auto-fill').click();
  expect(await seededNames(page)).toEqual(['S1', null, 'S4', 'S5', 'S2', null, 'S3', 'S6']);
  await expect(page.locator('#pool .item')).toHaveCount(0);
  await expect(page.locator('#pool-count')).toHaveText('0 waiting · 6 in bracket');
  await expect(seat(page, 1)).toHaveText('Bye');
  await expect(page.locator('#stage .match.playable')).toHaveCount(2);
  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#run')).toHaveText('▶ Run bracket');
  await page.locator('#auto-fill').click();
  await expect(page.locator('#toast')).toHaveText('No contenders waiting — add some below.');
});

test('auto-fill reports contenders that did not fit', async ({ page }) => {
  await page.locator('#size-select').selectOption('4');
  await addNames(page, ['A', 'B', 'C', 'D', 'E', 'F']);
  await page.locator('#auto-fill').click();
  await expect(page.locator('#toast')).toHaveText('2 contenders didn’t fit — pick a bigger size.');
  await page.locator('#auto-fill').click();
  await expect(page.locator('#toast')).toHaveText('The bracket is full. Pick a bigger size to fit more.');
});

test('changing the bracket size reseats contenders and returns overflow to the pool', async ({ page }) => {
  await addNames(page, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  await page.locator('#auto-fill').click();
  await page.locator('#size-select').selectOption('4');
  await expect(page.locator('#stage .match')).toHaveCount(3);
  expect((await appState(page)).size).toBe(4);
  await expect(page.locator('#pool .item')).toHaveCount(2);
  await expect(page.locator('#pool-count')).toHaveText('2 waiting · 4 in bracket');

  await page.locator('#size-select').selectOption('64');
  await expect(page.locator('#stage .match')).toHaveCount(63);
  await expect(page.locator('#stage .slot.seed')).toHaveCount(64);
  await expect(page.locator('#stage .slot.seed .item')).toHaveCount(4);
  await expect(page.locator('.round-label', { hasText: 'Round of 64' })).toHaveCount(2); // both halves

  await page.locator('#size-select').selectOption('2');
  await expect(page.locator('#stage .match')).toHaveCount(1);
  expect((await appState(page)).slots.filter(Boolean)).toHaveLength(2);
  await expect(page.locator('#pool .item')).toHaveCount(4);
  // The whole bracket fits in view after a size change.
  const [vp, stage] = [await page.locator('#viewport').boundingBox(), await page.locator('#stage').boundingBox()];
  expect(stage.width).toBeLessThanOrEqual(vp.width + 1);
});

test('changing size with results asks first; declining keeps everything', async ({ page }) => {
  await setState(page, { size: 2, slots: ['id0', 'id1'], results: { '0-0': 'id0' }, items: textItems(['A', 'B']) });
  page.once('dialog', (d) => d.dismiss());
  await page.locator('#size-select').selectOption('8');
  await expect(page.locator('#size-select')).toHaveValue('2');
  expect((await appState(page)).results).toEqual({ '0-0': 'id0' });
  page.once('dialog', (d) => d.accept());
  await page.locator('#size-select').selectOption('8');
  await expect(page.locator('#stage .match')).toHaveCount(7);
  expect((await appState(page)).results).toEqual({});
});

test('shuffle keeps the same seats filled with the same contenders', async ({ page }) => {
  await page.locator('#shuffle').click();
  await expect(page.locator('#toast')).toHaveText('Put at least two contenders in the bracket first.');
  await addNames(page, ['A', 'B', 'C', 'D', 'E']);
  await page.locator('#auto-fill').click();
  const before = await seededNames(page);
  await page.locator('#shuffle').click();
  const after = await seededNames(page);
  expect(after.map((x) => x === null)).toEqual(before.map((x) => x === null));
  expect([...after].sort()).toEqual([...before].sort());
});

test('clear moves everyone back to the pool; start over wipes everything', async ({ page }) => {
  await addNames(page, ['A', 'B', 'C']);
  await page.locator('#auto-fill').click();
  await page.locator('#clear-bracket').click();
  await expect(page.locator('#stage .slot.seed .item')).toHaveCount(0);
  await expect(page.locator('#pool .item')).toHaveCount(3);
  await page.locator('#auto-fill').click();

  page.once('dialog', (d) => d.dismiss());
  await page.locator('#start-over').click();
  await expect(page.locator('#stage .slot.seed .item')).toHaveCount(3);

  page.once('dialog', (d) => d.accept());
  await page.locator('#start-over').click();
  await expect(page.locator('#stage .slot.seed .item')).toHaveCount(0);
  await expect(page.locator('#pool .item')).toHaveCount(0);
  expect(await appState(page)).toEqual({ title: 'My Bracket', size: 8, slots: Array(8).fill(null), results: {}, pool: [], items: {} });
  await page.reload();
  await expect(page.locator('#pool-count')).toHaveText('0 waiting · 0 in bracket');
});

test('drag: pool → seat, onto a filled seat (swap), seat → seat, seat → pool, to trash', async ({ page }) => {
  await addNames(page, ['A', 'B', 'C']);

  await drag(page, poolItem(page, 'A'), seat(page, 0));
  expect(await nameAt(page, 0)).toBe('A');
  expect(await poolNames(page)).toEqual(['B', 'C']);
  await expect(seat(page, 1)).toHaveText('Bye');

  // Onto a filled seat: the seated one goes back to the pool in the dragged one's place.
  await drag(page, poolItem(page, 'C'), seat(page, 0));
  expect(await nameAt(page, 0)).toBe('C');
  expect(await poolNames(page)).toEqual(['B', 'A']);

  // Seat → empty seat moves; seat → filled seat swaps.
  await drag(page, seat(page, 0).locator('.item'), seat(page, 5));
  expect(await seededNames(page)).toEqual([null, null, null, null, null, 'C', null, null]);
  await drag(page, poolItem(page, 'B'), seat(page, 2));
  await drag(page, seat(page, 2).locator('.item'), seat(page, 5));
  expect(await seededNames(page)).toEqual([null, null, 'C', null, null, 'B', null, null]);

  // Seat → pool unseats.
  await drag(page, seat(page, 2).locator('.item'), page.locator('#pool'));
  expect(await poolNames(page)).toContain('C');
  expect(await nameAt(page, 2)).toBeNull();

  // Trash deletes.
  await drag(page, poolItem(page, 'A'), page.locator('#trash'));
  expect(await poolNames(page)).not.toContain('A');
  expect(Object.values((await appState(page)).items).map((i) => i.name).sort()).toEqual(['B', 'C']);
  // Saved.
  await page.reload();
  expect(await nameAt(page, 5)).toBe('B');
});

test('drag reorders the pool', async ({ page }) => {
  await addNames(page, ['A', 'B', 'C']);
  // Left half of a tile drops before it, right half after it.
  await drag(page, poolItem(page, 'C'), poolItem(page, 'A'), { xFrac: 0.25 });
  expect(await poolNames(page)).toEqual(['C', 'A', 'B']);
  await drag(page, poolItem(page, 'C'), poolItem(page, 'A'), { xFrac: 0.75 });
  expect(await poolNames(page)).toEqual(['A', 'C', 'B']);
  await drag(page, poolItem(page, 'A'), poolItem(page, 'B'), { xFrac: 0.75 });
  expect(await poolNames(page)).toEqual(['C', 'B', 'A']);
});

test('dropping outside any target changes nothing; a click without moving opens the editor', async ({ page }) => {
  await addNames(page, ['A']);
  await drag(page, poolItem(page, 'A'), page.locator('.bracket-tools'));
  expect(await poolNames(page)).toEqual(['A']);
  await drag(page, poolItem(page, 'A'), seat(page, 3));
  await seat(page, 3).locator('.item').click();
  await expect(page.locator('#edit-dialog')).toBeVisible();
  await expect(page.locator('#edit-name')).toHaveValue('A');
});

test('touch drag from the pool to a seat (phone)', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch input is emulated on the phone project');
  await addNames(page, ['Tap']);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const from = await centre(poolItem(page, 'Tap'));
  await touch('touchStart', from.x, from.y);
  for (let i = 1; i <= 3; i++) await touch('touchMove', from.x + 4 * i, from.y - 4 * i);
  await expect(page.locator('body')).toHaveClass(/dragging/);
  const to = await centre(seat(page, 6));
  for (let i = 1; i <= 5; i++) await touch('touchMove', from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5);
  await touch('touchEnd');
  await expect(page.locator('body')).not.toHaveClass(/dragging/);
  expect(await nameAt(page, 6)).toBe('Tap');
});

test('zoom buttons, fit, and panning the background', async ({ page }) => {
  await page.locator('#size-select').selectOption('16');
  const fit = await scale(page);
  await page.locator('#zoom-in').click();
  expect(await scale(page)).toBeCloseTo(fit * 1.25, 5);
  await page.locator('#zoom-in').click();
  expect(await scale(page)).toBeCloseTo(fit * 1.5625, 5);
  await page.locator('#zoom-out').click();
  expect(await scale(page)).toBeCloseTo(fit * 1.25, 5);
  // Zoom is clamped.
  for (let i = 0; i < 30; i++) await page.locator('#zoom-in').click();
  expect(await scale(page)).toBe(await page.evaluate(() => MAX_ZOOM));
  await page.locator('#zoom-fit').click();
  expect(await scale(page)).toBeCloseTo(fit, 5);
  await expect(page.locator('#stage')).toHaveCSS('transform', /matrix/);

  // Pan: drag the background (not a contender).
  const vp = await page.locator('#viewport').boundingBox();
  const before = await page.evaluate(() => ({ ...view }));
  const x = vp.x + 8, y = vp.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 5 });
  await expect(page.locator('#viewport')).toHaveClass(/panning/);
  await page.mouse.up();
  await expect(page.locator('#viewport')).not.toHaveClass(/panning/);
  const after = await page.evaluate(() => ({ ...view }));
  expect(after.x - before.x).toBeCloseTo(60, 0);
  expect(after.y - before.y).toBeCloseTo(40, 0);
  expect(after.scale).toBe(before.scale);
});

test('mouse wheel zooms around the pointer (desktop)', async ({ page, isMobile }) => {
  test.skip(isMobile, 'no wheel on phones');
  const vp = await page.locator('#viewport').boundingBox();
  const before = await scale(page);
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => scale(page)).toBeGreaterThan(before);
  const zoomed = await scale(page);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scale(page)).toBeLessThan(zoomed);
});
