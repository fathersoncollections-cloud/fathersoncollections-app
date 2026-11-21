# FatherSon Collections phone app

Installable web app (PWA). Since v3 the whole app runs from this GitHub Pages site and only fetches
collection data from the Apps Script JSON API (plain `fetch`, no Google cookies), so Google's
multi-account "Sorry, unable to open the file at present" page can't appear.

Live: https://fathersoncollections-cloud.github.io/fathersoncollections-app/

Add to phone: open the link in Chrome, wait for the collection, tap the three dots, then **Install app** / **Add to Home screen**.

Money (paid/value) is only sent by the API after the Dad PIN is checked on the server (12-hour token).
Built from `src/` by `build_pwa.py`. Until the Apps Script update is live, the page falls back to the old embedded view.
