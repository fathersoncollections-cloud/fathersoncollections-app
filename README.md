# FatherSon Collections phone wrapper

A tiny installable web app (PWA) that opens the live collection full-screen, with the yellow donut icon. It is meant to get around the Google multi-account “Sorry, unable to open the file at present” error on Android.

Live install page: https://fathersoncollections-cloud.github.io/fathersoncollections-app/

## Add it to your phone

1. On the Samsung, open the hosted link in Chrome (not Incognito, not inside another app).
2. Wait until the collection appears.
3. Tap the three dots at the top right, then **Add to Home screen** or **Install app**.
4. Use the FatherSon icon on the home screen from then on.

This page only contains the app icon and a link through to the collection. Collection data stays in your Google account.

The iframe only works after the Apps Script web app is redeployed with a new version that allows embedding (`XFrameOptionsMode.ALLOWALL`).

## Direct link that often works without the wrapper

https://script.google.com/a/gmail.com/macros/s/AKfycbwSO6lF3RuWl0oihI0plwrpb2UKTVDG699nbfXpsiD9y-ZIlRxf44L4SZgw7whRzpeF/exec
