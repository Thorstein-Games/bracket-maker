# Bracket Maker

Client-side "build your own bracket" game (sister app of `tier-ranker`, which it shares its add/search/drag code with). Plain HTML/CSS/JS with **no build step and no runtime dependencies**. The root `package.json` holds only the test tooling (`@playwright/test`, a devDependency); the site never loads anything from it. The code lives in three files:

- `index.html`: markup, including the `<dialog>`s: image search, edit contender, share, versus and champion.
- `app.js`: all logic, organised into `/* ---- section ---- */` blocks: IndexedDB, state, bracket logic, rendering, pan & zoom, adding contenders, image search, editing, drag & drop, versus screen, champion, sharing.
- `style.css`: dark theme driven by CSS variables in `:root`. The single mobile breakpoint is `@media (max-width: 600px)`.
- Static assets: `favicon.svg`, `apple-touch-icon.png` (180px) and `og-image.jpg` (1200×630 social share card).

## SEO and sharing metadata

`index.html`'s `<head>` has the title, description, canonical URL, Open Graph/Twitter tags and JSON-LD (`WebApplication` + `FAQPage`). Canonical and `og:*` URLs are absolute `https://thorsteingames.com/bracket-maker...`. The FAQ JSON-LD mirrors the visible FAQ in the `.about` section, so edit both together. The page `<h1>` is the "Bracket Maker" brand line; the editable bracket title is an `<h2>`.

## Shared Thorstein Games bar and footer

`index.html` loads `https://thorsteingames.com/tg-bar.js` (served by the thorstein-games-website repo, whose CLAUDE.md has the full contract) and uses `<tg-bar game="bracket-maker">` (thin site header, first in `<body>`, hides while scrolling down) and `<tg-footer game="bracket-maker">` (other games, More Games, contact, privacy, copyright) after `<main>`. `<tg-more-games game="bracket-maker">` ("Play a different game") sits under the winner in the champion dialog. The bar is always 40px; `style.css` holds that space before the script loads (`tg-bar:not(:defined)`). The page is longer than a screen, so the footer stays below the fold. When checking locally without network the elements stay empty, which is fine.

Ads (rules and options in the thorstein-games-website CLAUDE.md): a `<tg-ad format="banner">` between `<main>` and the footer, and a `box` under the tiles in the champion dialog (the dialog scrolls, and `.champ-box` centres with `margin: auto` so its top is never cut off). Keep ads out of the bracket, the versus screen and the drag areas. Check placements with `?tgads=preview`.

## Key invariants

- **State** (`state`) is saved to `localStorage` under `bracket-maker:v1`. Its shape is `{ title, size, slots: [id|null] (first-round seats, length = size), results: {"round-match": winnerId}, pool: [ids], items: {id: {id, name, desc, url?, stored?, src?}} }`. `src` is the web address a stored image was fetched from, so share links can point at it. If you change the shape, keep `loadState()` able to read old saves, or bump the key.
- **Matches are derived**, never stored: `computeBracket()` builds every round from `slots` + `results`. An empty seat is a bye; a side is an id, `BYE`, or `null` (waiting). `commit()` prunes results that no longer apply, saves, and re-renders. Change state, then call `commit()`.
- **Image blobs** go in IndexedDB (`bracket-maker` DB, `images` store), keyed by item id. Items with `stored: true` live there. Items with only `url` are remote links, used when a host blocks CORS.
- New images go through `addImageBlob` (downscales to `MAX_IMAGE_SIDE` and re-encodes as WebP) or `addImageFromUrl` (tries a CORS fetch first, falls back to a plain link). Reuse these; don't add a parallel path.
- **Drag & drop** uses pointer events (mouse and touch), not the HTML5 DnD API. Anything with class `.item` is draggable (pool tiles and first-round seats; later-round entries are `.entry`). Drops update `state` directly in `endDrag()`.
- **Pan & zoom**: the bracket is plain DOM in `#stage`, absolutely positioned by `layout()` and scaled with a CSS transform (`view`). No canvas or libraries. Pointers on `.item` drag; anywhere else in `#viewport` pans (two pointers pinch).
- **Share links** carry the whole bracket in the URL fragment (`#b=`): compact JSON (`encodeBracket()`), deflated with `CompressionStream` and base64url-encoded. Web images travel as their URL; uploaded images as tiny WebP thumbnails, dropped if the link would get too long (`SHARE_MAX`). `openSharedLink()` validates and imports. If you add state that should survive sharing, add it to both, and keep accepting old links (`v: 1`).
- **Image search** calls the Wikimedia APIs (`SEARCH_SOURCES` in `app.js`). They're keyless and CORS-enabled through `origin=*`. Keep the app backend-free: no API keys, no servers.
- Keep inputs at `font-size: 16px` or larger, or iOS Safari zooms in on focus.

## Paths and deployment

- Asset paths are **absolute** (`/bracket-maker/app.js`) because thorsteingames.com proxies `/bracket-maker` to this repo's GitHub Pages site (proxy rules in the `thorstein-games-website` repo's `public/_redirects`). Keep new asset references in that form.
- `.github/workflows/pages.yml` deploys `main` and copies an **explicit file list** (`index.html style.css app.js favicon.svg apple-touch-icon.png og-image.jpg .nojekyll`). **If you add a file the site needs, add it to that `cp` line too** (a test checks every `/bracket-maker/...` reference in `index.html` is in it). Test files never go in that list.
- `pages.yml` first runs the reusable `.github/workflows/test.yml` and only deploys if it passes. `test.yml` also runs on pull requests and on pushes to other branches.

## Running and verifying

Serve the *parent* directory so the `/bracket-maker/` paths resolve:

```sh
cd .. && python3 -m http.server 8000   # open http://localhost:8000/bracket-maker/
```

- Syntax check: `node --check app.js`
- Run the tests (below) before pushing. For UI changes, also look at the page in a browser at desktop and phone widths (around 390px).

## Testing

Playwright (Chromium) runs everything; there is no other test runner. `npm ci` once, then:

```sh
npm test              # everything
npm run test:unit     # app.js logic only
npm run test:e2e      # user flows at desktop (1280px) and phone (390px, touch) widths
npx playwright test tests/e2e/run.spec.js -g "champion"   # one file / test
```

If Chromium isn't installed yet: `npx playwright install chromium` (CI uses `--with-deps`). `@playwright/test` is pinned to an exact version; bump it deliberately.

- `playwright.config.js` starts `tests/serve.js`, a tiny static server that serves the repo at `/bracket-maker/` like production (port 4391, override with `PORT`). Projects: `unit`, `e2e-desktop`, `e2e-phone`.
- `tests/unit/`: `app.js` is a classic script, so its top-level functions and `state` are globals. Unit tests load the page and call them through `page.evaluate` (`computeBracket`, `spreadOrder`, `commit`, `loadState`, `encodeBracket`, `openSharedLink`…). Don't refactor `app.js` into modules just for tests.
- `tests/e2e/`: real clicks, typing, uploads and pointer drags.
- `tests/helpers.js` (import `test`/`expect` from it, not from `@playwright/test`): **no real network**. Every non-localhost request is mocked or blocked: `tg-bar.js` is stubbed, `upload.wikimedia.org` returns generated PNGs, `mockWikimedia(page)` fakes the search API. Any console error or uncaught exception fails the test; a test that expects one (e.g. a 404) must check and clear `errors`.
- Share links: keep the hard-coded `V1_CODE` test in `tests/unit/share.spec.js` passing; old links must keep opening.
- No fixed sleeps: wait on UI state with `expect(...)` / `expect.poll`.
- When you add a feature, add tests for it; when a test fails, fix the app rather than loosening the test.

## Style

Match the existing code: `'use strict'`, `const`/arrow functions, the `$()` helper, `uid()` for ids, `toast()` for user feedback, terse comments only where intent isn't obvious. Update `README.md` when you add a user-facing feature.
