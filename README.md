# Bracket Maker

A client-side "build your own bracket" game, built as a no-build static site: plain HTML, CSS and JavaScript. Sister app of [Tier Ranker](https://github.com/Thorstein-Games/tier-ranker).

## Features

- Brackets of **2, 4, 8, 16, 32 or 64** contenders. Empty first-round slots are **byes** (the slot shows "Bye" once its opponent is filled in), so any count from 2 to 64 works (e.g. 6 contenders in an 8 bracket).
- Add contenders by **name**, **image search** (Wikipedia / Wikimedia Commons, no API key), **file upload**, **image URL**, **drag-and-drop** onto the page, or **paste**.
- Click a contender to **rename** it or give it a **description** (shown on the versus screen). Name-only contenders get a colored initials tile.
- Drag contenders into first-round slots (dropping on a filled slot swaps them), back to the pool, or onto the trash bin. **Auto-fill** seats everyone waiting in standard seeding order (1v8, 4v5, 2v7, 3v6…), so byes go to the top seeds. **Shuffle** reseeds randomly.
- The bracket is a **pan & zoom** board: scroll or pinch to zoom, drag the background to pan, ⤢ to fit.
- **Run bracket** plays it one match at a time on a fighting-game style **versus screen**: click a fighter (or press ← / →) to pick the winner, or **🎲 Let fate decide**. Ends with a champion screen.
- Click **VS** on any match to replay it. Changing an earlier result clears the later results it affected.
- **🔗 Share** gives you a link that contains the whole bracket, with or without your picks. Whoever opens it gets their own copy to play. No server or account is involved: the bracket is packed into the link itself. Images from search or a URL come through at full quality; uploaded images come through as small thumbnails (or initials, if there are too many to fit).
- The versus screen shows which round you're in (e.g. "Round 2 of 4").
- Link previews (Open Graph / Twitter card) show a custom share image; the page has SEO metadata and a short how-to/FAQ.
- Everything is saved in the browser — nothing is uploaded anywhere. (Image search sends your search terms to the Wikimedia API.)

## Storage

- Bracket (title, size, seeds, results, contenders) → `localStorage`.
- Image data → **IndexedDB**. Uploads are downscaled to 512px max and re-encoded as WebP before saving.
- Image links: the app tries to download a local copy; if the host blocks cross-origin requests, it stores the link itself instead.

## Running

Live at **https://thorsteingames.com/bracket-maker** (the Thorstein Games site proxies that path to this repo's GitHub Pages site, https://thorstein-games.github.io/bracket-maker/).

Asset paths are absolute (`/bracket-maker/...`). To run it locally, serve the *parent* folder:

```sh
cd ..
python3 -m http.server 8000
# then visit http://localhost:8000/bracket-maker/
```

## Possible next steps

- Export the bracket as a PNG
- Multiple saved brackets
- Group voting: each friend votes on their phone, majority advances
