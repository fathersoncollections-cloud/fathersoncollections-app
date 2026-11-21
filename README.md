# FatherSon Collections phone app

Installable web app (PWA). Since v3 the whole app runs from this GitHub Pages site and only fetches
collection data from the Apps Script JSON API (plain `fetch`, no Google cookies), so Google's
multi-account "Sorry, unable to open the file at present" page can't appear.

Live: https://fathersoncollections-cloud.github.io/fathersoncollections-app/

Add to phone: open the link in Chrome, wait for the collection, tap the three dots, then **Install app** / **Add to Home screen**.

Money (paid/value) is only sent by the API after the Dad PIN is checked on the server (12-hour token).
Built from `src/` by `build_pwa.py`. Until the Apps Script update is live, the page falls back to the old embedded view.

## v4 (21 Nov 2026)
- **Do I own it?** big search on Home with typo-tolerant matching, plus **barcode scan** (phone's built-in BarcodeDetector,
  falling back to ZXing in `lib/zxing.min.js`, Apache-2.0). Scanned barcodes can be saved onto items.
- **Collection value** on Home (Dad view only) with item count and a monthly change once there's a start-of-month snapshot.
- **Wanted deal alerts** badge (from optional deal columns on the Wanted tab).
- **Offline mode**: app files cached by the service worker; last data and thumbnails kept in IndexedDB; changes made
  offline are queued and synced when back online.
- **Son's mode**: big tiles and photos, no prices, Christmas/gift items left out; leaving it needs the Dad PIN.
