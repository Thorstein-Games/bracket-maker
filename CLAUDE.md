# Bracket Maker

Client-side "build your own bracket" game (sister app of `tier-ranker`, which it shares its add/search/drag code with). Plain HTML/CSS/JS with **no build step, no dependencies, no package.json**. The code lives in three files:

- `index.html`: markup, including the `<dialog>`s: image search, edit contender, share, versus and champion.
- `app.js`: all logic, organised into `/* ---- section ---- */` blocks: IndexedDB, state, bracket logic, rendering, pan & zoom, adding contenders, image search, editing, drag & drop, versus screen, champion, sharing.
- `style.css`: dark theme driven by CSS variables in `:root`. The single mobile breakpoint is `@media (max-width: 600px)`.
- Static assets: `favicon.svg`, `apple-touch-icon.png` (180px) and `og-image.jpg` (1200×630 social share card).

## SEO and sharing metadata

`index.html`'s `<head>` has the title, description, canonical URL, Open Graph/Twitter tags and JSON-LD (`WebApplication` + `FAQPage`). Canonical and `og:*` URLs are absolute `https://thorsteingames.com/bracket-maker...`. The FAQ JSON-LD mirrors the visible FAQ in the `.about` section, so edit both together. The page `<h1>` is the "Bracket Maker" brand line; the editable bracket title is an `<h2>`. The footer's "More Games" button matches Sheeple's and Find the Fox's.

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

- Asset paths are **absolute** (`/bracket-maker/app.js`) because thorsteingames.com proxies `/bracket-maker` to this repo's GitHub Pages site (rewrites in the `thorstein-games-website` repo's `next.config.ts`). Keep new asset references in that form.
- `.github/workflows/pages.yml` deploys `main` and copies an **explicit file list** (`index.html style.css app.js favicon.svg apple-touch-icon.png og-image.jpg .nojekyll`). **If you add a file the site needs, add it to that `cp` line too.**

## Running and verifying

Serve the *parent* directory so the `/bracket-maker/` paths resolve:

```sh
cd .. && python3 -m http.server 8000   # open http://localhost:8000/bracket-maker/
```

- Syntax check: `node --check app.js`
- There is no test suite. Verify UI changes in a browser. Playwright with Chromium works for headless checks. In sandboxes without outbound network, mock `*.wikipedia.org` / `commons.wikimedia.org` / `upload.wikimedia.org` with `page.route` (send `access-control-allow-origin: *`).
- Check both desktop and phone widths (around 390px).

## Style

Match the existing code: `'use strict'`, `const`/arrow functions, the `$()` helper, `uid()` for ids, `toast()` for user feedback, terse comments only where intent isn't obvious. Update `README.md` when you add a user-facing feature.
