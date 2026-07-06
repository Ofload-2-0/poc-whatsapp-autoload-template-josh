# Dev overlay — realistic read-only view (demo)

A browser overlay that shows the WA pickup status / History timeline / Note on a
real dev shipment page. **Read-only:** it sends nothing, writes nothing to dev — it
only draws a panel from our LOCAL tracking store. Clearly labelled "demo overlay".

> This is a *visualisation/testing* aid — NOT the production mechanism. The live
> feature stays backend ("built in"). This just lets you see what it looks like working.

## Why console-paste (not a bookmarklet/script src)
The dev app is HTTPS; browsers block an HTTPS page from loading `http://localhost`
(mixed content). So we paste a self-contained snippet (overlay + data embedded) —
no network call from the dev page, works every time.

## Steps
1. Populate tracking:  `node demo.js`  (sample loads) — and/or seed a real load:
   `node seed.js AUSH12345 onroad`     ← use the reference of a dev shipment you'll open
   scenarios: `sent` · `onroad` · `eta1` (<1h) · `eta2` (>2h late)
2. Start the server:  `npm run serve`
3. Open **http://localhost:4599/snippet** → Select All → Copy.
4. In the dev app, open the shipment page (the one whose ref you seeded).
5. Open DevTools console (⌥⌘J) → paste → Enter.
6. The **WA Pickup** panel appears bottom-right, showing status + timeline + note.
   - If the page's load ref matches a tracked record → shows it.
   - If not → shows a labelled "sample" so the layout is always visible.

To refresh after seeding more: re-copy `/snippet` and re-paste.

## Remove it
Reload the page, or run in console: `document.getElementById('wa-pickup-panel').remove()`

## Sharing beyond your laptop
This runs off `localhost`. If you later want a hosted version teammates can load
without running the server, host it on **hub.ofload.com**.
