'use strict';

/* =========================================================
   Bracket Maker — client-side only.
   Bracket layout (seeds, results, contenders) lives in localStorage.
   Image blobs live in IndexedDB. Uploaded images are downscaled first.
   The bracket is a pan/zoom "stage": plain DOM scaled with a CSS transform.
   ========================================================= */

const STORE_KEY = 'bracket-maker:v1';
const SIZES = [2, 4, 8, 16, 32, 64];
const MAX_IMAGE_SIDE = 512; // px; versus-screen portraits are large
const BYE = 'bye';

// Stage geometry (px, before zoom).
const SLOT_W = 180;
const SLOT_H = 38;
const SLOT_GAP = 2;
const MATCH_H = SLOT_H * 2 + SLOT_GAP;
const MATCH_SPACE = 22; // vertical gap between first-round matches
const COL_GAP = 56;
const TOP = 190; // room above the final for the champion box
const PAD = 24;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2.5;

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ---------------- IndexedDB (image blobs) ---------------- */
const imageDB = (() => {
  let dbPromise;
  const open = () =>
    (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('bracket-maker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      const req = fn(tx.objectStore('images'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, blob) => run('readwrite', (s) => s.put(blob, key)),
    del: (key) => run('readwrite', (s) => s.delete(key)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();

navigator.storage?.persist?.().catch(() => {});

/* ---------------- state ---------------- */
function defaultState() {
  return {
    title: 'My Bracket',
    size: 8,
    slots: Array(8).fill(null), // first-round seats, top to bottom; null = bye
    results: {}, // "round-match" -> winner id
    pool: [],
    items: {}, // id -> { id, name, desc, url?, stored? }
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && SIZES.includes(s.size) && s.slots?.length === s.size && Array.isArray(s.pool) && s.items) {
      s.results ||= {};
      return s;
    }
  } catch {}
  return defaultState();
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save — browser storage is full or blocked.');
  }
}

/* ---------------- bracket logic ---------------- */
const roundsFor = (size) => Math.log2(size);

function roundName(r, rounds) {
  const left = rounds - r;
  if (left === 1) return 'Final';
  if (left === 2) return 'Semifinals';
  if (left === 3) return 'Quarterfinals';
  return `Round of ${2 ** left}`;
}

// Derive every match from the seeds and stored results. A side is an item id,
// BYE (nobody will ever be there) or null (waiting on an earlier match).
function computeBracket() {
  const rounds = [];
  let entrants = state.slots.map((id) => (id && state.items[id] ? id : BYE));
  for (let r = 0; r < roundsFor(state.size); r++) {
    const matches = [];
    for (let m = 0; m < entrants.length / 2; m++) {
      const a = entrants[2 * m], b = entrants[2 * m + 1];
      const key = `${r}-${m}`;
      const playable = !!a && !!b && a !== BYE && b !== BYE;
      let winner = null;
      if (a === BYE) winner = b;
      else if (b === BYE) winner = a;
      else if (playable && [a, b].includes(state.results[key])) winner = state.results[key];
      matches.push({ r, m, key, a, b, winner, playable });
    }
    rounds.push(matches);
    entrants = matches.map((x) => x.winner);
  }
  const last = rounds[rounds.length - 1][0].winner;
  return { rounds, champion: last && last !== BYE && seededCount() > 1 ? last : null };
}

// Drop results that no longer apply (seeds changed, an earlier pick changed).
function pruneResults(bracket) {
  const keep = {};
  for (const match of bracket.rounds.flat()) if (match.playable && match.winner) keep[match.key] = match.winner;
  state.results = keep;
}

const nextMatch = (bracket) => bracket.rounds.flat().find((x) => x.playable && !x.winner);
const seededCount = () => state.slots.filter(Boolean).length;

function commit() {
  pruneResults(computeBracket());
  save();
  render();
}

// Seats in standard seeding order (1v8, 4v5, 2v7, 3v6…): contenders spread across
// the whole bracket, and any byes go to the top seeds.
function spreadOrder(size) {
  let seeds = [0];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    seeds = seeds.flatMap((s) => [s, n - 1 - s]);
  }
  const order = [];
  seeds.forEach((seed, seatIdx) => (order[seed] = seatIdx));
  return order;
}

/* ---------------- elements ---------------- */
const titleEl = $('#title');
const baseTitle = document.title;
const syncDocTitle = () => (document.title = state.title === 'My Bracket' ? baseTitle : `${state.title} – Bracket Maker`);
const viewportEl = $('#viewport');
const stageEl = $('#stage');
const poolEl = $('#pool');
const sizeSelect = $('#size-select');
const runBtn = $('#run');
const trashEl = $('#trash');
const toastEl = $('#toast');

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* ---------------- rendering ---------------- */
const objectUrls = new Map(); // item id -> blob: URL

async function imageSrc(item) {
  if (!item.stored) return item.url || '';
  if (objectUrls.has(item.id)) return objectUrls.get(item.id);
  const blob = await imageDB.get(item.id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  objectUrls.set(item.id, url);
  return url;
}

function hueFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 100003;
  return Math.round(h * 137.508) % 360; // golden angle: similar names get distinct hues
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : [...(words[0] || '?')].slice(0, 2).join('')).toUpperCase();
}

// Image, or a colored initials tile for name-only contenders.
function makePortrait(item, el = document.createElement('span')) {
  el.classList.add('portrait');
  el.replaceChildren();
  el.classList.remove('broken');
  if (item.stored || item.url) {
    const img = new Image();
    img.draggable = false;
    img.alt = '';
    img.onerror = () => el.classList.add('broken');
    imageSrc(item).then((src) => (src ? (img.src = src) : el.classList.add('broken')));
    el.style.background = '';
    el.append(img);
  } else {
    el.textContent = initials(item.name);
    el.style.background = `hsl(${hueFor(item.name)} 45% 38%)`;
  }
  return el;
}

// Same markup in the pool (tile) and in a bracket slot (row); CSS decides the look.
function makeItemEl(item, cls = 'item') {
  const el = document.createElement('div');
  el.className = cls;
  el.dataset.id = item.id;
  el.title = item.desc ? `${item.name} — ${item.desc}` : item.name;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;
  el.append(makePortrait(item), name);
  return el;
}

function renderPool() {
  poolEl.replaceChildren(...state.pool.map((id) => state.items[id]).filter(Boolean).map((it) => makeItemEl(it)));
  $('#pool-count').textContent = `${state.pool.length} waiting · ${seededCount()} in bracket`;
}

function layout(rounds) {
  const col = SLOT_W + COL_GAP;
  if (rounds === 1) {
    return { width: SLOT_W, height: TOP + MATCH_H, pos: () => ({ x: 0, y: TOP, side: 'center' }) };
  }
  const unit = MATCH_H + MATCH_SPACE;
  const half = state.size / 4; // first-round matches per side
  const pos = (r, m) => {
    if (r === rounds - 1) return { x: (rounds - 1) * col, y: TOP + (half * unit) / 2 - MATCH_H / 2, side: 'center' };
    const perSide = half / 2 ** r;
    const right = m >= perSide;
    const k = m % perSide;
    const y = TOP + (k + 0.5) * unit * 2 ** r - MATCH_H / 2;
    return { x: (right ? 2 * rounds - 2 - r : r) * col, y, side: right ? 'right' : 'left' };
  };
  return { width: (2 * rounds - 2) * col + SLOT_W, height: TOP + half * unit, pos };
}

function slotEl(match, sideIdx) {
  const id = sideIdx ? match.b : match.a;
  const slot = document.createElement('div');
  slot.className = 'slot';
  if (match.r === 0) {
    slot.classList.add('seed');
    slot.dataset.index = match.m * 2 + sideIdx;
  }
  if (id && id !== BYE) {
    slot.append(makeItemEl(state.items[id], match.r === 0 ? 'item' : 'entry'));
    if (match.playable && match.winner) slot.classList.add(match.winner === id ? 'won' : 'lost');
  } else {
    slot.classList.add('empty');
    // Only call it a bye when someone is (or will be) on the other side to advance.
    const other = sideIdx ? match.a : match.b;
    if (id !== BYE) slot.textContent = 'TBD';
    else if (other !== BYE) slot.textContent = 'Bye';
    else slot.textContent = match.r === 0 ? 'Empty' : '—';
  }
  return slot;
}

function renderStage() {
  const bracket = computeBracket();
  const rounds = bracket.rounds.length;
  const { width, height, pos } = layout(rounds);
  stageEl.style.width = width + PAD * 2 + 'px';
  stageEl.style.height = height + PAD * 2 + 'px';

  const nodes = [];
  const paths = [];
  const at = (r, m) => { const p = pos(r, m); return { ...p, x: p.x + PAD, y: p.y + PAD }; };

  // Column labels for the side rounds; the final is labelled above its match.
  const labelled = new Set();
  for (const match of bracket.rounds.flat()) {
    const p = at(match.r, match.m);
    const labelKey = `${match.r}-${p.side}`;
    if (!labelled.has(labelKey)) {
      labelled.add(labelKey);
      const label = document.createElement('div');
      label.className = 'round-label';
      label.textContent = roundName(match.r, rounds);
      label.style.left = p.x + 'px';
      label.style.top = (p.side === 'center' ? p.y - 26 : PAD + TOP - 30) + 'px';
      nodes.push(label);
    }

    const el = document.createElement('div');
    el.className = `match ${p.side}`;
    el.dataset.key = match.key;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    if (match.playable) el.classList.add('playable');
    if (match.playable && !match.winner) el.classList.add('pending');
    el.append(slotEl(match, 0), slotEl(match, 1));
    if (match.playable) {
      const go = document.createElement('button');
      go.className = 'match-go';
      go.type = 'button';
      go.textContent = 'VS';
      go.title = match.winner ? 'Replay this match' : 'Play this match';
      el.append(go);
    }
    nodes.push(el);

    // Connector into the next round.
    if (match.r < rounds - 1) {
      const t = at(match.r + 1, match.m >> 1);
      const ty = t.y + (match.m & 1 ? SLOT_H + SLOT_GAP : 0) + SLOT_H / 2;
      const sy = p.y + MATCH_H / 2;
      const fromRight = p.side === 'right';
      const sx = fromRight ? p.x : p.x + SLOT_W;
      const tx = fromRight ? t.x + SLOT_W : t.x;
      const mx = (sx + tx) / 2;
      const live = match.winner && match.winner !== BYE;
      paths.push(`<path class="${live ? 'live' : ''}" d="M${sx} ${sy}H${mx}V${ty}H${tx}"/>`);
    }
  }

  // Champion box above the final.
  const f = at(rounds - 1, 0);
  const champ = document.createElement('div');
  champ.className = 'champ-slot';
  champ.style.left = f.x + 'px';
  champ.style.top = f.y - 34 - 140 + 'px';
  if (bracket.champion) {
    champ.classList.add('crowned');
    champ.append(makeItemEl(state.items[bracket.champion], 'entry'));
  } else {
    champ.innerHTML = '<span class="trophy">🏆</span><span class="name">Champion</span>';
  }
  nodes.push(champ);

  const svg = `<svg class="lines" width="${width + PAD * 2}" height="${height + PAD * 2}" aria-hidden="true">${paths.join('')}</svg>`;
  stageEl.innerHTML = svg;
  stageEl.append(...nodes);

  runBtn.disabled = seededCount() < 2;
  runBtn.textContent = bracket.champion ? '🏆 Show champion' : Object.keys(state.results).length ? '▶ Continue bracket' : '▶ Run bracket';
}

function render() {
  titleEl.textContent = state.title;
  syncDocTitle();
  sizeSelect.value = state.size;
  renderPool();
  renderStage();
}

/* ---------------- pan & zoom ---------------- */
const view = { x: 0, y: 0, scale: 1 };

function applyView() {
  stageEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function zoomAt(factor, cx, cy) {
  const scale = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM);
  const k = scale / view.scale;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.scale = scale;
  applyView();
}

function fitView() {
  const vw = viewportEl.clientWidth, vh = viewportEl.clientHeight;
  const sw = stageEl.offsetWidth, sh = stageEl.offsetHeight;
  view.scale = clamp(Math.min(vw / sw, vh / sh, 1), MIN_ZOOM, MAX_ZOOM);
  view.x = (vw - sw * view.scale) / 2;
  view.y = (vh - sh * view.scale) / 2;
  applyView();
}

const viewCenter = () => [viewportEl.clientWidth / 2, viewportEl.clientHeight / 2];
$('#zoom-in').addEventListener('click', () => zoomAt(1.25, ...viewCenter()));
$('#zoom-out').addEventListener('click', () => zoomAt(0.8, ...viewCenter()));
$('#zoom-fit').addEventListener('click', fitView);

viewportEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = viewportEl.getBoundingClientRect();
  const speed = e.ctrlKey ? 0.01 : e.deltaMode ? 0.05 : 0.0015; // ctrlKey = trackpad pinch
  zoomAt(Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// One pointer pans, two pinch-zoom. Capture only once it's really a pan,
// so taps on buttons inside the stage still click.
const pans = new Map();
let panMoved = false;

viewportEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.item, .zoom-controls') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pans.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  if (pans.size === 1) panMoved = false;
});

viewportEl.addEventListener('pointermove', (e) => {
  const p = pans.get(e.pointerId);
  if (!p) return;
  if (!panMoved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 5 && pans.size === 1) return;
  if (!panMoved) {
    panMoved = true;
    viewportEl.classList.add('panning');
  }
  if (!viewportEl.hasPointerCapture(e.pointerId)) viewportEl.setPointerCapture(e.pointerId);
  if (pans.size === 1) {
    view.x += e.clientX - p.x;
    view.y += e.clientY - p.y;
    applyView();
  } else if (pans.size === 2) {
    const other = [...pans.entries()].find(([id]) => id !== e.pointerId)[1];
    const r = viewportEl.getBoundingClientRect();
    const before = Math.hypot(p.x - other.x, p.y - other.y);
    const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
    view.x += (e.clientX - p.x) / 2;
    view.y += (e.clientY - p.y) / 2;
    if (before > 0) zoomAt(after / before, (e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top);
    else applyView();
  }
  p.x = e.clientX;
  p.y = e.clientY;
});

const endPan = (e) => {
  if (!pans.delete(e.pointerId)) return;
  if (!pans.size) viewportEl.classList.remove('panning');
};
viewportEl.addEventListener('pointerup', endPan);
viewportEl.addEventListener('pointercancel', endPan);

let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitView, 150); });

/* ---------------- bracket controls ---------------- */
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
titleEl.addEventListener('blur', () => {
  state.title = titleEl.textContent.trim().slice(0, 80) || 'My Bracket';
  titleEl.textContent = state.title;
  syncDocTitle();
  save();
});

const hasResults = () => Object.keys(state.results).length > 0;
const okToLoseResults = () => !hasResults() || confirm('This will clear the match results so far. Continue?');

function seat(ids, size) {
  const slots = Array(size).fill(null);
  spreadOrder(size).forEach((seatIdx, i) => { if (i < ids.length) slots[seatIdx] = ids[i]; });
  return slots;
}

sizeSelect.addEventListener('change', () => {
  const size = Number(sizeSelect.value);
  if (!okToLoseResults()) { sizeSelect.value = state.size; return; }
  const seeded = state.slots.filter(Boolean);
  state.pool.unshift(...seeded.slice(size));
  state.size = size;
  state.slots = seat(seeded.slice(0, size), size);
  state.results = {};
  commit();
  fitView();
});

$('#auto-fill').addEventListener('click', () => {
  if (!state.pool.length) return toast('No contenders waiting — add some below.');
  const empty = spreadOrder(state.size).filter((i) => !state.slots[i]);
  if (!empty.length) return toast('The bracket is full. Pick a bigger size to fit more.');
  for (const i of empty) if (state.pool.length) state.slots[i] = state.pool.shift();
  commit();
  if (state.pool.length) toast(`${state.pool.length} contender${state.pool.length > 1 ? 's' : ''} didn’t fit — pick a bigger size.`);
});

$('#shuffle').addEventListener('click', () => {
  const seats = state.slots.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);
  if (seats.length < 2) return toast('Put at least two contenders in the bracket first.');
  if (!okToLoseResults()) return;
  const ids = seats.map((i) => state.slots[i]);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  seats.forEach((seatIdx, i) => (state.slots[seatIdx] = ids[i]));
  state.results = {};
  commit();
});

$('#clear-bracket').addEventListener('click', () => {
  if (!seededCount() || !okToLoseResults()) return;
  state.pool.push(...state.slots.filter(Boolean));
  state.slots = Array(state.size).fill(null);
  state.results = {};
  commit();
});

$('#reset-results').addEventListener('click', () => {
  if (!hasResults() || !confirm('Clear every match result?')) return;
  state.results = {};
  commit();
});

async function wipeImages() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  try { await imageDB.clear(); } catch {}
}

$('#start-over').addEventListener('click', async () => {
  if (!confirm('Delete all contenders, images and results and start fresh?')) return;
  await wipeImages();
  state = defaultState();
  commit();
  fitView();
});

/* ---------------- adding contenders ---------------- */
function addItem(item) {
  state.items[item.id] = item;
  state.pool.push(item.id);
  save();
  renderPool();
}

const cleanName = (s) => s.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Contender';

$('#text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#text-input');
  const name = input.value.trim().slice(0, 40);
  if (!name) return;
  addItem({ id: uid(), name, desc: '' });
  input.value = '';
  input.focus();
});

// Downscale to keep storage small; fall back to the original if decoding fails (e.g. some SVGs).
async function shrinkImage(blob, side = MAX_IMAGE_SIDE, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const out = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  }
}

// src: where the image came from on the web, so share links can point at it.
async function addImageBlob(blob, name, src) {
  const id = uid();
  try {
    await imageDB.put(id, await shrinkImage(blob));
  } catch {
    toast('Could not store image — browser storage may be full.');
    return;
  }
  addItem({ id, name: cleanName(name), desc: '', stored: true, ...(src && { src }) });
}

async function addImageFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return toast('No image files found.');
  for (const f of images) await addImageBlob(f, f.name && f.name !== 'image.png' ? f.name : 'Contender');
  toast(`Added ${images.length} contender${images.length > 1 ? 's' : ''}. Click one to rename it.`);
}

$('#file-input').addEventListener('change', async (e) => {
  await addImageFiles(e.target.files);
  e.target.value = '';
});

const nameFromUrl = (url) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
};

// Prefer a local copy (works offline, survives link rot). Many hosts block
// cross-origin fetches, so fall back to just remembering the link.
async function addImageFromUrl(url, name = nameFromUrl(url)) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error();
    await addImageBlob(blob, name, url);
  } catch {
    const ok = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!ok) return false;
    addItem({ id: uid(), name: cleanName(name), desc: '', url });
  }
  return true;
}

$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#url-input');
  let url;
  try { url = new URL(input.value.trim()).href; } catch { return toast('That doesn’t look like a valid URL.'); }
  if (!(await addImageFromUrl(url))) return toast('Couldn’t load an image from that link.');
  input.value = '';
});

/* ---------------- image search (Wikimedia APIs: free, keyless, CORS-enabled) ---------------- */
const SEARCH_SOURCES = {
  // One image per article — great for characters, teams, films, foods, people…
  wikipedia: {
    api: 'https://en.wikipedia.org/w/api.php',
    params: (q) => ({
      generator: 'search', gsrsearch: q, gsrlimit: 30,
      prop: 'pageimages', piprop: 'thumbnail', pithumbsize: MAX_IMAGE_SIDE, pilimit: 'max', pilicense: 'any',
    }),
    toResult: (p) => p.thumbnail && { title: p.title, src: p.thumbnail.source },
  },
  // Free media library — many more images per topic.
  commons: {
    api: 'https://commons.wikimedia.org/w/api.php',
    params: (q) => ({
      generator: 'search', gsrsearch: q, gsrnamespace: 6, gsrlimit: 30,
      prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: MAX_IMAGE_SIDE,
    }),
    toResult: (p) => {
      const info = p.imageinfo?.[0];
      if (!info?.thumburl || !info.mime?.startsWith('image/')) return null;
      return { title: p.title.replace(/^File:/, '').replace(/\.[^.]+$/, ''), src: info.thumburl };
    },
  },
};

const searchDialog = $('#search-dialog');
const searchInput = $('#search-input');
const searchResultsEl = $('#search-results');
const searchStatusEl = $('#search-status');
const searchMoreBtn = $('#search-more');
let search = { source: 'wikipedia', query: '', cont: null, token: 0 };

async function runSearch(more = false) {
  const query = searchInput.value.trim();
  if (!query) return;
  if (!more) {
    search = { ...search, query, cont: null, token: search.token + 1 };
    searchResultsEl.replaceChildren();
  }
  const { token, source } = search;
  const src = SEARCH_SOURCES[source];
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: 2, origin: '*',
    ...src.params(search.query), ...(more ? search.cont : {}),
  });
  searchStatusEl.textContent = 'Searching…';
  searchMoreBtn.hidden = true;
  let data;
  try {
    const res = await fetch(`${src.api}?${params}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    if (token === search.token) searchStatusEl.textContent = 'Search failed — check your connection and try again.';
    return;
  }
  if (token !== search.token) return; // a newer search started meanwhile
  const pages = (data.query?.pages || []).sort((a, b) => a.index - b.index);
  const results = pages.map(src.toResult).filter(Boolean);
  searchResultsEl.append(...results.map(makeResultEl));
  search.cont = data.continue || null;
  searchMoreBtn.hidden = !search.cont;
  const n = searchResultsEl.children.length;
  searchStatusEl.textContent = n
    ? 'Click an image to add it as a contender.'
    : `No images found${search.cont ? ' yet — try loading more or' : ' — try'} a different search or source.`;
}

function makeResultEl({ title, src }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'result';
  btn.title = title;
  btn.dataset.src = src;
  const img = new Image();
  img.alt = title;
  img.loading = 'lazy';
  img.src = src;
  img.onerror = () => btn.remove();
  const caption = document.createElement('span');
  caption.textContent = title;
  btn.append(img, caption);
  return btn;
}

searchResultsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.result');
  if (!btn || btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  const ok = await addImageFromUrl(btn.dataset.src, btn.title);
  btn.classList.remove('busy');
  if (!ok) return toast('Couldn’t add that image.');
  btn.classList.add('added');
  toast(`Added “${btn.title}”.`);
});

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
searchMoreBtn.addEventListener('click', () => runSearch(true));

searchDialog.querySelector('.source-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-source]');
  if (!tab || tab.dataset.source === search.source) return;
  search.source = tab.dataset.source;
  for (const t of searchDialog.querySelectorAll('[data-source]')) t.setAttribute('aria-checked', t === tab);
  if (searchInput.value.trim()) runSearch();
});

function openSearch() {
  searchDialog.showModal();
  searchInput.focus();
  searchInput.select();
  if (!searchResultsEl.children.length && !searchStatusEl.textContent) {
    searchStatusEl.textContent = 'Search for characters, teams, movies, foods… then click images to add them.';
  }
}
$('#open-search').addEventListener('click', openSearch);
$('#add-item').addEventListener('click', openSearch);
$('#search-close').addEventListener('click', () => searchDialog.close());
searchDialog.addEventListener('click', (e) => { if (e.target === searchDialog) searchDialog.close(); });

// Paste images from the clipboard (when not typing in a field).
window.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addImageFiles(files); }
});

// Drop image files anywhere on the page.
let fileDragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { fileDragDepth++; document.body.classList.add('file-over'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --fileDragDepth <= 0) { fileDragDepth = 0; document.body.classList.remove('file-over'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  fileDragDepth = 0;
  document.body.classList.remove('file-over');
  addImageFiles(e.dataTransfer.files);
});

/* ---------------- editing contenders ---------------- */
const editDialog = $('#edit-dialog');
const editName = $('#edit-name');
const editDesc = $('#edit-desc');
let editingId = null;

function openEdit(id) {
  const item = state.items[id];
  if (!item) return;
  editingId = id;
  makePortrait(item, $('#edit-preview'));
  editName.value = item.name;
  editDesc.value = item.desc || '';
  editDialog.showModal();
}

$('#edit-form').addEventListener('submit', (e) => {
  const item = state.items[editingId];
  if (e.submitter?.value !== 'save' || !item) return;
  item.name = editName.value.replace(/\s+/g, ' ').trim().slice(0, 40) || item.name;
  item.desc = editDesc.value.trim().slice(0, 200);
  commit();
});
$('#edit-cancel').addEventListener('click', () => editDialog.close());
$('#edit-delete').addEventListener('click', () => {
  editDialog.close();
  removeItem(editingId);
  commit();
});
editDialog.addEventListener('click', (e) => { if (e.target === editDialog) editDialog.close(); });

function removeItem(id) {
  const item = state.items[id];
  delete state.items[id];
  state.pool = state.pool.filter((x) => x !== id);
  state.slots = state.slots.map((x) => (x === id ? null : x));
  if (item?.stored) {
    imageDB.del(id).catch(() => {});
    const url = objectUrls.get(id);
    if (url) { URL.revokeObjectURL(url); objectUrls.delete(id); }
  }
}

/* ---------------- drag & drop (pointer events: mouse + touch) ---------------- */
// Pool items and first-round seats are draggable. Drop on a seat to place
// (swapping with whoever is there), on the pool to unseat, or on the trash.
let drag = null;

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.item');
  if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
  drag = { el, id: el.dataset.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false };
});

function startDrag(e) {
  const ghost = makeItemEl(state.items[drag.id]);
  ghost.classList.add('drag-ghost');
  document.body.append(ghost);
  drag.ghost = ghost;
  drag.started = true;
  drag.el.classList.add('placeholder');
  document.body.classList.add('dragging');
  autoScroll();
}

function insertionIndex(x, y) {
  for (const child of poolEl.children) {
    if (child === drag.el) continue;
    const r = child.getBoundingClientRect();
    if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) return state.pool.indexOf(child.dataset.id);
  }
  return -1;
}

function setDropTarget(el) {
  if (drag.target === el) return;
  drag.target?.classList.remove('drop-over');
  drag.target = el;
  el?.classList.add('drop-over');
}

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
    startDrag(e);
  }
  e.preventDefault();
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.ghost.style.transform = `translate(${e.clientX - 44}px, ${e.clientY - 44}px) rotate(3deg)`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  trashEl.classList.toggle('over', !!under?.closest('#trash'));
  setDropTarget(under?.closest('#trash') ? null : under?.closest('.slot.seed, #pool'));
}, { passive: false });

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (!d.started) {
    if (!cancelled) openEdit(d.id);
    return;
  }
  d.ghost.remove();
  d.el.classList.remove('placeholder');
  d.target?.classList.remove('drop-over');
  document.body.classList.remove('dragging');
  const overTrash = trashEl.classList.contains('over');
  trashEl.classList.remove('over');
  if (cancelled) return;

  const fromSeat = state.slots.indexOf(d.id);
  if (overTrash) {
    removeItem(d.id);
  } else if (d.target?.matches('.slot.seed')) {
    const to = Number(d.target.dataset.index);
    const displaced = state.slots[to];
    if (fromSeat >= 0) {
      state.slots[fromSeat] = displaced;
    } else {
      const i = state.pool.indexOf(d.id);
      state.pool.splice(i, 1, ...(displaced ? [displaced] : []));
    }
    state.slots[to] = d.id;
  } else if (d.target === poolEl) {
    let at = insertionIndex(e.clientX, e.clientY);
    if (fromSeat >= 0) state.slots[fromSeat] = null;
    else {
      const i = state.pool.indexOf(d.id);
      state.pool.splice(i, 1);
      if (at > i) at--;
    }
    if (at < 0) state.pool.push(d.id);
    else state.pool.splice(at, 0, d.id);
  } else return;
  commit();
}
document.addEventListener('pointerup', (e) => endDrag(e, false));
document.addEventListener('pointercancel', (e) => endDrag(e, true));

// Keep scrolling while dragging near the top/bottom edge (important on phones).
function autoScroll() {
  if (!drag?.started) return;
  const edge = 70;
  if (drag.y != null) {
    if (drag.y < edge) window.scrollBy(0, -Math.ceil((edge - drag.y) / 5));
    else if (drag.y > innerHeight - edge) window.scrollBy(0, Math.ceil((drag.y - (innerHeight - edge)) / 5));
  }
  requestAnimationFrame(autoScroll);
}

/* ---------------- running the bracket: versus screen ---------------- */
const vsDialog = $('#versus');
const fighters = [...vsDialog.querySelectorAll('.fighter')];
const vsStatus = $('#vs-status');
const vsNext = $('#vs-next');
const vsRandom = $('#vs-random');
let vs = null; // { key, ids: [a, b], rolling }

function findMatch(key) {
  return computeBracket().rounds.flat().find((x) => x.key === key);
}

function openMatch(match) {
  const rounds = roundsFor(state.size);
  const count = state.size / 2 ** (match.r + 1);
  vs = { key: match.key, ids: [match.a, match.b], rolling: false };
  $('#vs-round').textContent = roundName(match.r, rounds) + (count > 1 ? ` · Match ${match.m + 1} of ${count}` : '');
  $('#vs-progress').textContent = rounds > 1 ? `Round ${match.r + 1} of ${rounds}` : '';
  fighters.forEach((f, i) => {
    const item = state.items[vs.ids[i]];
    makePortrait(item, f.querySelector('.portrait'));
    f.querySelector('.fighter-name').textContent = item.name;
    f.querySelector('.fighter-desc').textContent = item.desc || '';
    f.classList.remove('won', 'lost', 'hot');
    f.disabled = false;
  });
  vsRandom.disabled = false;
  vsNext.hidden = true;
  vsStatus.textContent = match.winner ? `${state.items[match.winner].name} won this one. Pick again to change it.` : 'Pick the winner';
  if (match.winner) fighters.forEach((f, i) => f.classList.add(vs.ids[i] === match.winner ? 'won' : 'lost'));

  // Restart the entrance animation.
  vsDialog.classList.remove('enter');
  if (!vsDialog.open) vsDialog.showModal();
  void vsDialog.offsetWidth;
  vsDialog.classList.add('enter');
}

function decide(side) {
  if (!vs) return;
  const winnerId = vs.ids[side];
  state.results[vs.key] = winnerId;
  commit();
  fighters.forEach((f, i) => {
    f.classList.remove('hot');
    f.classList.toggle('won', i === side);
    f.classList.toggle('lost', i !== side);
  });
  const bracket = computeBracket();
  const name = state.items[winnerId].name;
  vsStatus.textContent = bracket.champion === winnerId ? `${name} wins it all!` : `${name} advances!`;
  vsNext.hidden = false;
  vsNext.textContent = nextMatch(bracket) ? 'Next match →' : bracket.champion ? '🏆 Crown the champion' : 'Done';
  vsNext.focus();
}

fighters.forEach((f, i) => f.addEventListener('click', () => { if (!vs?.rolling) decide(i); }));

// Spin between the two fighters, slowing down, then land on a random one.
vsRandom.addEventListener('click', () => {
  if (!vs || vs.rolling) return;
  vs.rolling = true;
  vsRandom.disabled = true;
  fighters.forEach((f) => f.classList.remove('won', 'lost'));
  vsStatus.textContent = '🎲 Rolling…';
  const pick = Math.random() < 0.5 ? 0 : 1;
  const steps = 9 + pick; // ends highlighting the picked side
  let n = 0;
  const tick = () => {
    if (!vs?.rolling) return;
    fighters.forEach((f, i) => f.classList.toggle('hot', i === n % 2));
    if (++n > steps) {
      vs.rolling = false;
      vsRandom.disabled = false;
      decide(pick);
      return;
    }
    setTimeout(tick, 60 + n * n * 4);
  };
  tick();
});

vsNext.addEventListener('click', () => {
  const bracket = computeBracket();
  const next = nextMatch(bracket);
  if (next) return openMatch(next);
  vsDialog.close();
  if (bracket.champion) showChampion(bracket.champion);
});

$('#vs-close').addEventListener('click', () => vsDialog.close());
vsDialog.addEventListener('close', () => { if (vs) vs.rolling = false; vs = null; });
vsDialog.addEventListener('keydown', (e) => {
  if (!vs || vs.rolling) return;
  if (e.key === 'ArrowLeft' || e.key === '1') decide(0);
  else if (e.key === 'ArrowRight' || e.key === '2') decide(1);
});

runBtn.addEventListener('click', () => {
  const bracket = computeBracket();
  const next = nextMatch(bracket);
  if (next) openMatch(next);
  else if (bracket.champion) showChampion(bracket.champion);
});

stageEl.addEventListener('click', (e) => {
  if (panMoved) return;
  const matchEl = e.target.closest('.match.playable');
  if (!matchEl || e.target.closest('.item')) return;
  const match = findMatch(matchEl.dataset.key);
  if (match?.playable) openMatch(match);
});

/* ---------------- champion ---------------- */
const champDialog = $('#champion');

function showChampion(id) {
  const item = state.items[id];
  makePortrait(item, $('#champ-portrait'));
  $('#champ-name').textContent = item.name;
  $('#champ-of').textContent = state.title;
  champDialog.showModal();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) confetti();
}
$('#champ-close').addEventListener('click', () => champDialog.close());

function confetti() {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.offsetWidth);
  const h = (canvas.height = canvas.offsetHeight);
  const colors = ['#ffd84d', '#ff5f5f', '#6c8cff', '#5fe3a1', '#ff9be6'];
  const bits = Array.from({ length: 160 }, () => ({
    x: Math.random() * w, y: -Math.random() * h * 0.6,
    vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    s: 5 + Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (t) => {
    if (!champDialog.open) return ctx.clearRect(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      ctx.restore();
    }
    if (t - start < 5000) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, w, h);
  };
  requestAnimationFrame(frame);
}

/* ---------------- sharing (the bracket lives in the link's #fragment; no server) ---------------- */
const SHARE_THUMB = 64; // px; uploaded images ride along as tiny thumbnails
const SHARE_MAX = 30000; // chars; very long links get cut off by some chat apps

const toBase64Url = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pipeBytes = (data, stream) => new Response(new Blob([data]).stream().pipeThrough(stream));
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function encodeBracket({ picks, thumbs }) {
  const ids = Object.keys(state.items);
  const index = Object.fromEntries(ids.map((id, i) => [id, i]));
  const items = [];
  for (const id of ids) {
    const item = state.items[id];
    const out = { n: item.name };
    if (item.desc) out.d = item.desc;
    const remote = item.src || (!item.stored && item.url);
    if (remote) out.u = remote;
    else if (item.stored && thumbs) {
      const blob = await imageDB.get(id).catch(() => null);
      if (blob) out.e = await blobToDataUrl(await shrinkImage(blob, SHARE_THUMB, 0.7));
    }
    items.push(out);
  }
  const data = {
    v: 1, t: state.title, z: state.size, i: items,
    s: state.slots.map((id) => (id ? index[id] : -1)),
    p: state.pool.map((id) => index[id]),
    r: picks ? Object.fromEntries(Object.entries(state.results).map(([k, id]) => [k, index[id]])) : {},
  };
  const packed = await pipeBytes(JSON.stringify(data), new CompressionStream('deflate-raw')).arrayBuffer();
  return toBase64Url(new Uint8Array(packed));
}

const shareDialog = $('#share-dialog');
const shareUrl = $('#share-url');
const shareNote = $('#share-note');

async function updateShareLink() {
  shareUrl.value = 'Packing…';
  const picks = $('#share-picks').checked;
  const hasUploads = Object.values(state.items).some((it) => it.stored && !it.src);
  let code = await encodeBracket({ picks, thumbs: true });
  let note = hasUploads ? 'Uploaded images are shrunk to small thumbnails to fit in the link.' : '';
  if (code.length > SHARE_MAX) {
    code = await encodeBracket({ picks, thumbs: false });
    note = 'Your uploaded images are too big to fit in a link, so they’ll show as initials. Images added from search or a URL still come through.';
  }
  shareUrl.value = `${location.origin}${location.pathname}#b=${code}`;
  shareNote.textContent = note;
}

$('#share').addEventListener('click', async () => {
  if (!Object.keys(state.items).length) return toast('Add some contenders first.');
  if (typeof CompressionStream === 'undefined') return toast('Sharing needs a newer browser.');
  $('#share-native').hidden = !navigator.share;
  shareDialog.showModal();
  await updateShareLink();
  shareUrl.select();
});
$('#share-picks').addEventListener('change', updateShareLink);
$('#share-close').addEventListener('click', () => shareDialog.close());
shareDialog.addEventListener('click', (e) => { if (e.target === shareDialog) shareDialog.close(); });
$('#share-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    toast('Link copied!');
  } catch {
    shareUrl.select();
    toast('Press Ctrl+C / ⌘C to copy the link.');
  }
});
$('#share-native').addEventListener('click', () => {
  navigator.share({ title: state.title, url: shareUrl.value }).catch(() => {});
});

async function openSharedLink() {
  const m = location.hash.match(/^#b=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let data;
  try {
    data = JSON.parse(await pipeBytes(fromBase64Url(m[1]), new DecompressionStream('deflate-raw')).text());
    if (data.v !== 1 || !SIZES.includes(data.z) || !Array.isArray(data.i) || !Array.isArray(data.s)) throw new Error();
  } catch {
    return toast('That share link is broken or incomplete.');
  }
  const title = String(data.t || 'Shared bracket').slice(0, 80);
  if (Object.keys(state.items).length && !confirm(`Open the shared bracket “${title}”? It replaces your current bracket.`)) return;

  await wipeImages();
  const ids = data.i.map(() => uid());
  const items = {};
  for (const [i, raw] of data.i.entries()) {
    const item = { id: ids[i], name: String(raw?.n || 'Contender').slice(0, 40), desc: String(raw?.d || '').slice(0, 200) };
    if (/^https?:\/\//.test(raw?.u)) item.url = item.src = raw.u;
    else if (/^data:image\/[a-z+]+;base64,/.test(raw?.e)) {
      try {
        await imageDB.put(item.id, await (await fetch(raw.e)).blob());
        item.stored = true;
      } catch {}
    }
    items[item.id] = item;
  }
  const idAt = (i) => ids[i] ?? null;
  // Each contender is placed once; anyone left over (a hand-edited link) goes to the pool.
  const placed = new Set();
  const place = (id) => (id && !placed.has(id) ? (placed.add(id), id) : null);
  const slots = Array.from({ length: data.z }, (_, i) => place(idAt(data.s[i])));
  const pool = (Array.isArray(data.p) ? data.p : []).map((i) => place(idAt(i))).filter(Boolean);
  pool.push(...ids.filter((id) => place(id)));
  state = {
    title,
    size: data.z,
    slots,
    results: Object.fromEntries(Object.entries(data.r || {}).map(([k, i]) => [k, idAt(i)]).filter(([, id]) => id)),
    pool,
    items,
  };
  commit();
  fitView();
  toast(`Opened “${title}”.`);
}
window.addEventListener('hashchange', openSharedLink);

$('#year').textContent = new Date().getFullYear();
render();
fitView();
openSharedLink();
