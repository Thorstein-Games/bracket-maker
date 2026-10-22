// Running the bracket: versus screen through to the champion, replays, reset.
'use strict';
const { test, expect, openApp, addNames, appState, setState, textItems } = require('../helpers');

const vs = (page) => ({
  dialog: page.locator('#versus'),
  round: page.locator('#vs-round'),
  progress: page.locator('#vs-progress'),
  names: page.locator('#versus .fighter-name'),
  p1: page.locator('#versus .fighter.p1'),
  p2: page.locator('#versus .fighter.p2'),
  status: page.locator('#vs-status'),
  next: page.locator('#vs-next'),
});

test.beforeEach(async ({ page }) => openApp(page));

test('run a 4-bracket from start to champion', async ({ page }) => {
  await page.locator('#title').evaluate((el) => (el.textContent = 'Food Fight'));
  await page.locator('#title').evaluate((el) => el.dispatchEvent(new Event('blur')));
  await page.locator('#size-select').selectOption('4');
  await addNames(page, ['Pizza', 'Tacos', 'Sushi', 'Ramen']);
  await page.locator('#auto-fill').click();
  await page.locator('#run').click();

  const v = vs(page);
  await expect(v.dialog).toBeVisible();
  await expect(v.round).toHaveText('Semifinals · Match 1 of 2');
  await expect(v.progress).toHaveText('Round 1 of 2');
  await expect(v.names).toHaveText(['Pizza', 'Ramen']); // seed 1 v seed 4
  await expect(v.status).toHaveText('Pick the winner');
  await expect(v.next).toBeHidden();
  await expect(v.p1.locator('.portrait')).toHaveText('PI');

  await v.p1.click();
  await expect(v.status).toHaveText('Pizza advances!');
  await expect(v.p1).toHaveClass(/won/);
  await expect(v.p2).toHaveClass(/lost/);
  await expect(v.next).toHaveText('Next match →');
  await v.next.click();

  await expect(v.round).toHaveText('Semifinals · Match 2 of 2');
  await expect(v.progress).toHaveText('Round 1 of 2');
  await expect(v.names).toHaveText(['Tacos', 'Sushi']);
  await page.keyboard.press('ArrowRight'); // keyboard pick
  await expect(v.status).toHaveText('Sushi advances!');
  await v.next.click();

  await expect(v.round).toHaveText('Final');
  await expect(v.progress).toHaveText('Round 2 of 2');
  await expect(v.names).toHaveText(['Pizza', 'Sushi']);
  await v.p2.click();
  await expect(v.status).toHaveText('Sushi wins it all!');
  await expect(v.next).toHaveText('🏆 Crown the champion');
  await v.next.click();

  await expect(v.dialog).toBeHidden();
  const champ = page.locator('#champion');
  await expect(champ).toBeVisible();
  await expect(page.locator('#champ-name')).toHaveText('Sushi');
  await expect(page.locator('#champ-of')).toHaveText('Food Fight');
  await page.locator('#champ-close').click();
  await expect(champ).toBeHidden();

  await expect(page.locator('#run')).toHaveText('🏆 Show champion');
  await expect(page.locator('.champ-slot.crowned .name')).toHaveText('Sushi');
  const s = await appState(page);
  const name = (id) => s.items[id].name;
  expect(Object.fromEntries(Object.entries(s.results).map(([k, id]) => [k, name(id)]))).toEqual({ '0-0': 'Pizza', '0-1': 'Sushi', '1-0': 'Sushi' });

  // "Show champion" reopens the champion screen.
  await page.locator('#run').click();
  await expect(champ).toBeVisible();
  await expect(page.locator('#champ-name')).toHaveText('Sushi');
});

test('byes are skipped: 3 contenders need only 2 matches', async ({ page }) => {
  await page.locator('#size-select').selectOption('4');
  await addNames(page, ['One', 'Two', 'Three']);
  await page.locator('#auto-fill').click();
  await page.locator('#run').click();
  const v = vs(page);
  await expect(v.names).toHaveText(['Two', 'Three']);
  await expect(v.round).toHaveText('Semifinals · Match 2 of 2');
  await page.keyboard.press('1');
  await v.next.click();
  await expect(v.round).toHaveText('Final');
  await expect(v.names).toHaveText(['One', 'Two']);
  await page.keyboard.press('ArrowLeft');
  await expect(v.status).toHaveText('One wins it all!');
});

test('let fate decide picks one of the two', async ({ page }) => {
  await setState(page, { size: 2, slots: ['id0', 'id1'], items: textItems(['Heads', 'Tails']) });
  await page.locator('#run').click();
  const v = vs(page);
  await expect(v.progress).toHaveText('');
  await page.locator('#vs-random').click();
  await expect(v.status).toHaveText(/^(Heads|Tails) wins it all!$/, { timeout: 10_000 });
  await expect(page.locator('#vs-random')).toBeEnabled();
  const winner = (await v.status.textContent()).split(' wins')[0];
  expect((await appState(page)).results['0-0']).toBe(winner === 'Heads' ? 'id0' : 'id1');
  await expect(page.locator('#versus .fighter.won .fighter-name')).toHaveText(winner);
});

test('replay a match with its VS button; later results it affected are cleared', async ({ page }) => {
  await setState(page, {
    size: 4, slots: ['id0', 'id3', 'id1', 'id2'], items: textItems(['A', 'B', 'C', 'D']),
    results: { '0-0': 'id0', '0-1': 'id1', '1-0': 'id0' },
  });
  await expect(page.locator('#run')).toHaveText('🏆 Show champion');
  await page.locator('.match[data-key="0-0"] .match-go').click();
  const v = vs(page);
  await expect(v.dialog).toBeVisible();
  await expect(v.status).toHaveText('A won this one. Pick again to change it.');
  await expect(v.p1).toHaveClass(/won/);
  await v.p2.click();
  await expect(v.status).toHaveText('D advances!');
  await expect(v.next).toHaveText('Next match →'); // the final has to be replayed
  await page.locator('#vs-close').click();
  await expect(v.dialog).toBeHidden();
  expect((await appState(page)).results).toEqual({ '0-0': 'id3', '0-1': 'id1' });
  await expect(page.locator('#run')).toHaveText('▶ Continue bracket');
  await expect(page.locator('.champ-slot')).not.toHaveClass(/crowned/);
  // Continue goes straight to the open final.
  await page.locator('#run').click();
  await expect(v.round).toHaveText('Final');
  await expect(v.names).toHaveText(['D', 'B']);
  await page.keyboard.press('Escape');
  await expect(v.dialog).toBeHidden();
});

test('reset results clears every pick after confirming', async ({ page }) => {
  await setState(page, { size: 2, slots: ['id0', 'id1'], results: { '0-0': 'id1' }, items: textItems(['A', 'B']) });
  page.once('dialog', (d) => d.dismiss());
  await page.locator('#reset-results').click();
  expect((await appState(page)).results).toEqual({ '0-0': 'id1' });
  page.once('dialog', (d) => d.accept());
  await page.locator('#reset-results').click();
  await expect(page.locator('#run')).toHaveText('▶ Run bracket');
  expect((await appState(page)).results).toEqual({});
  await expect(page.locator('.slot.won')).toHaveCount(0);
});

test('versus screen shows descriptions and images', async ({ page }) => {
  await setState(page, {
    size: 2, slots: ['a', 'b'],
    items: {
      a: { id: 'a', name: 'Lion', desc: 'King of the jungle', url: 'https://img.example.com/lion.png' },
      b: { id: 'b', name: 'Tiger', desc: '' },
    },
  });
  await page.locator('#run').click();
  await expect(page.locator('#versus .fighter-desc').first()).toHaveText('King of the jungle');
  await expect(page.locator('#versus .fighter-desc').nth(1)).toBeHidden();
  const img = page.locator('#versus .fighter.p1 .portrait img');
  await expect(img).toHaveAttribute('src', 'https://img.example.com/lion.png');
  await expect.poll(() => img.evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('#versus .fighter.p2 .portrait')).toHaveText('TI');
});
