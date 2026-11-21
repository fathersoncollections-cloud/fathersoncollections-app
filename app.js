(function () {
  'use strict';

  /* ---------------- state ---------------- */
  var LS = {
    get: function (k) { try { return localStorage.getItem((window.LS_PREFIX || 'fs_') + k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem((window.LS_PREFIX || 'fs_') + k, v); } catch (e) { /* private mode */ } }
  };
  var S = {
    role: LS.get('role'), boot: null, items: [], thumbs: {}, screen: '', params: {}, history: [],
    pinDigits: '', pinBusy: false, pinError: '', pendingRole: '',
    filters: { q: '', range: '', series: '', status: '', cond: '', posted: '', photos: '', sort: 'newest' }, shown: 60, add: null, camTarget: null
  };
  var PRIV = THEME.privateRole;
  function dadUnlocked() {
    if (!THEME.needsPin) return true;
    var tok = LS.get('dadToken'), exp = +LS.get('dadTokenExp') || 0;
    return !!(tok && (!exp || exp > Date.now()));
  }
  var isPriv = function () { return S.role === PRIV && dadUnlocked(); };
  function storeDadToken(token, expires) {
    LS.set('dadToken', token || '');
    LS.set('dadTokenExp', expires ? String(expires) : '');
  }
  function clearDadToken() { storeDadToken('', ''); }

  /* ---------------- theme ---------------- */
  (function applyTheme() {
    var c = THEME.colours, r = document.documentElement.style;
    var vars = { sky: c.sky, skyL: c.skyLight, yel: c.yellow, pink: c.pink, pinkL: c.pinkLight, ink: c.ink, green: c.green, amber: c.amber, red: c.red, white: c.white };
    Object.keys(vars).forEach(function (k) { if (vars[k]) r.setProperty('--' + k, vars[k]); });
    document.getElementById('logo').innerHTML = THEME.mascotSvg.replace('id="fsBite"', 'id="fsBiteLogo"').replace('url(#fsBite)', 'url(#fsBiteLogo)');
    document.getElementById('appName').textContent = THEME.appName;
    if (THEME.showClouds) document.getElementById('sky').innerHTML = cloudsSvg();
  })();

  function cloudsSvg() {
    var spots = [[20, 30, 0.9], [520, 10, 1.1], [300, 150, 0.7], [640, 230, 0.9], [60, 330, 1.0], [420, 420, 0.8], [700, 520, 1.1], [120, 600, 0.9], [480, 700, 1.0]];
    var g = spots.map(function (s) {
      return '<g transform="translate(' + s[0] + ' ' + s[1] + ') scale(' + s[2] + ')" fill="#FFFFFF" opacity="0.9"><ellipse cx="40" cy="34" rx="40" ry="22"/><ellipse cx="78" cy="22" rx="34" ry="26"/><ellipse cx="116" cy="34" rx="34" ry="20"/><rect x="18" y="32" width="122" height="24" rx="12"/></g>';
    }).join('');
    return '<svg viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + g + '</svg>';
  }

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function clTitle(t) { return String(t || '').replace(/ - Full set$/i, '').replace(/^Checklist\s*-\s*/i, ''); }
  function W(k, d) { return (THEME.words && THEME.words[k]) || d; }
  function gbp(n) { return n == null ? '-' : (THEME.currency || '\u00A3') + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(a, b) { return b ? Math.round(a * 100 / b) : 0; }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\u2019'`]/g, '').replace(/[^a-z0-9#]+/g, ' ').trim(); }

  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    args.push(LS.get('dadToken') || '');
    return new Promise(function (resolve, reject) {
      if (window.FS_API) return window.FS_API(fn, args).then(resolve, reject);
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn].apply(null, args);
    });
  }
  function busy(text) { $('busyText').textContent = text || 'Just a sec\u2026'; $('busy').hidden = false; }
  function done() { $('busy').hidden = true; }
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'oops' ? 6500 : 3500);
  }
  function oops(e) {
    done();
    var m = (e && e.message ? e.message : String(e || '')).replace(/^(Exception|Error|ScriptError):\s*/i, '');
    if (!m || /TypeError|ReferenceError|Cannot read|undefined is not|null is not|Authori[sz]ation|permission|Service invoked|Exceeded maximum/i.test(m)) {
      m = 'Hmm, that didn\u2019t work. Check you\u2019ve got signal and try again - nothing\u2019s been lost.';
    }
    toast(m, 'oops');
  }

  /* bottom sheet (friendly confirm / warnings) */
  function sheet(title, bodyHtml, buttons) {
    return new Promise(function (resolve) {
      $('sheetTitle').textContent = title;
      $('sheetBody').innerHTML = bodyHtml || '';
      var bb = $('sheetButtons'); bb.innerHTML = '';
      (buttons || [{ label: 'OK', value: true, cls: 'main' }]).forEach(function (b) {
        var el = document.createElement('button');
        el.className = 'btn full ' + (b.cls || ''); el.textContent = b.label;
        el.addEventListener('click', function () { $('sheet').hidden = true; resolve(b.value); });
        bb.appendChild(el);
      });
      $('sheet').hidden = false;
    });
  }
  function confirmSheet(title, body, yes, no) {
    return sheet(title, '<p>' + body + '</p>', [{ label: yes || 'Yes', value: true, cls: 'main' }, { label: no || 'Not now', value: false }]);
  }

  /* ---------------- navigation ---------------- */
  var TABS = function () {
    return [['home', '\uD83C\uDFE0', 'Home'], ['collection', '\uD83D\uDDC2\uFE0F', 'Collection'], ['add', '\u2795', 'Add'], ['wanted', '\u2B50', 'Wanted'], ['more', '\u2630', 'More']];
  };
  function renderTabs() {
    var nav = $('tabbar');
    nav.hidden = !S.role;
    nav.innerHTML = TABS().map(function (t) {
      var cur = S.screen === t[0] || (t[0] === 'collection' && (S.screen === 'item' || S.screen === 'edit')) ||
        (t[0] === 'more' && MORE_SCREENS.indexOf(S.screen) >= 0) || (t[0] === 'wanted' && (S.screen === 'checklists' || S.screen === 'checklist' || S.screen === 'missing'));
      return '<button data-tab="' + t[0] + '"' + (cur ? ' aria-current="page"' : '') + '><span class="ic">' + t[1] + '</span>' + t[2] + '</button>';
    }).join('');
    $('whoBadge').textContent = S.role ? 'Hi ' + S.role + ' \u00B7 tap to switch' : THEME.tagline;
  }
  var MORE_SCREENS = ['more', 'stats', 'posted', 'spares', 'export', 'help', 'settings', 'value', 'photos', 'novalue'];
  function go(screen, params, noHistory) {
    closeTour(); if ($('lightbox')) $('lightbox').hidden = true;
    if (!noHistory && S.screen && S.screen !== screen) S.history.push([S.screen, S.params]);
    if (S.history.length > 30) S.history.shift();
    S.screen = screen; S.params = params || {};
    renderTabs();
    var fn = SCREENS[screen] || SCREENS.home;
    window.scrollTo(0, 0);
    fn(S.params);
    $('main').focus({ preventScroll: true });
  }
  function back() {
    var prev = S.history.pop();
    if (prev) go(prev[0], prev[1], true); else go('home', {}, true);
  }
  function setMain(html) { $('main').innerHTML = html + '<p class="foot">' + esc(THEME.footer) + '</p>'; }
  function backBtn() { return '<button class="btn small" data-act="back">\u2190 Back</button>'; }

  /* ---------------- data ---------------- */
  function loadBoot(force) {
    if (S.boot && !force) return Promise.resolve(S.boot);
    busy('Getting the collection\u2026');
    return call('getBootstrap', S.role).then(function (b) {
      done(); S.boot = b; S.items = b.items; return b;
    });
  }
  function itemByKey(key) { for (var i = 0; i < S.items.length; i++) if (S.items[i].key === key) return S.items[i]; return null; }

  /* lazy thumbnails */
  var thumbQueue = [], thumbTimer = null, observer = null;
  function thumbHtml(it) {
    if (!it.folderId) return '<div class="thumb" data-nothumb>\uD83D\uDCF7</div>';
    var t = S.thumbs[it.folderId];
    if (t) return '<div class="thumb"><img alt="" src="' + t + '"></div>';
    if (t === null) return '<div class="thumb">\uD83D\uDCF7</div>';
    return '<div class="thumb" data-fid="' + esc(it.folderId) + '">\u23F3</div>';
  }
  function watchThumbs() {
    var els = document.querySelectorAll('[data-fid]');
    if (!('IntersectionObserver' in window)) { els.forEach(function (el) { queueThumb(el.getAttribute('data-fid')); }); return; }
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { observer.unobserve(en.target); queueThumb(en.target.getAttribute('data-fid')); } });
    }, { rootMargin: '300px' });
    els.forEach(function (el) { observer.observe(el); });
  }
  function queueThumb(fid) {
    if (!fid || S.thumbs[fid] !== undefined || thumbQueue.indexOf(fid) >= 0) return;
    thumbQueue.push(fid);
    clearTimeout(thumbTimer); thumbTimer = setTimeout(flushThumbs, 150);
  }
  function flushThumbs() {
    var batch = thumbQueue.splice(0, 24);
    if (!batch.length) return;
    call('getThumbs', batch).then(function (res) {
      Object.keys(res || {}).forEach(function (fid) {
        S.thumbs[fid] = res[fid];
        document.querySelectorAll('[data-fid="' + fid + '"]').forEach(function (el) {
          el.removeAttribute('data-fid');
          el.innerHTML = res[fid] ? '<img alt="" src="' + res[fid] + '">' : '\uD83D\uDCF7';
        });
      });
      if (thumbQueue.length) flushThumbs();
    }).catch(function () { batch.forEach(function (f) { S.thumbs[f] = null; }); });
  }

  /* ---------------- camera + uploads ---------------- */
  function readRaw(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var d = String(fr.result); resolve({ mime: file.type || 'application/octet-stream', b64: d.split(',')[1] || '', preview: (file.type || '').indexOf('image/') === 0 ? d : '' }); };
      fr.onerror = function () { reject(new Error('I couldn\u2019t read that file - try taking it again.')); };
      fr.readAsDataURL(file);
    });
  }
  function prepareFile(file) {
    var mb = file.size / 1048576;
    var isVid = (file.type || '').indexOf('video/') === 0;
    if (isVid && mb > THEME.maxUploadMb) {
      return Promise.reject(new Error('That video is ' + Math.round(mb) + ' MB - a bit big for the app. Pop it in the Drop Zone instead and it\u2019ll get sorted.'));
    }
    if (isVid || (file.type || '').indexOf('image/') !== 0) return readRaw(file);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var max = 2400, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
          var cv = document.createElement('canvas'); cv.width = Math.round(w * s); cv.height = Math.round(h * s);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          var d = cv.toDataURL('image/jpeg', 0.88);
          URL.revokeObjectURL(url);
          resolve({ mime: 'image/jpeg', b64: d.split(',')[1], preview: d });
        } catch (e) { URL.revokeObjectURL(url); readRaw(file).then(resolve); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); readRaw(file).then(resolve); };
      img.src = url;
    });
  }
  // mode: falsy = camera (photo), 'video' = camera (video), anything else = gallery
  function openCamera(target, mode) {
    S.camTarget = target;
    var inp = mode === 'video' ? $('vidInput') : mode ? $('pickInput') : $('camInput');
    inp.value = '';
    inp.click();
  }
  function onFiles(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    var target = S.camTarget; S.camTarget = null;
    if (!files.length || !target) return;
    if (target.mode === 'add') { addShots(files); return; }
    var n = 0, names = [];
    busy('Saving to the item\u2019s folder\u2026');
    files.reduce(function (p, f) {
      return p.then(function () { return prepareFile(f); }).then(function (pf) {
        return call('uploadMedia', target.key, target.name, pf.mime, pf.b64, target.makeMain ? 'Main' : 'auto', !!target.makeMain && n === 0);
      }).then(function (r) { n++; names.push(r.fileName); if (r.folderId) updateFolder(target.key, r.folderId); });
    }, Promise.resolve()).then(function () {
      done();
      toast(target.makeMain ? '\u2B50 New main photo saved. The old one is still in the folder.' : '\uD83C\uDF89 Saved ' + (n === 1 ? names[0] : n + ' files') + '. Nice one!', 'good');
      var it = itemByKey(target.key); if (it && it.folderId) delete S.thumbs[it.folderId];
      if (S.boot && S.boot.tiles.photos.next && S.boot.tiles.photos.next.key === target.key) S.boot = null;
      if (S.screen === 'item') go('item', S.params, true);
      else if (S.screen === 'photos' || S.screen === 'home') { S.boot = null; go(S.screen, S.params, true); }
    }).catch(function (e) { oops(e); if (n) toast('Saved ' + n + ', but one didn\u2019t go. Try that one again from the item page.', 'oops'); });
  }
  function updateFolder(key, fid) { var it = itemByKey(key); if (it) it.folderId = fid; }

  /* ---------------- help text ---------------- */
  var HELP = {
    home: ['This is your to-do board.', 'Each box has one button that sorts that job out. Start with whichever has the biggest number.', 'Use the search box to jump straight to anything.'],
    collection: ['Everything you own, with the newest photo of each.', 'Type in the search box or use the three filters (range, status, condition).', 'Tap any picture to open it.'],
    item: ['This is one item.', 'Tap \u201CAdd photo / video\u201D to use the camera - it saves straight into the item\u2019s own Drive folder.', 'Tap a photo to see it big, or make it the main photo.', 'Tap \u201CEdit details\u201D to fix the name, category, condition and so on.', 'Tap a platform under \u201CPosted on\u201D once it\u2019s been posted.'],
    edit: ['Change anything, then tap Save.', 'Year is just the 4 numbers, like 1999. Anything else goes in Year note.', 'Nothing gets deleted from here - the worst that can happen is a typo you can fix.'],
    add: ['Four quick steps: photo, name, range, condition.', 'Everything else is optional - you can add it later.', 'If it looks like you already have it, I\u2019ll ask before adding a second one.'],
    wanted: ['Things you\u2019re hunting for.', 'Got one? Tap \u201CGot it\u201D and it moves into the collection (I\u2019ll check first).'],
    checklists: ['How close you are to each full set.', 'Tap a set to see what\u2019s missing.'],
    checklist: ['Green = got it. The rest are still missing.', 'Tap \u201CGot it\u201D to tick one off - I\u2019ll check first.'],
    value: ['Private: only for ' + PRIV + '.', 'Totals, top 10 and paid vs value. These are estimates, mostly from sold prices.'],
    photos: ['Items that still need our own photos.', 'Tap \u201CTake photo\u201D and it goes straight into that item\u2019s folder.', 'Remember: no faces or people in shot.'],
    novalue: ['Items without a value yet.', 'Tap \u201CAdd value\u201D to type your best guess.'],
    settings: ['Switch between ' + THEME.roles.join(' and ') + ', take the tour again, or open the sheet and Drive folders.'],
    more: ['Everything else lives here: stats, posted on socials, spares, the missing list, export and help.', 'Tap any big button.'],
    stats: ['Totals and charts for the whole collection.', 'Money only shows for ' + PRIV + '.'],
    posted: ['What\u2019s been posted on socials, and what hasn\u2019t yet.', 'Tap an item, then tap a platform button to tick it.'],
    spares: ['Things you have more than one of.', 'Tap \u201CMark for sale\u201D on the copy you\u2019d sell. Nothing is deleted.'],
    missing: ['Everything still needed from every full-set checklist.', 'Search, or pick one checklist. Tap \u201CGot it\u201D to tick one off.'],
    export: ['Save a list into Drive as a spreadsheet file (CSV) or a PDF.', 'Filter in Collection first to export just some items.'],
    help: ['All the help topics are on this page.', 'Tap a topic to open it, or take the tour.']
  };
  function showHelp() {
    var lines = HELP[S.screen] || HELP.home;
    var body = '<ul>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      '<p class="hint">Still stuck? Nothing you do here deletes anything, so it\u2019s safe to try. If something looks wrong, tap Refresh, or ask your bot.</p>';
    sheet('Here\u2019s how this bit works', body, [
      { label: '\u21BB Refresh', value: 'refresh' },
      { label: '\uD83E\uDDED Take the tour', value: 'tour' },
      { label: '\u2753 All help topics', value: 'help' },
      { label: 'Show the first-day guide', value: 'guide' },
      { label: 'Switch user', value: 'who' },
      { label: 'Got it, thanks', value: 'ok', cls: 'main' }
    ]).then(function (v) {
      if (v === 'refresh') { S.boot = null; S.thumbs = {}; go(S.screen || 'home', S.params, true); }
      if (v === 'guide') go('guide', { i: 0 });
      if (v === 'tour') { LS.set('tourPending', '1'); go('home', {}, true); }
      if (v === 'help') go('help');
      if (v === 'who') go('who');
    });
  }

  /* ---------------- screens ---------------- */
  var SCREENS = {};

  SCREENS.guide = function (p) {
    var cards = [
      ['Welcome to ' + THEME.appName + '!', 'Your whole collection lives in your own Google Sheet and Drive. This app is just a friendlier way in.'],
      ['Snap it, save it', 'Tap Add, take a photo, give it a name, pick its category and condition. Done - it\u2019s in the sheet with its own photo folder.'],
      ['Find anything', 'Browse with photos, search, and filter by category, line, condition or posted. Tap any item to see all its photos.'],
      ['Track the fun stuff', 'Wanted list, missing checklists, stats, spares to sell and what\u2019s been posted on socials - all under More.'],
      ['One job at a time', 'Home shows what needs doing, each with one button to sort it. Stuck? The \u201CI\u2019m stuck\u201D button is on every screen.']
    ];
    var i = p.i || 0, c = cards[i];
    setMain('<div class="card guide yel"><div class="mascot">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteG') + '</div><h1>' + esc(c[0]) + '</h1><p>' + esc(c[1]) + '</p>' +
      '<div class="dots">' + cards.map(function (x, k) { return '<span class="' + (k === i ? 'on' : '') + '"></span>'; }).join('') + '</div>' +
      '<div class="stack"><button class="btn main full" data-act="guideNext" data-i="' + (i + 1) + '">' + (i < cards.length - 1 ? 'Next \u2192' : 'Let\u2019s go!') + '</button>' +
      (i < cards.length - 1 ? '<button class="btn full" data-act="guideSkip">Skip the intro</button>' : '') + '</div></div>');
    S.guideCount = cards.length;
  };

    function enterRole(role) {
    if (!LS.get('tourDone')) LS.set('tourPending', '1');
    S.role = role;
    LS.set('role', role);
    S.boot = null;
    S.history = [];
    S.pendingRole = '';
    S.pinDigits = '';
    S.pinError = '';
    go('home', {}, true);
  }
  function askDadPin(role) {
    S.pendingRole = role || PRIV;
    S.pinDigits = '';
    S.pinError = '';
    S.pinBusy = false;
    go('pin', {}, true);
  }
  function lockDadView() {
    clearDadToken();
    S.role = '';
    LS.set('role', '');
    S.boot = null;
    S.history = [];
    S.pendingRole = '';
    toast(PRIV + ' view is locked', 'good');
    go('who', {}, true);
  }
  function submitDadPin() {
    if (S.pinBusy || S.pinDigits.length !== 4) return;
    S.pinBusy = true; S.pinError = '';
    go('pin', {}, true);
    call('verifyDadPin', S.pinDigits).then(function (r) {
      S.pinBusy = false;
      S.pinDigits = '';
      if (r && r.ok && r.token) {
        storeDadToken(r.token, r.expires);
        enterRole(S.pendingRole || PRIV);
      } else {
        S.pinError = 'That PIN didn\u2019t match \u2014 have another go.';
        go('pin', {}, true);
      }
    }).catch(function (e) {
      S.pinBusy = false;
      S.pinDigits = '';
      S.pinError = 'That PIN didn\u2019t match \u2014 have another go.';
      go('pin', {}, true);
    });
  }
  SCREENS.pin = function () {
    var digits = S.pinDigits || '', err = S.pinError || '';
    var dots = '';
    for (var i = 0; i < 4; i++) dots += '<span class="pinDot' + (i < digits.length ? ' on' : '') + (err ? ' bad' : '') + '"></span>';
    var keys = [1,2,3,4,5,6,7,8,9,'',0,'del'];
    var pad = keys.map(function (k) {
      if (k === '') return '<span class="pinKey spacer"></span>';
      if (k === 'del') return '<button type="button" class="pinKey" data-act="pinDel" aria-label="Delete">\u2190</button>';
      return '<button type="button" class="pinKey" data-act="pinDigit" data-d="' + k + '"' + (S.pinBusy ? ' disabled' : '') + '>' + k + '</button>';
    }).join('');
    setMain('<div class="card yel center pinCard' + (err ? ' bad' : '') + '"><h1>\uD83D\uDD12 ' + esc(PRIV) + '\u2019s PIN</h1>' +
      '<p class="hint">Enter the 4-digit PIN to open ' + esc(PRIV) + ' view. Prices stay hidden until then.</p>' +
      '<div class="pinDots" aria-hidden="true">' + dots + '</div>' +
      (S.pinBusy ? '<p class="hint">Checking\u2026</p>' : (err ? '<p class="pinErr">' + esc(err) + '</p>' : '<p class="hint">&nbsp;</p>')) +
      '<div class="pinPad" role="group" aria-label="PIN pad">' + pad + '</div>' +
      '<button class="btn full" data-act="pinCancel" ' + (S.pinBusy ? 'disabled' : '') + '>Not now</button></div>');
  };

SCREENS.who = function () {
    setMain('<div class="card skyL center"><h1>Who\u2019s using it?</h1><p>Tap your name. You can switch any time from the top.</p><div class="stack">' +
      THEME.roles.map(function (r) { return '<button class="btn ' + (r === PRIV ? 'yel' : 'pink') + ' full" style="min-height:72px;font-size:22px" data-act="pickRole" data-role="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') +
      '</div></div>');
  };

  SCREENS.home = function () {
    loadBoot().then(function (b) {
      var t = b.tiles, h = '';
      h += '<h1>' + (S.role === PRIV ? 'Alright, ' : 'Hiya, ') + esc(S.role) + '! \uD83D\uDC4B</h1>';
      h += '<div class="search"><input id="homeSearch" type="search" placeholder="\uD83D\uDD0D Search the collection\u2026" aria-label="Search the collection" enterkeyhint="search"></div>';
      if (b.missing && (b.missing.tabs.length || b.missing.columns.length)) {
        h += '<div class="warn">\uD83D\uDEA7 The sheet is still being tidied up, so a few bits (like ' + esc(b.missing.columns.concat(b.missing.tabs).join(', ')) + ') will appear once that\u2019s finished. Everything else works.</div>';
      }
      h += '<div class="tiles">';
      // Photos to take
      h += '<div class="card yel tile"><div class="head">\uD83D\uDCF8 Photos to take</div><div class="big">' + t.photos.count + '</div>';
      if (t.photos.next) {
        h += '<div class="hint">Next up: <b>' + esc(t.photos.next.name) + '</b></div><button class="btn main" data-act="snapFor" data-key="' + esc(t.photos.next.key) + '">\uD83D\uDCF7 Take photo</button>' +
          '<button class="btn small" data-act="go" data-to="photos">See all ' + t.photos.count + '</button>';
      } else h += '<div class="hint">All done - every item has photos. \uD83C\uDF89</div>';
      h += '</div>';
      // No value
      h += '<div class="card skyL tile"><div class="head">\uD83D\uDCB7 No value yet</div><div class="big">' + t.noValue.count + '</div>';
      if (isPriv() && t.noValue.next) h += '<div class="hint">Next: <b>' + esc(t.noValue.next.name) + '</b></div><button class="btn main" data-act="valueFor" data-key="' + esc(t.noValue.next.key) + '">Add a value</button>' +
        '<button class="btn small" data-act="go" data-to="novalue">See all</button>';
      else if (!isPriv()) h += '<div class="hint">That\u2019s ' + esc(PRIV) + '\u2019s job \uD83D\uDE09</div>';
      else h += '<div class="hint">Everything has a value. \uD83C\uDF89</div>';
      h += '</div>';
      // Drop Zone
      var dz = t.dropZone || { count: -1 };
      h += '<div class="card pinkL tile"><div class="head">\uD83D\uDCE5 Drop Zone</div><div class="big">' + (dz.count >= 0 ? dz.count : '?') + '</div><div class="hint">files waiting to be sorted into item folders</div>' +
        '<a class="btn main" href="' + esc(dz.url || b.folders.dropZone) + '" target="_blank" rel="noopener">Open Drop Zone \u2197</a></div>';
      // Wanted
      h += '<div class="card tile"><div class="head">\u2B50 Wanted</div><div class="big">' + t.wanted.count + '</div><div class="hint">things on the hunt list</div><button class="btn main" data-act="go" data-to="wanted">See the wanted list</button></div>';
      // Checklist
      if (t.checklist) {
        var p = pct(t.checklist.owned, t.checklist.total);
        h += '<div class="card skyL tile"><div class="head">\u2705 ' + esc(clTitle(t.checklist.tab)) + ' checklist</div><div class="big">' + t.checklist.owned + ' / ' + t.checklist.total + '</div>' +
          '<div class="bar" role="img" aria-label="' + p + ' percent complete"><div style="width:' + p + '%"></div></div>' +
          '<button class="btn main" data-act="go" data-to="checklist" data-tab="' + esc(t.checklist.tab) + '">See what\u2019s missing</button></div>';
      }
      // Add
      h += '<div class="card pink tile"><div class="head">\u2795 Got something new?</div><div class="hint">Snap it, name it, done. It goes straight into the sheet with its own folder.</div><button class="btn main" data-act="go" data-to="add">Add an item</button></div>';
      h += '</div>';
      h += '<div class="row" style="margin-top:6px"><button class="btn small" data-act="refresh">\u21BB Refresh</button><button class="btn small" data-act="go" data-to="stats">\uD83D\uDCCA Stats</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button><button class="btn small" data-act="go" data-to="help">\u2753 Help</button></div>';
      setMain(h);
      if (LS.get('tourPending')) { LS.set('tourPending', ''); setTimeout(startTour, 350); }
      var hs = $('homeSearch');
      hs.addEventListener('keydown', function (e) { if (e.key === 'Enter') { S.filters.q = hs.value; S.shown = 60; go('collection'); } });
    }).catch(oops);
  };

  function filteredItems() {
    var f = S.filters, q = norm(f.q);
    var list = S.items.filter(function (it) {
      if (f.range && it.range !== f.range) return false;
      if (f.series && it.series !== f.series) return false;
      if (f.status && it.status !== f.status) return false;
      if (f.cond && it.condition !== f.cond) return false;
      if (f.posted === 'yes' && !it.posted) return false;
      if (f.posted === 'no' && it.posted) return false;
      if (f.photos === 'yes' && !it.folderId) return false;
      if (f.photos === 'no' && it.folderId) return false;
      if (q) { var hay = norm([it.name, it.range, it.id, it.series, it.character, it.maker, it.year].join(' ')); if (q.split(' ').some(function (w) { return hay.indexOf(w) < 0; })) return false; }
      return true;
    });
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    var sorts = {
      newest: function (a, b) { return idn(b) - idn(a) || b.row - a.row; },
      oldest: function (a, b) { return idn(a) - idn(b) || a.row - b.row; },
      az: function (a, b) { return a.name.localeCompare(b.name); },
      year: function (a, b) { return (parseInt(a.year, 10) || 9999) - (parseInt(b.year, 10) || 9999); },
      value: function (a, b) { return (b.v || 0) - (a.v || 0); }
    };
    if (f.sort && sorts[f.sort]) list = list.slice().sort(sorts[f.sort]);
    return list;
  }
  function activeFilterCount() { var f = S.filters; return ['range', 'series', 'status', 'cond', 'posted', 'photos'].filter(function (k) { return f[k]; }).length; }
  function opt(list, sel, allLabel) {
    return '<option value="">' + esc(allLabel) + '</option>' + list.map(function (x) { var v = Array.isArray(x) ? x[0] : x, l = Array.isArray(x) ? x[1] : x; return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  }
  function seriesFor(range) {
    var m = {};
    S.items.forEach(function (it) { if ((!range || it.range === range) && it.series && !/^unknown$/i.test(it.series)) m[it.series] = 1; });
    return Object.keys(m).sort();
  }
  function cardHtml(it) {
    return '<button class="gcard" data-act="item" data-key="' + esc(it.key) + '">' + thumbHtml(it) +
      (it.posted ? '<span class="badge" title="Posted on socials">\uD83D\uDCE3</span>' : '') +
      '<div class="gname">' + esc(it.name) + '<span class="gmeta">' + esc([it.range, it.status !== 'Owned' ? it.status : '', it.condition && it.condition !== 'Unknown' ? it.condition : ''].filter(Boolean).join(' \u00B7 ')) + '</span></div></button>';
  }
  SCREENS.collection = function () {
    loadBoot().then(function (b) {
      var L = b.lists, f = S.filters;
      var open = S.filtersOpen || activeFilterCount() > 0;
      var sortOpts = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['az', 'A to Z'], ['year', 'By year']];
      if (isPriv()) sortOpts.push(['value', 'Highest value']);
      var h = '<h1>' + esc(W('collectionTitle', 'Our collection')) + '</h1>' +
        '<div class="search"><input id="colSearch" type="search" placeholder="\uD83D\uDD0D Search name, character, line or ID" aria-label="Search" value="' + esc(f.q) + '" enterkeyhint="search"></div>' +
        '<div class="row" style="margin-bottom:8px"><button class="btn small' + (open ? ' yel' : '') + '" data-act="toggleFilters" id="filterBtn">\u2699\uFE0F Filters' + (activeFilterCount() ? ' (' + activeFilterCount() + ')' : '') + '</button>' +
        '<select id="fSort" aria-label="Sort" class="inline">' + opt(sortOpts, f.sort || 'newest', 'Sort') + '</select>' +
        (activeFilterCount() || f.q ? '<button class="btn small" data-act="clearFilters">\u2715 Clear</button>' : '') + '</div>' +
        '<div class="filters" id="filterBox"' + (open ? '' : ' hidden') + '>' +
        '<label class="field">Category</label><select id="fRange" aria-label="Category">' + opt(L.range, f.range, 'All categories') + '</select>' +
        '<label class="field">Line / series</label><select id="fSeries" aria-label="Line or series">' + opt(seriesFor(f.range), f.series, 'Any line') + '</select>' +
        '<label class="field">Condition</label><select id="fCond" aria-label="Condition">' + opt(L.condition, f.cond, 'Any condition') + '</select>' +
        '<label class="field">Status</label><select id="fStatus" aria-label="Status">' + opt(L.status, f.status, 'Any status') + '</select>' +
        '<label class="field">Posted on socials</label><select id="fPosted" aria-label="Posted">' + opt([['yes', 'Posted'], ['no', 'Not posted yet']], f.posted, 'Posted or not') + '</select>' +
        '<label class="field">Photos</label><select id="fPhotos" aria-label="Photos">' + opt([['yes', 'Has photos'], ['no', 'No photos yet']], f.photos, 'With or without') + '</select>' +
        '</div><div id="colGrid"></div>';
      setMain(h);
      var draw = function () {
        var list = filteredItems();
        S.lastList = list;
        var shown = list.slice(0, S.shown);
        var g = '<p class="hint">' + list.length + ' item' + (list.length === 1 ? '' : 's') + (f.q || activeFilterCount() ? ' match' : '') +
          (list.length ? ' \u00B7 <button class="linkish" data-act="go" data-to="export" data-tab="filtered">Export these</button>' : '') + '</p>';
        if (!list.length) g += '<div class="nudge">Nothing matches that. Try fewer words, or clear the filters. <button class="btn small" data-act="clearFilters">Clear filters</button></div>';
        g += '<div class="grid">' + shown.map(cardHtml).join('') + '</div>';
        if (list.length > shown.length) g += '<p class="center"><button class="btn" data-act="more">Show more (' + (list.length - shown.length) + ' left)</button></p>';
        $('colGrid').innerHTML = g;
        watchThumbs();
      };
      var t = null;
      $('colSearch').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { f.q = e.target.value; S.shown = 60; draw(); }, 200); });
      var bind = function (id, k, rerender) { $(id).addEventListener('change', function (e) { f[k] = e.target.value; if (k === 'range') f.series = ''; S.shown = 60; if (rerender) go('collection', {}, true); else draw(); }); };
      bind('fRange', 'range', true); bind('fSeries', 'series', true); bind('fStatus', 'status', true); bind('fCond', 'cond', true);
      bind('fPosted', 'posted', true); bind('fPhotos', 'photos', true); bind('fSort', 'sort');
      S.redrawGrid = draw;
      draw();
    }).catch(oops);
  };

  SCREENS.item = function (p) {
    busy('Opening\u2026');
    call('getItem', p.key, S.role).then(function (it) {
      done();
      S.current = it;
      var facts = [['Item ID', it.id], ['Category', it.range], ['Status', it.status], ['Condition', it.condition + (it.conditionOld && it.condition === 'Unknown' && !/^unknown$/i.test(it.conditionOld) ? ' (was: ' + it.conditionOld + ')' : '')],
        ['Packaging', it.packaging || (it.packagingOld && it.packagingOld !== 'Unknown' ? 'was: ' + it.packagingOld : '')], ['Line / series', it.series], ['Character', it.character], ['Maker', it.maker],
        ['Year', (it.year || (it.yearOld && it.yearOld !== 'Unknown' ? it.yearOld : '')) + (it.yearNote ? ' (' + it.yearNote + ')' : '')],
        ['Size', it.size], ['Material', it.material], ['Accessories', it.accessories],
        ['Quantity', it.quantity], ['Where it lives', it.location], ['Date got', it.dateGot]];
      var money = function (v) { return /^\s*-?\d+(\.\d+)?\s*$/.test(String(v || '')) ? gbp(+v) : v; };
      if (isPriv()) facts.push(['Paid', money(it.paid)], ['Where from', it.whereBought], ['Value', money(it.value)], ['Value source', it.valueSource]);
      facts.push(['Description', it.description && it.description !== it.name ? it.description : ''], ['Notes', it.notes]);
      facts = facts.filter(function (f) { return f[1] && !/^unknown$/i.test(String(f[1]).trim()); });
      var plats = (it.platforms || []).map(function (pl) {
        return '<button class="chip' + (pl.yes ? ' on' : '') + '" data-act="togglePosted" data-p="' + esc(pl.key) + '" aria-pressed="' + (pl.yes ? 'true' : 'false') + '">' + esc(pl.icon + ' ' + pl.label) + (pl.yes ? ' \u2713' : '') + '</button>';
      }).join('');
      var h = backBtn() + '<h1>' + esc(it.name) + '</h1>' +
        '<div id="hero" class="hero" data-act="heroOpen">' + (it.folderId ? '\u23F3' : '<span style="font-size:44px">\uD83D\uDCF7</span>') + '</div>' +
        '<div id="nudge"></div>' +
        '<div class="stack" style="margin:12px 0"><button class="btn main full" data-act="snapCurrent">\uD83D\uDCF7 Take photo</button>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="pickCurrent">\uD83D\uDDBC\uFE0F From gallery</button><button class="btn" style="flex:1" data-act="videoCurrent">\uD83C\uDFA5 Record video</button></div>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="replaceMain">\uD83D\uDD04 New main photo</button></div>' +
        '<div class="row"><button class="btn yel" style="flex:1" data-act="edit">\u270F\uFE0F Edit details</button>' +
        (it.folderId ? '<a class="btn" style="flex:1" href="https://drive.google.com/drive/folders/' + esc(it.folderId) + '" target="_blank" rel="noopener">\uD83D\uDCC1 Folder \u2197</a>' : '') + '</div>' +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full" data-act="gotItem">\u2705 Got it!</button>' : '') + '</div>' +
        '<h2>Photos</h2><div id="gallery" class="gallery"><div class="hint">' + (it.folderId ? 'Loading photos\u2026' : 'No photos yet.') + '</div></div>' +
        (plats ? '<div class="card skyL"><h3>\uD83D\uDCE3 Posted on</h3><div class="chips">' + plats + '</div><p class="hint">Tap one to tick it off when it\u2019s been posted.</p></div>' : '') +
        '<div class="card"><dl class="facts">' + facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl></div>';
      setMain(h);
      if (!it.folderId) { $('nudge').innerHTML = '<div class="nudge">\uD83D\uDCF7 No photos yet - tap \u201CAdd photo / video\u201D and I\u2019ll make its folder too.</div>'; return; }
      call('getItemPhotos', it.folderId).then(function (ph) {
        S.gallery = ph;
        if (!ph.length) { $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">No photos yet.</div>'; $('nudge').innerHTML = '<div class="nudge">\uD83D\uDCF7 Missing photo! Snap the front first - no faces in shot.</div>'; return; }
        var first = ph[0];
        $('hero').innerHTML = first.thumb ? '<img alt="' + esc(first.name) + '" src="' + first.thumb + '"><span class="zoom">\uD83D\uDD0D Tap to zoom</span>' : '<span style="font-size:44px">' + (first.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>';
        $('gallery').innerHTML = ph.map(function (x, i) {
          return '<button class="gthumb' + (x.main ? ' main' : '') + '" data-act="openPhoto" data-i="' + i + '" aria-label="' + esc(x.name) + '">' + (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span>' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') + (x.main ? '<b>Main</b>' : '') + (x.video ? '<i>\u25B6</i>' : '') + '</button>';
        }).join('') + '<p class="hint" style="grid-column:1/-1">' + ph.length + ' photo' + (ph.length === 1 ? '' : 's') + ' \u00B7 tap one to see it big or make it the main photo</p>';
        if (!ph.some(function (x) { return /- back\b/i.test(x.name); }) && !ph.some(function (x) { return x.video; })) $('nudge').innerHTML = '<div class="nudge">Tip: a photo of the back or box side helps with values later.</div>';
      }).catch(function () { $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">Couldn\u2019t load the photos - tap Refresh in \u201CI\u2019m stuck\u201D.</div>'; });
    }).catch(oops);
  };
  function openPhoto(i) {
    var x = (S.gallery || [])[i]; if (!x) return;
    var lb = $('lightbox');
    lb.innerHTML = '<div class="lbInner"><div class="lbImg">' + (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span style="font-size:60px">' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') + '</div>' +
      '<div class="lbName">' + esc(x.name) + (x.main ? ' \u00B7 <b>main photo</b>' : '') + '</div>' +
      '<div class="row lbBtns">' + (i > 0 ? '<button class="btn small" data-act="openPhoto" data-i="' + (i - 1) + '">\u2190</button>' : '') +
      (!x.main && !x.video ? '<button class="btn small yel" data-act="makeMain" data-i="' + i + '">\u2B50 Make main photo</button>' : '') +
      '<a class="btn small" href="' + esc(x.url) + '" target="_blank" rel="noopener">Open in Drive \u2197</a>' +
      (i < S.gallery.length - 1 ? '<button class="btn small" data-act="openPhoto" data-i="' + (i + 1) + '">\u2192</button>' : '') +
      '<button class="btn small main" data-act="closePhoto">Close</button></div></div>';
    lb.hidden = false;
    if (!x.video) call('getPhotoLarge', S.current.key, x.id).then(function (r) {
      if (lb.hidden || !r || !r.src) return;
      var img = lb.querySelector('.lbImg img'); if (img) img.src = r.src; else lb.querySelector('.lbImg').innerHTML = '<img alt="" src="' + r.src + '">';
    }).catch(function () { /* keep the small one */ });
  }

  function selectHtml(id, list, val) {
    var l = list.slice(); if (val && l.indexOf(val) < 0) l.unshift(val);
    return '<select id="' + id + '"><option value=""></option>' + l.map(function (x) { return '<option' + (x === val ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>';
  }
  SCREENS.edit = function () {
    var it = S.current; if (!it) return back();
    var L = S.boot ? S.boot.lists : { range: [], condition: [], packaging: [], status: [] };
    var txt = function (id, label, val, extra) { return '<label class="field" for="e_' + id + '">' + label + '</label><input type="text" id="e_' + id + '" value="' + esc(val) + '" ' + (extra || '') + '>'; };
    var sel = function (id, label, list, val) { return '<label class="field" for="e_' + id + '">' + label + '</label>' + selectHtml('e_' + id, list, val); };
    var h = backBtn() + '<h1>Edit</h1><div class="card">' +
      txt('name', 'Name', it.name) +
      sel('range', 'Range', L.range, it.range) +
      sel('condition', 'Condition', L.condition, it.condition) +
      sel('packaging', 'Packaging', L.packaging, it.packaging) +
      sel('status', 'Status', L.status, it.status) +
      '<details' + (S.params.focus === 'value' ? ' open' : '') + '><summary class="btn small" style="margin-top:12px">More details (optional)</summary>' +
      txt('year', 'Year (just the number)', it.year, 'inputmode="numeric" maxlength="4"') +
      txt('yearNote', 'Year note', it.yearNote) +
      txt('series', 'Line / series and number', it.series) +
      txt('character', 'Character', it.character) +
      txt('maker', 'Maker', it.maker) +
      txt('quantity', 'How many', it.quantity, 'inputmode="numeric"') +
      txt('location', 'Where it lives', it.location) +
      (isPriv() ? txt('paid', 'Price paid ' + (THEME.currency || '\u00A3') + ' (private)', it.paid, 'inputmode="decimal"') + txt('value', 'Value ' + (THEME.currency || '\u00A3') + ' (private)', it.value, 'inputmode="decimal"') : '') +
      '<label class="field" for="e_notes">Notes</label><textarea id="e_notes">' + esc(it.notes) + '</textarea></details>' +
      '<div class="stack" style="margin-top:14px"><button class="btn main full" data-act="saveEdit">\uD83D\uDCBE Save</button><button class="btn full" data-act="back">Cancel</button></div></div>';
    setMain(h);
    if (S.params.focus === 'value' && $('e_value')) $('e_value').focus();
  };
  function saveEdit() {
    var it = S.current, fields = ['name', 'range', 'condition', 'packaging', 'status', 'year', 'yearNote', 'series', 'character', 'maker', 'quantity', 'location', 'notes', 'paid', 'value'];
    var ch = {};
    fields.forEach(function (f) { var el = $('e_' + f); if (el && String(el.value).trim() !== String(it[f] == null ? '' : it[f])) ch[f] = el.value; });
    if (!Object.keys(ch).length) { toast('Nothing changed - all good.'); return back(); }
    if (ch.year && !/^\d{4}$/.test(ch.year.trim())) { sheet('Quick one about the year', '<p>Year works best as just the 4 numbers, like <b>1999</b>. Pop anything else (like \u201Cabout 1990\u201D) in Year note.</p>'); return; }
    var p = Promise.resolve(true);
    if (ch.status === 'Sold') p = confirmSheet('Mark as sold?', 'It stays in the sheet (nothing is deleted), it just won\u2019t count as owned any more.', 'Yes, it\u2019s sold', 'No');
    p.then(function (ok) {
      if (!ok) return;
      busy('Saving\u2026');
      return call('saveItem', it.key, it.name, ch, S.role).then(function (r) {
        done(); S.boot = null;
        toast(r.skipped && r.skipped.length ? 'Saved! (The sheet has no column for ' + r.skipped.join(', ') + ' yet, so those were skipped.)' : '\u2705 Saved', 'good');
        S.history.pop(); go('item', { key: it.key }, true);
      });
    }).catch(oops);
  }

  /* ---- Add: 4 steps ---- */
  function addState() { if (!S.add) S.add = { step: 1, shots: [], name: '', range: '', condition: '', more: {} }; return S.add; }
  function addShots(files) {
    var A = addState();
    busy('Getting the photo ready\u2026');
    files.reduce(function (p, f) {
      return p.then(function () { return prepareFile(f); }).then(function (pf) {
        var labels = THEME.photoLabels;
        var isVid = pf.mime.indexOf('video/') === 0;
        var used = A.shots.filter(function (s) { return !s.video; }).length;
        pf.video = isVid; pf.label = isVid ? 'Video' : (labels[used] || 'Photo ' + (used + 1));
        A.shots.push(pf);
      });
    }, Promise.resolve()).then(function () { done(); go('add', {}, true); }).catch(function (e) { oops(e); go('add', {}, true); });
  }
  SCREENS.add = function () {
    var A = addState();
    loadBoot().then(function (b) {
      var L = b.lists, h = '<h1>Add an item</h1><div class="steps">' + [1, 2, 3, 4].map(function (n) { return '<span class="' + (n <= A.step ? 'on' : '') + '"></span>'; }).join('') + '</div>';
      if (A.step === 1) {
        h += '<div class="card yel"><h2>1. Snap it \uD83D\uDCF8</h2><p>Front first, then back and sides if you like. No faces in shot.</p>' +
          '<div class="shots">' + A.shots.map(function (s, i) { return '<div class="shot">' + (s.preview ? '<img alt="" src="' + s.preview + '">' : '\uD83C\uDFAC') + '<b>' + esc(s.label) + '</b></div>'; }).join('') + '</div>' +
          '<div class="stack"><button class="btn main full" data-act="addSnap">\uD83D\uDCF7 ' + (A.shots.length ? 'Take another' : 'Take photo') + '</button>' +
          '<button class="btn full" data-act="addPick">\uD83D\uDDBC\uFE0F Choose from gallery</button>' +
          (A.shots.length ? '<button class="btn small" data-act="addClearShots">Start photos again</button>' : '') +
          '<button class="btn green full" data-act="addNext">' + (A.shots.length ? 'Next \u2192' : 'No photo right now \u2192') + '</button></div></div>';
      } else if (A.step === 2) {
        h += '<div class="card skyL"><h2>2. What is it?</h2><p class="hint">Whatever you\u2019d call it, e.g. \u201C' + esc(W('nameExample', 'Blue robot - 1985 boxed')) + '\u201D.</p>' +
          '<input type="text" id="addName" value="' + esc(A.name) + '" placeholder="Name" autocomplete="off" enterkeyhint="next">' +
          '<div class="stack" style="margin-top:12px"><button class="btn green full" data-act="addNext">Next \u2192</button><button class="btn full" data-act="addBack">\u2190 Back</button></div></div>';
      } else if (A.step === 3) {
        h += '<div class="card pinkL"><h2>3. Which range?</h2><input type="search" id="rangeFilter" placeholder="\uD83D\uDD0D Find a range" aria-label="Find a range"><div class="choice" id="rangeChoices" style="margin-top:10px">' +
          L.range.map(function (r) { return '<button class="btn small' + (A.range === r ? ' sel' : '') + '" data-act="addRange" data-v="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
          '<div class="stack" style="margin-top:12px"><button class="btn full" data-act="addBack">\u2190 Back</button></div></div>';
      } else {
        h += '<div class="card"><h2>4. What condition?</h2><div class="choice">' +
          L.condition.map(function (c) { return '<button class="btn small' + (A.condition === c ? ' sel' : '') + '" data-act="addCond" data-v="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
          '<details style="margin-top:12px"><summary class="btn small">More details (optional)</summary>' +
          '<label class="field" for="a_packaging">Packaging</label>' + selectHtml('a_packaging', L.packaging, A.more.packaging || '') +
          '<label class="field" for="a_status">Status</label>' + selectHtml('a_status', L.status, A.more.status || 'Owned') +
          '<label class="field" for="a_year">Year (just the number)</label><input type="text" id="a_year" inputmode="numeric" maxlength="4" value="' + esc(A.more.year || '') + '">' +
          '<label class="field" for="a_maker">Maker</label><input type="text" id="a_maker" value="' + esc(A.more.maker || '') + '">' +
          (isPriv() ? '<label class="field" for="a_paid">Price paid ' + (THEME.currency || '\u00A3') + ' (private)</label><input type="text" id="a_paid" inputmode="decimal" value="' + esc(A.more.paid || '') + '">' +
            '<label class="field" for="a_where">Where from</label><input type="text" id="a_where" value="' + esc(A.more.whereBought || '') + '">' : '') +
          '<label class="field" for="a_notes">Notes</label><textarea id="a_notes">' + esc(A.more.notes || '') + '</textarea></details>' +
          '<div class="warn" style="margin-top:12px"><b>Check:</b> ' + esc(A.name) + ' \u00B7 ' + esc(A.range) + ' \u00B7 ' + (A.condition ? esc(A.condition) : '<i>pick a condition</i>') + ' \u00B7 ' + A.shots.length + ' photo' + (A.shots.length === 1 ? '' : 's') + '</div>' +
          '<div class="stack"><button class="btn main full" data-act="addSave"' + (A.condition ? '' : ' disabled') + '>\uD83D\uDCBE Save to the collection</button><button class="btn full" data-act="addBack">\u2190 Back</button></div></div>';
      }
      setMain(h);
      if (A.step === 2) { var n = $('addName'); n.focus(); n.addEventListener('keydown', function (e) { if (e.key === 'Enter') addNext(); }); }
      if (A.step === 3) {
        $('rangeFilter').addEventListener('input', function (e) {
          var q = norm(e.target.value);
          document.querySelectorAll('#rangeChoices button').forEach(function (bt) { bt.hidden = q && norm(bt.textContent).indexOf(q) < 0; });
        });
      }
    }).catch(oops);
  };
  function addNext() {
    var A = addState();
    if (A.step === 2) {
      A.name = ($('addName').value || '').trim();
      if (!A.name) { sheet('It needs a name', '<p>Even a rough one is fine, like \u201C' + esc(W('roughName', 'blue robot thing')) + '\u201D. You can change it later.</p>'); return; }
      busy('Checking you haven\u2019t already got it\u2026');
      call('checkDuplicate', A.name).then(function (hits) {
        done();
        if (!hits.length) { A.step = 3; go('add', {}, true); return; }
        var body = '<p>Looks like you might already have:</p><ul>' + hits.map(function (x) { return '<li><b>' + esc(x.name) + '</b> <span class="muted">(' + esc(x.range) + ')</span></li>'; }).join('') + '</ul><p>Is this a different one, or a second copy?</p>';
        sheet('Already got it?', body, [{ label: 'It\u2019s a different one - carry on', value: 'go', cls: 'main' }, { label: 'Open the one I\u2019ve got', value: 'open' }, { label: 'Change the name', value: 'stay' }])
          .then(function (v) { if (v === 'go') { A.step = 3; go('add', {}, true); } else if (v === 'open') { go('item', { key: hits[0].key }); } });
      }).catch(function (e) { done(); A.step = 3; go('add', {}, true); });
      return;
    }
    A.step = Math.min(4, A.step + 1); go('add', {}, true);
  }
  function addSave() {
    var A = addState();
    var v = function (id) { var el = $(id); return el ? el.value.trim() : ''; };
    A.more = { packaging: v('a_packaging'), status: v('a_status') || 'Owned', year: v('a_year'), maker: v('a_maker'), paid: v('a_paid'), whereBought: v('a_where'), notes: v('a_notes') };
    if (A.more.year && !/^\d{4}$/.test(A.more.year)) { sheet('Quick one about the year', '<p>Year is just the 4 numbers, like <b>1999</b>. Leave it blank if you\u2019re not sure.</p>'); return; }
    var payload = { name: A.name, range: A.range, condition: A.condition, packaging: A.more.packaging, status: A.more.status, year: A.more.year, maker: A.more.maker, paid: A.more.paid, whereBought: A.more.whereBought, notes: A.more.notes };
    busy('Adding it to the sheet\u2026');
    call('addItem', payload, S.role).then(function (r) {
      var n = 0, failed = 0;
      return A.shots.reduce(function (p, s) {
        return p.then(function () {
          busy('Saving photo ' + (n + failed + 1) + ' of ' + A.shots.length + '\u2026');
          return call('uploadMedia', r.key, r.name, s.mime, s.b64, s.label).then(function () { n++; }, function () { failed++; });
        });
      }, Promise.resolve()).then(function () {
        done(); S.add = null; S.boot = null;
        var body = '<p><b>' + esc(r.name) + '</b> is in the collection' + (r.id ? ' as <b>' + esc(r.id) + '</b>' : '') + ', with its own folder and ' + n + ' photo' + (n === 1 ? '' : 's') + '.</p>' +
          (failed ? '<div class="nudge">' + failed + ' photo' + (failed === 1 ? '' : 's') + ' didn\u2019t go through - open the item and tap \u201CAdd photo\u201D to try again.</div>' : '');
        return sheet('\uD83C\uDF89 Added!', body, [{ label: 'Open it', value: 'open', cls: 'main' }, { label: 'Add another', value: 'again' }, { label: 'Home', value: 'home' }]).then(function (x) {
          if (x === 'open') go('item', { key: r.key }); else if (x === 'again') go('add', {}, true); else go('home');
        });
      });
    }).catch(oops);
  }

  /* ---- Wanted + checklists ---- */
  SCREENS.wanted = function () {
    busy('Getting the wanted list\u2026');
    call('getWanted', S.role).then(function (list) {
      done();
      var h = '<h1>\u2B50 Wanted</h1>' +
        '<div class="search"><input id="wantSearch" type="search" placeholder="\uD83D\uDD0D Search the wanted list" aria-label="Search wanted" autocomplete="off"></div>' +
        '<p class="hint" id="wantCount">' + list.length + ' on the hunt list. Got one? Tap \u201CGot it\u201D.</p>' +
        '<div class="row" style="margin-bottom:10px"><button class="btn small" data-act="go" data-to="missing">\uD83E\uDDE9 Missing from sets</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button></div>' +
        '<div class="list" id="wantList">' +
        (list.length ? list.map(function (w, i) {
          return '<div class="li" data-wq="' + esc(norm(w.name + ' ' + w.range)) + '"><div class="grow">' + esc(w.name) + '<small>' + esc([w.range, w.conditionWanted, isPriv() && w.maxPrice ? 'max ' + w.maxPrice : ''].filter(Boolean).join(' \u00B7 ')) + '</small></div>' +
            '<div class="stack" style="gap:6px"><button class="btn small" data-act="findCheapest" data-i="' + i + '">\uD83D\uDCB7 Find cheapest</button><button class="btn green small" data-act="gotWanted" data-i="' + i + '">Got it</button></div></div>';
        }).join('') : '<div class="nudge">Nothing on the wanted list right now.</div>') + '</div>' +
        '<p><button class="btn full" data-act="go" data-to="checklists">\u2705 Full-set checklists</button></p>';
      S.wantedList = list;
      setMain(h);
      $('wantSearch').addEventListener('input', function (e) {
        var q = norm(e.target.value);
        var shown = 0;
        document.querySelectorAll('#wantList [data-wq]').forEach(function (li) {
          var words = q ? q.split(' ') : [], txt = li.getAttribute('data-wq'), hit = words.every(function (w) { return txt.indexOf(w) >= 0; });
          li.hidden = !hit; if (hit) shown++;
        });
        $('wantCount').textContent = q ? shown + ' of ' + list.length + ' match \u201C' + e.target.value + '\u201D.' : list.length + ' on the hunt list. Got one? Tap \u201CGot it\u201D.';
      });
    }).catch(oops);
  };
  /* Price-check links only (opens the shop's own search; nothing is bought or bid on). */
  function findCheapest(i) {
    var w = S.wantedList[i]; if (!w) return;
    var q = encodeURIComponent(String(w.name || '').replace(/\s+/g, ' ').trim());
    var links = [
      ['\uD83D\uDED2 eBay UK - lowest price + postage', 'https://www.ebay.co.uk/sch/i.html?_nkw=' + q + '&_sop=15'],
      ['\uD83D\uDCE6 Amazon UK - lowest price', 'https://www.amazon.co.uk/s?k=' + q + '&s=price-asc-rank'],
      ['\uD83D\uDD0E Google Shopping', 'https://www.google.co.uk/search?tbm=shop&q=' + q]
    ];
    sheet('\uD83D\uDCB7 Find cheapest', '<p><b>' + esc(w.name) + '</b></p><p class="hint">Each one opens in a new tab. Check the condition and the postage before buying.</p><div class="stack">' +
      links.map(function (l) { return '<a class="btn full" href="' + esc(l[1]) + '" target="_blank" rel="noopener">' + esc(l[0]) + ' \u2197</a>'; }).join('') + '</div>',
      [{ label: 'Close', value: false }]);
  }
  function gotWanted(i) {
    var w = S.wantedList[i]; if (!w) return;
    confirmSheet('Got it? \uD83C\uDF89', 'Move <b>' + esc(w.name) + '</b> into the collection as Owned? I\u2019ll give it a folder so you can snap it next.', 'Yes, got it!', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy('Moving it into the collection\u2026');
      return call('markGotIt', w.kind, w.ref, w.name, S.role).then(function (r) {
        done(); S.boot = null; toast('\u2705 Nice one! It\u2019s in the collection now.', 'good');
        return confirmSheet('Snap it now?', 'Take a photo of <b>' + esc(r.name) + '</b> while it\u2019s in your hand?', '\uD83D\uDCF7 Take photo', 'Later').then(function (snap) {
          if (snap) openCamera({ key: r.key, name: r.name }); else go('wanted', {}, true);
        });
      });
    }).catch(oops);
  }
  SCREENS.checklists = function () {
    busy('Counting\u2026');
    call('getChecklists').then(function (cls) {
      done();
      setMain('<h1>\u2705 Full-set checklists</h1><div class="list">' + cls.map(function (c) {
        var p = pct(c.owned, c.total);
        return '<button class="li" style="width:100%;text-align:left;font-family:inherit;color:inherit" data-act="go" data-to="checklist" data-tab="' + esc(c.tab) + '"><div class="grow">' + esc(clTitle(c.tab)) +
          '<small>' + c.owned + ' of ' + c.total + ' (' + p + '%)</small><div class="bar" style="margin-top:6px"><div style="width:' + p + '%"></div></div></div><span>\u203A</span></button>';
      }).join('') + '</div>');
    }).catch(oops);
  };
  SCREENS.checklist = function (p) {
    busy('Opening the checklist\u2026');
    call('getChecklist', p.tab).then(function (c) {
      done(); S.checklistData = c;
      var showAll = !!p.all, pc = pct(c.owned, c.total);
      var rows = c.rows.filter(function (r) { return showAll || !r.got; });
      setMain(backBtn() + '<h1>' + esc(clTitle(c.tab)) + '</h1><div class="card skyL"><div class="big">' + c.owned + ' / ' + c.total + '</div><div class="bar" role="img" aria-label="' + pc + ' percent"><div style="width:' + pc + '%"></div></div></div>' +
        '<div class="row" style="margin-bottom:10px"><button class="btn small' + (showAll ? '' : ' yel') + '" data-act="clMode" data-all="">Missing (' + (c.total - c.owned) + ')</button><button class="btn small' + (showAll ? ' yel' : '') + '" data-act="clMode" data-all="1">All</button></div>' +
        '<div class="list">' + rows.map(function (r) {
          var badge = r.got ? '<span class="pill green">Got it</span>' : (/loose|\?/i.test(r.owned) ? '<span class="pill amber">' + esc(r.owned) + '</span>' : '<button class="btn green small" data-act="gotCl" data-row="' + r.row + '">Got it</button>');
          return '<div class="li"><div class="grow">' + esc(r.name) + '<small>' + esc([r.number, r.year].filter(Boolean).join(' \u00B7 ')) + '</small></div>' + badge + '</div>';
        }).join('') + '</div>');
    }).catch(oops);
  };
  function gotCl(row) {
    var c = S.checklistData; var r = c.rows.filter(function (x) { return x.row === row; })[0]; if (!r) return;
    confirmSheet('Tick it off?', 'Mark <b>' + esc(r.name) + '</b> as got on the ' + esc(clTitle(c.tab)) + ' checklist?', 'Yes, tick it', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy('Ticking it off\u2026');
      return call('markGotIt', 'checklist', c.tab + '|' + row, r.name, S.role).then(function () {
        done(); S.boot = null; toast('\u2705 Ticked off!', 'good');
        return confirmSheet('Add it to the collection?', 'Want to add <b>' + esc(r.name) + '</b> to the collection now with a photo?', 'Yes, add it', 'Later').then(function (add) {
          if (add) { S.add = { step: 1, shots: [], name: r.name, range: clTitle(c.tab), condition: '', more: {} }; go('add'); }
          else go('checklist', S.params, true);
        });
      });
    }).catch(oops);
  }

  /* ---- Value (private) ---- */
  SCREENS.value = function () {
    if (!isPriv()) { setMain('<div class="card center"><h1>\uD83D\uDD12 Just for ' + esc(PRIV) + '</h1><p>The value page is private.</p></div>'); return; }
    busy('Adding it all up\u2026');
    call('getValueReport', S.role).then(function (v) {
      done();
      var h = '<h1>\uD83D\uDCB7 Value (private)</h1><div class="tiles">' +
        '<div class="card yel tile"><div class="head">Estimated value</div><div class="big">' + gbp(v.totalValue) + '</div><div class="hint">' + v.valued + ' of ' + v.items + ' items valued</div></div>' +
        '<div class="card skyL tile"><div class="head">Paid</div><div class="big">' + gbp(v.totalPaid) + '</div><div class="hint">landed cost, where known</div></div>' +
        '<div class="card ' + (v.difference >= 0 ? 'pinkL' : '') + ' tile"><div class="head">Value vs paid</div><div class="big">' + (v.difference >= 0 ? '+' : '') + gbp(v.difference) + '</div></div></div>' +
        (v.notValued ? '<div class="nudge">' + v.notValued + ' items have no value yet. <button class="btn small" data-act="go" data-to="novalue">Add values</button></div>' : '') +
        '<div class="card"><h2>Top 10</h2><table class="tbl"><thead><tr><th>Item</th><th class="num">Paid</th><th class="num">Value</th></tr></thead><tbody>' +
        v.top.map(function (t) { return '<tr data-act="item" data-key="' + esc(t.key) + '"><td>' + esc(t.name) + '</td><td class="num">' + gbp(t.paid) + '</td><td class="num">' + gbp(t.value) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
        '<div class="card"><h2>Paid vs value by range</h2><table class="tbl"><thead><tr><th>Range</th><th class="num">Items</th><th class="num">Paid</th><th class="num">Value</th></tr></thead><tbody>' +
        v.byRange.map(function (r) { return '<tr><td>' + esc(r.range) + '</td><td class="num">' + r.items + '</td><td class="num">' + gbp(r.paid) + '</td><td class="num">' + gbp(r.value) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      setMain(h);
    }).catch(function (e) { if (THEME.needsPin && !dadUnlocked()) askDadPin(S.role || PRIV); else oops(e); });
  };

  SCREENS.photos = function () {
    busy('Finding what needs photos\u2026');
    call('getPhotoTodo', S.role).then(function (list) {
      done();
      setMain(backBtn() + '<h1>\uD83D\uDCF8 Photos to take</h1><p class="hint">' + list.length + ' items. Tap \u201CTake photo\u201D - it saves straight into that item\u2019s folder. No faces in shot.</p><div class="list">' +
        list.map(function (it) { return '<div class="li"><div class="grow" data-act="item" data-key="' + esc(it.key) + '">' + esc(it.name) + '<small>' + esc(it.range) + '</small></div><button class="btn main small" data-act="snapFor" data-key="' + esc(it.key) + '">\uD83D\uDCF7 Take photo</button></div>'; }).join('') + '</div>');
    }).catch(oops);
  };
  SCREENS.novalue = function () {
    busy('Finding items with no value\u2026');
    call('getNoValue', S.role).then(function (list) {
      done();
      setMain(backBtn() + '<h1>\uD83D\uDCB7 No value yet</h1><p class="hint">' + list.length + ' items. Tap \u201CAdd value\u201D and type your best guess.</p><div class="list">' +
        list.map(function (it) { return '<div class="li"><div class="grow">' + esc(it.name) + '<small>' + esc(it.range) + '</small></div><button class="btn yel small" data-act="valueFor" data-key="' + esc(it.key) + '">Add value</button></div>'; }).join('') + '</div>');
    }).catch(oops);
  };
  SCREENS.settings = function () {
    var f = S.boot ? S.boot.folders : null;
    setMain(backBtn() + '<h1>Settings</h1><div class="card stack">' +
      '<p>Using it as: <b>' + esc(S.role) + '</b></p><button class="btn full" data-act="go" data-to="who">Switch user</button>' +
      (THEME.needsPin && isPriv() ? '<button class="btn full" data-act="lockPriv">\uD83D\uDD12 Lock ' + esc(PRIV) + ' view</button>' : '') +
      '<button class="btn full" data-act="startTour">\uD83E\uDDED Take the tour again</button>' +
      '<button class="btn full" data-act="go" data-to="guide">Show the welcome cards</button>' +
      '<button class="btn full" data-act="go" data-to="help">\u2753 Help topics</button>' +
      (f ? '<a class="btn full" href="' + esc(f.sheet) + '" target="_blank" rel="noopener">Open the sheet \u2197</a><a class="btn full" href="' + esc(f.collection) + '" target="_blank" rel="noopener">' + esc(W('collectionFolder', 'Open the photos folder')) + ' \u2197</a><a class="btn full" href="' + esc(f.dropZone) + '" target="_blank" rel="noopener">Open the Drop Zone \u2197</a>' : '') +
      '<p class="hint">Version ' + esc(THEME.version || '') + '</p><p class="hint">Tip: on your phone, use the browser\u2019s Share or \u22EE menu and tap \u201CAdd to Home Screen\u201D to keep this app one tap away.</p></div>');
  };

  /* ---------------- More menu ---------------- */
  SCREENS.more = function () {
    var tiles = [
      ['stats', '\uD83D\uDCCA', 'Stats', 'Counts, categories and charts'],
      ['posted', '\uD83D\uDCE3', 'Posted on socials', 'What\u2019s been posted and what hasn\u2019t'],
      ['spares', '\uD83D\uDD01', 'Spares to sell', 'Doubles, and anything marked for sale'],
      ['missing', '\uD83E\uDDE9', 'Missing list', 'Everything still needed for the full sets'],
      ['checklists', '\u2705', 'Checklists', 'How close each full set is'],
      ['photos', '\uD83D\uDCF8', 'Photos to take', 'Items still needing our own photos']
    ];
    if (isPriv()) tiles.push(['value', '\uD83D\uDCB7', 'Value', 'Private: totals, top 10, paid vs value']);
    tiles.push(['export', '\uD83D\uDCE4', 'Export', 'Save a list as a spreadsheet file or PDF'],
      ['help', '\u2753', 'Help', 'How everything works'],
      ['settings', '\u2699\uFE0F', 'Settings', 'Switch user, tour, links']);
    setMain('<h1>More</h1><div class="menu">' + tiles.map(function (t) {
      return '<button class="mtile" data-act="go" data-to="' + t[0] + '"><span class="mic">' + t[1] + '</span><b>' + esc(t[2]) + '</b><small>' + esc(t[3]) + '</small></button>';
    }).join('') + '</div>');
  };

  /* ---------------- Help ---------------- */
  var FAQ = [
    ['\u2795 Adding something new', ['Tap <b>Add</b> at the bottom.', 'Take a photo (front first), type a name, pick the category, then the condition. That\u2019s it.', 'Everything else (year, maker, packaging, price) is optional under \u201CMore details\u201D.', 'If it looks like you already have it, I\u2019ll ask before adding a second one.']],
    ['\uD83D\uDCF8 Photos', ['Open any item and tap <b>Add photo / video</b>. It saves straight into that item\u2019s own Drive folder.', 'Tap <b>New main photo</b> to replace the picture that shows in the lists. The old one stays in the folder - nothing is deleted.', 'Tap any photo to see it big, then <b>Make main photo</b> to pick a different main one.', 'No faces in shot, please. Hands are fine.']],
    ['\uD83D\uDD0D Finding things', ['Use the search box on Home or in Collection. It searches names, characters, lines and IDs.', 'Tap <b>Filters</b> to narrow down by category, line, condition, status, posted or photos.', 'Use the sort menu for newest first, A to Z or by year.']],
    ['\u2B50 Wanted and missing', ['<b>Wanted</b> is your hunt list. Tap <b>Got it</b> when one arrives and it moves into the collection.', '<b>Missing list</b> (under More) shows everything still needed from every full-set checklist in one place.', '<b>Checklists</b> shows how close each set is.']],
    ['\uD83D\uDCE3 Posted on socials', ['Each item page has the platforms as buttons. Tap one to tick it once it\u2019s posted.', 'Under More \u2192 <b>Posted on socials</b> you can see what hasn\u2019t been posted yet - handy for planning.']],
    ['\uD83D\uDD01 Spares to sell', ['Under More \u2192 <b>Spares to sell</b> you\u2019ll see anything you have more than one of.', 'Tap <b>Mark for sale</b> on the copy you want to sell. It stays in the sheet, just with the status For sale.']],
    ['\uD83D\uDCCA Stats and value', ['<b>Stats</b> shows totals, categories, conditions, years and what\u2019s been posted.', 'Money (paid and value) only shows for ' + esc(THEME.privateRole) + '.', THEME.needsPin ? esc(THEME.privateRole) + ' view asks for a 4-digit PIN (once per device, for about 12 hours). Lock it again any time from Settings.' : '']],
    ['\uD83D\uDCE4 Export', ['Under More \u2192 <b>Export</b> you can save the whole collection, or what you\u2019ve filtered, as a spreadsheet file (CSV) or a PDF.', 'Files are saved into Drive and the link opens them.']],
    ['\uD83D\uDEE1\uFE0F Is it safe to tap around?', ['Yes. The app never deletes anything - no rows, no photos, no folders.', 'If something looks wrong, tap <b>I\u2019m stuck \u2192 Refresh</b>.']],
    ['\uD83D\uDCF1 Put it on your home screen', ['iPhone (Safari): tap Share, then <b>Add to Home Screen</b>.', 'Android (Chrome): tap \u22EE, then <b>Add to Home screen</b>.']]
  ];
  SCREENS.help = function () {
    setMain(backBtn() + '<h1>\u2753 Help</h1><div class="card yel center"><div class="mascot small">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteH') + '</div><p><b>New here?</b> Take the 1-minute tour of the main buttons.</p>' +
      '<div class="stack"><button class="btn main full" data-act="startTour">\uD83E\uDDED Take the tour</button><button class="btn full" data-act="go" data-to="guide">Show the welcome cards</button></div></div>' +
      FAQ.map(function (f, i) { return '<details class="card faq"' + (i === 0 ? ' open' : '') + '><summary>' + f[0] + '</summary><ul>' + f[1].filter(Boolean).map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul></details>'; }).join('') +
      '<p class="hint center">' + esc(THEME.appName) + ' \u00B7 version ' + esc(THEME.version || '') + '</p>');
  };

  /* ---------------- Guided tour (coach marks) ---------------- */
  var TOUR = [
    { sel: null, t: 'Quick tour \uD83D\uDC4B', b: 'Here are the main buttons. It takes a minute. Tap Next, or Skip any time.' },
    { sel: '#homeSearch', t: 'Search', b: 'Type any name, character or ID here to jump straight to it.' },
    { sel: '.tiles .tile', t: 'Your to-do board', b: 'Each box is one job, with one button to sort it. Start with the biggest number.' },
    { sel: '#tabbar [data-tab=collection]', t: 'Collection', b: 'Everything you own, with photos. Filter by category, line, condition or posted.' },
    { sel: '#tabbar [data-tab=add]', t: 'Add', b: 'Got something new? Snap it, name it, pick category and condition. Done.' },
    { sel: '#tabbar [data-tab=wanted]', t: 'Wanted', b: 'Your hunt list. Tap \u201CGot it\u201D when one turns up.' },
    { sel: '#tabbar [data-tab=more]', t: 'More', b: 'Stats, posted on socials, spares to sell, missing list, export and help.' },
    { sel: '#stuckBtn', t: 'I\u2019m stuck', b: 'Lost? Tap this on any screen for help, refresh or switching user.' },
    { sel: null, t: 'You\u2019re all set! \uD83C\uDF89', b: 'Nothing in the app ever deletes anything, so tap around and explore.' }
  ];
  function startTour(i) {
    i = i || 0;
    var step = TOUR[i]; if (!step) return closeTour(true);
    var ov = $('tour');
    if (!ov) { ov = document.createElement('div'); ov.id = 'tour'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); document.body.appendChild(ov); }
    var el = step.sel ? document.querySelector(step.sel) : null;
    if (step.sel && !el) return startTour(i + 1);
    var hole = '', pos = 'center';
    if (el) {
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect(), pad = 6;
      hole = '<div class="tHole" style="top:' + (r.top - pad) + 'px;left:' + (r.left - pad) + 'px;width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px"></div>';
      pos = r.top + r.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom';
    }
    ov.className = el ? 'withHole' : 'dim';
    ov.innerHTML = hole + '<div class="tBubble ' + pos + '"><div class="tStep">' + (i + 1) + ' of ' + TOUR.length + '</div><h2>' + esc(step.t) + '</h2><p>' + esc(step.b) + '</p>' +
      '<div class="row"><button class="btn main" data-act="tourNext" data-i="' + (i + 1) + '">' + (i < TOUR.length - 1 ? 'Next \u2192' : 'Finish') + '</button>' +
      (i > 0 ? '<button class="btn small" data-act="tourNext" data-i="' + (i - 1) + '">\u2190 Back</button>' : '') +
      (i < TOUR.length - 1 ? '<button class="btn small" data-act="tourSkip">Skip tour</button>' : '') + '</div></div>';
    ov.hidden = false;
  }
  function closeTour(finished) {
    var ov = $('tour'); if (!ov || ov.hidden) return;
    ov.hidden = true; ov.innerHTML = '';
    LS.set('tourDone', '1');
    if (finished) toast('\uD83C\uDF89 Tour done. Help is under More any time.', 'good');
  }

  /* ---------------- Stats ---------------- */
  function bars(rows, valueKey, fmt, max) {
    var top = Math.max.apply(null, rows.map(function (r) { return r[valueKey] || 0; }).concat([1]));
    return '<div class="hbars">' + rows.slice(0, max || 50).map(function (r) {
      var w = Math.max(2, Math.round((r[valueKey] || 0) * 100 / top));
      return '<div class="hb"><span class="hbL">' + esc(r.label) + '</span><span class="hbT"><span class="hbF" style="width:' + w + '%"></span></span><span class="hbV">' + (fmt ? fmt(r[valueKey]) : r[valueKey]) + '</span></div>';
    }).join('') + '</div>';
  }
  function cols(rows, valueKey, fmt) {
    var top = Math.max.apply(null, rows.map(function (r) { return r[valueKey] || 0; }).concat([1]));
    return '<div class="vbars">' + rows.map(function (r) {
      var hgt = Math.max(3, Math.round((r[valueKey] || 0) * 100 / top));
      return '<div class="vb"><span class="vbV">' + (fmt ? fmt(r[valueKey]) : r[valueKey]) + '</span><span class="vbT"><span class="vbF" style="height:' + hgt + '%"></span></span><span class="vbL">' + esc(r.label) + '</span></div>';
    }).join('') + '</div>';
  }
  function ring(part, total, label, colour) {
    var p = total ? part / total : 0, C = 2 * Math.PI * 42;
    return '<div class="ring"><svg viewBox="0 0 100 100" role="img" aria-label="' + esc(label) + ': ' + Math.round(p * 100) + ' percent"><circle cx="50" cy="50" r="42" fill="none" stroke="#FFFFFF" stroke-width="14"/>' +
      '<circle cx="50" cy="50" r="42" fill="none" stroke="' + colour + '" stroke-width="14" stroke-dasharray="' + (C * p).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 50 50)" stroke-linecap="round"/>' +
      '<text x="50" y="56" text-anchor="middle" font-size="20" font-weight="900" fill="' + THEME.colours.ink + '">' + Math.round(p * 100) + '%</text></svg><div><b>' + esc(label) + '</b><br><small>' + part + ' of ' + total + '</small></div></div>';
  }
  function monthLabel(k) { var m = k.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(+m[1] || 1) - 1] + ' ' + String(m[0]).slice(2); }
  SCREENS.stats = function () {
    busy('Crunching the numbers\u2026');
    call('getStats', S.role).then(function (st) {
      done();
      var c = THEME.colours;
      var h = backBtn() + '<h1>\uD83D\uDCCA Stats</h1><div class="tiles">' +
        '<div class="card yel tile"><div class="head">Items</div><div class="big">' + st.owned + '</div><div class="hint">in ' + st.categories + ' categories</div></div>' +
        '<div class="card skyL tile"><div class="head">Wanted</div><div class="big">' + st.wanted + '</div><div class="hint">on the hunt list</div></div>';
      if (st.money) {
        h += '<div class="card pinkL tile"><div class="head">\uD83D\uDD12 Spent</div><div class="big">' + gbp(st.money.paid) + '</div><div class="hint">' + st.money.paidCount + ' items with a price</div></div>' +
          '<div class="card tile"><div class="head">\uD83D\uDD12 Worth</div><div class="big">' + gbp(st.money.value) + '</div><div class="hint">' + (st.money.difference >= 0 ? '+' : '') + gbp(st.money.difference) + ' vs paid \u00B7 ' + st.money.valued + ' valued</div></div>';
      }
      h += '</div><div class="card"><h2>Progress</h2><div class="rings">' + ring(st.withPhotos, st.owned, 'Have photos', c.green) + ring(st.postedAny, st.owned, 'Posted on socials', c.pink) + '</div></div>';
      h += '<div class="card"><h2>By category</h2>' + bars(st.byCategory, 'n') + '</div>';
      if (st.money) {
        h += '<div class="card"><h2>\uD83D\uDD12 Value by category</h2>' + bars(st.byCategory.slice().sort(function (a, b) { return b.value - a.value; }).filter(function (r) { return r.value > 0; }), 'value', function (v) { return gbp(v).replace(/\.00$/, ''); }, 15) + '</div>';
        if (st.spendByMonth && st.spendByMonth.length) h += '<div class="card"><h2>\uD83D\uDD12 Spend by month</h2>' + cols(st.spendByMonth.map(function (m) { return { label: monthLabel(m.label), amount: m.amount }; }), 'amount', function (v) { return (THEME.currency || '\u00A3') + Math.round(v); }) + '<p class="hint">From the date got or purchase date, where the sheet has one.</p></div>';
      }
      h += '<div class="card"><h2>Posted on</h2>' + bars(st.platforms.map(function (p) { return { label: p.icon + ' ' + p.label, n: p.n }; }), 'n') + '<button class="btn small" data-act="go" data-to="posted">Open the posted tracker</button></div>';
      h += '<div class="card"><h2>Condition</h2>' + bars(st.byCondition, 'n') + '</div>';
      h += '<div class="card"><h2>Packaging</h2>' + bars(st.byPackaging, 'n') + '</div>';
      if (st.byDecade.length) h += '<div class="card"><h2>By decade</h2>' + cols(st.byDecade, 'n') + '</div>';
      if (st.recent.length) h += '<h2>Newest additions</h2><div class="grid">' + st.recent.map(cardHtml).join('') + '</div>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };

  /* ---------------- Posted tracker ---------------- */
  SCREENS.posted = function () {
    busy('Checking what\u2019s been posted\u2026');
    call('getPostedBoard', S.role).then(function (b) {
      done();
      S.postedBoard = b;
      var mode = S.postedMode || 'not', plat = S.postedPlat || '';
      var list = b.items.filter(function (it) {
        if (plat) return mode === 'not' ? it.pp.indexOf(plat) < 0 : it.pp.indexOf(plat) >= 0;
        return mode === 'not' ? !it.posted : !!it.posted;
      });
      var withPh = list.filter(function (it) { return it.folderId; });
      var ordered = mode === 'not' ? withPh.concat(list.filter(function (it) { return !it.folderId; })) : list;
      var h = backBtn() + '<h1>\uD83D\uDCE3 Posted on socials</h1>' +
        '<div class="card skyL"><div class="big">' + b.postedAny + ' / ' + b.total + '</div><div class="hint">items posted somewhere</div>' +
        '<div class="bar"><div style="width:' + pct(b.postedAny, b.total) + '%"></div></div>' +
        '<div class="chips" style="margin-top:10px">' + THEME.platforms.map(function (p) { return '<span class="chip on">' + esc(p.icon + ' ' + p.label + ' ' + (b.counts[p.key] || 0)) + '</span>'; }).join('') + '</div></div>' +
        '<div class="row" style="margin-bottom:8px"><button class="btn small' + (mode === 'not' ? ' yel' : '') + '" data-act="postedMode" data-v="not">Not posted yet</button><button class="btn small' + (mode === 'yes' ? ' yel' : '') + '" data-act="postedMode" data-v="yes">Posted</button>' +
        '<select id="postedPlat" class="inline" aria-label="Platform">' + opt(THEME.platforms.map(function (p) { return [p.key, p.label]; }), plat, 'Any platform') + '</select></div>' +
        '<p class="hint">' + list.length + ' item' + (list.length === 1 ? '' : 's') + (mode === 'not' ? ' \u00B7 ones with photos first, ready to post' : '') + '. Tap one to tick platforms.</p>' +
        '<div class="grid">' + ordered.slice(0, S.shownPosted || 60).map(cardHtml).join('') + '</div>' +
        (ordered.length > (S.shownPosted || 60) ? '<p class="center"><button class="btn" data-act="morePosted">Show more</button></p>' : '');
      setMain(h);
      $('postedPlat').addEventListener('change', function (e) { S.postedPlat = e.target.value; go('posted', {}, true); });
      watchThumbs();
    }).catch(oops);
  };
  function togglePosted(pkey) {
    var it = S.current; if (!it) return;
    var pl = (it.platforms || []).filter(function (x) { return x.key === pkey; })[0]; if (!pl) return;
    var yes = !pl.yes;
    confirmSheet(yes ? 'Posted on ' + pl.label + '?' : 'Untick ' + pl.label + '?', yes ? 'Tick <b>' + esc(it.name) + '</b> as posted on ' + esc(pl.label) + ' today?' : 'Mark <b>' + esc(it.name) + '</b> as not posted on ' + esc(pl.label) + '?', yes ? 'Yes, it\u2019s posted' : 'Yes, untick it', 'Cancel').then(function (ok) {
      if (!ok) return;
      busy('Saving\u2026');
      return call('setPosted', it.key, it.name, pkey, yes, S.role).then(function () { done(); S.boot = null; toast(yes ? '\u2705 Ticked ' + pl.label : 'Unticked ' + pl.label, 'good'); go('item', S.params, true); });
    }).catch(oops);
  }

  /* ---------------- Spares to sell ---------------- */
  SCREENS.spares = function () {
    busy('Looking for doubles\u2026');
    call('getDuplicates', S.role).then(function (d) {
      done();
      S.spares = d;
      var h = backBtn() + '<h1>\uD83D\uDD01 Spares to sell</h1><p class="hint">Things you have more than one of. Tap <b>Mark for sale</b> on the copy you\u2019d sell or swap - it stays in the sheet, just with status For sale.</p>';
      if (!d.groups.length) h += '<div class="nudge">No doubles found - every name is different. \uD83C\uDF89</div>';
      h += d.groups.map(function (g) {
        return '<div class="card"><h3>' + esc(g.name) + ' <span class="pill amber">\u00D7' + g.copies + '</span></h3><div class="list">' + g.items.map(function (it) {
          return '<div class="li">' + thumbHtml(it) + '<div class="grow" data-act="item" data-key="' + esc(it.key) + '">' + esc(it.id || 'No ID') + '<small>' + esc([it.condition, it.packaging, it.status].filter(Boolean).join(' \u00B7 ')) + '</small></div>' +
            (/for sale/i.test(it.status) ? '<span class="pill green">For sale</span>' : '<button class="btn small yel" data-act="markSale" data-key="' + esc(it.key) + '" data-name="' + esc(it.name) + '">Mark for sale</button>') + '</div>';
        }).join('') + '</div></div>';
      }).join('');
      if (d.forSale.length) h += '<h2>Marked for sale (' + d.forSale.length + ')</h2><div class="grid">' + d.forSale.map(cardHtml).join('') + '</div>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };
  function markSale(key, name) {
    confirmSheet('Mark for sale?', '<b>' + esc(name) + '</b> stays in the sheet (nothing is deleted). Its status just changes to For sale.', 'Yes, for sale', 'Not now').then(function (ok) {
      if (!ok) return;
      busy('Saving\u2026');
      return call('saveItem', key, name, { status: 'For sale' }, S.role).then(function () { done(); S.boot = null; toast('\u2705 Marked for sale', 'good'); go('spares', {}, true); });
    }).catch(oops);
  }

  /* ---------------- Missing (all checklists) ---------------- */
  SCREENS.missing = function () {
    busy('Gathering everything still missing\u2026');
    call('getAllMissing').then(function (rows) {
      done();
      S.missingRows = rows;
      var sets = {}; rows.forEach(function (r) { sets[r.set] = (sets[r.set] || 0) + 1; });
      var h = backBtn() + '<h1>\uD83E\uDDE9 Missing list</h1><p class="hint">' + rows.length + ' still needed across ' + Object.keys(sets).length + ' checklists.</p>' +
        '<div class="search"><input id="misSearch" type="search" placeholder="\uD83D\uDD0D Search the missing list" aria-label="Search missing" value="' + esc(S.misQ || '') + '"></div>' +
        '<select id="misSet" aria-label="Checklist">' + opt(Object.keys(sets).sort().map(function (k) { return [k, k + ' (' + sets[k] + ')']; }), S.misSet || '', 'All checklists') + '</select>' +
        '<div id="misList" class="list" style="margin-top:10px"></div>';
      setMain(h);
      var draw = function () {
        var q = norm(S.misQ || ''), st = S.misSet || '';
        var list = rows.filter(function (r) { return (!st || r.set === st) && (!q || norm(r.name + ' ' + r.number + ' ' + r.set).indexOf(q) >= 0); });
        $('misList').innerHTML = list.length ? list.slice(0, 300).map(function (r, i) {
          return '<div class="li"><div class="grow">' + esc(r.name) + '<small>' + esc([r.set, r.number, r.year].filter(Boolean).join(' \u00B7 ')) + '</small></div>' +
            (/loose|\?/i.test(r.owned) ? '<span class="pill amber">' + esc(r.owned) + '</span>' : '<button class="btn green small" data-act="gotMissing" data-i="' + rows.indexOf(r) + '">Got it</button>') + '</div>';
        }).join('') : '<div class="nudge">Nothing missing there. \uD83C\uDF89</div>';
      };
      var t = null;
      $('misSearch').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { S.misQ = e.target.value; draw(); }, 200); });
      $('misSet').addEventListener('change', function (e) { S.misSet = e.target.value; draw(); });
      draw();
    }).catch(oops);
  };
  function gotMissing(i) {
    var r = (S.missingRows || [])[i]; if (!r) return;
    confirmSheet('Tick it off?', 'Mark <b>' + esc(r.name) + '</b> as got on the ' + esc(r.set) + ' checklist?', 'Yes, tick it', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy('Ticking it off\u2026');
      return call('markGotIt', 'checklist', r.tab + '|' + r.row, r.name, S.role).then(function () {
        done(); S.boot = null; toast('\u2705 Ticked off!', 'good');
        return confirmSheet('Add it to the collection?', 'Want to add <b>' + esc(r.name) + '</b> to the collection now with a photo?', 'Yes, add it', 'Later').then(function (add) {
          if (add) { S.add = { step: 1, shots: [], name: r.name, range: r.set, condition: '', more: {} }; go('add'); }
          else go('missing', {}, true);
        });
      });
    }).catch(oops);
  }

  /* ---------------- Export ---------------- */
  SCREENS.export = function (p) {
    loadBoot().then(function () {
      var filtered = p && p.tab === 'filtered' && S.lastList ? S.lastList : null;
      S.exportKeys = filtered ? filtered.map(function (it) { return it.key; }) : null;
      var n = filtered ? filtered.length : S.items.length;
      var h = backBtn() + '<h1>\uD83D\uDCE4 Export</h1><div class="card skyL"><p>Exporting <b>' + n + ' item' + (n === 1 ? '' : 's') + '</b>' + (filtered ? ' (what you filtered in Collection)' : ' (the whole collection)') + '.</p>' +
        (filtered ? '<button class="btn small" data-act="go" data-to="export">Use the whole collection instead</button>' : '<p class="hint">Tip: filter in Collection first, then tap \u201CExport these\u201D to export just those.</p>') +
        (isPriv() ? '<p class="hint">\uD83D\uDD12 Includes paid and value because you\u2019re ' + esc(PRIV) + '.</p>' : '<p class="hint">Prices are left out.</p>') + '</div>' +
        '<div class="stack"><button class="btn main full" data-act="doExport" data-k="csv">\uD83D\uDCC4 Spreadsheet file (CSV)</button>' +
        '<button class="btn full" data-act="doExport" data-k="pdf">\uD83D\uDDA8\uFE0F PDF list</button>' +
        '<button class="btn full" data-act="doExport" data-k="pdfPhotos"' + (n > 120 ? ' disabled' : '') + '>\uD83D\uDDBC\uFE0F PDF with photos' + (n > 120 ? ' (filter to 120 or fewer)' : '') + '</button></div>' +
        '<div id="exportResult"></div>';
      setMain(h);
    }).catch(oops);
  };
  function doExport(kind) {
    var title = THEME.shortName + (S.exportKeys ? ' (filtered)' : ' collection');
    busy(kind === 'pdfPhotos' ? 'Making the PDF with photos - this can take a minute\u2026' : 'Making your file\u2026');
    var pr = kind === 'csv' ? call('exportCsv', S.role, S.exportKeys, title) : call('exportPdf', S.role, S.exportKeys, title, kind === 'pdfPhotos');
    pr.then(function (r) {
      done();
      $('exportResult').innerHTML = '<div class="card yel"><h3>\u2705 Saved to Drive</h3><p>' + esc(r.name) + ' (' + r.count + ' items)</p><a class="btn main full" href="' + esc(r.url) + '" target="_blank" rel="noopener">Open it \u2197</a></div>';
    }).catch(oops);
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (tab) { S.history = []; go(tab.getAttribute('data-tab'), {}, true); return; }
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.getAttribute('data-act'), key = el.getAttribute('data-key');
    switch (a) {
      case 'back': back(); break;
      case 'go': if (el.getAttribute('data-to') === 'guide') { go('guide', { i: 0 }); break; } go(el.getAttribute('data-to'), { tab: el.getAttribute('data-tab') }); break;
      case 'refresh': S.boot = null; S.thumbs = {}; go(S.screen, S.params, true); break;
      case 'guideNext': var i = +el.getAttribute('data-i'); if (i >= (S.guideCount || 5)) { LS.set('seenGuide', '1'); go(S.role ? 'home' : 'who', {}, true); } else go('guide', { i: i }, true); break;
      case 'guideSkip': LS.set('seenGuide', '1'); go(S.role ? 'home' : 'who', {}, true); break;
      case 'pickRole':
        var role = el.getAttribute('data-role');
        if (role === PRIV && THEME.needsPin && !dadUnlocked()) askDadPin(role);
        else enterRole(role);
        break;
      case 'pinDigit':
        if (S.pinBusy || (S.pinDigits || '').length >= 4) break;
        S.pinError = '';
        S.pinDigits = (S.pinDigits || '') + el.getAttribute('data-d');
        go('pin', {}, true);
        if (S.pinDigits.length === 4) setTimeout(submitDadPin, 80);
        break;
      case 'pinDel':
        if (S.pinBusy) break;
        S.pinError = '';
        S.pinDigits = (S.pinDigits || '').slice(0, -1);
        go('pin', {}, true);
        break;
      case 'pinCancel': S.pendingRole = ''; S.pinDigits = ''; S.pinError = ''; go('who', {}, true); break;
      case 'lockPriv': lockDadView(); break;
      case 'item': go('item', { key: key }); break;
      case 'more': S.shown += 60; if (S.redrawGrid) S.redrawGrid(); break;
      case 'clearFilters': S.filters = { q: '', range: '', series: '', status: '', cond: '', posted: '', photos: '', sort: 'newest' }; go('collection', {}, true); break;
      case 'snapFor': var it = itemByKey(key) || { key: key, name: '' }; openCamera({ key: key, name: it.name }); break;
      case 'valueFor': S.current = null; busy('Opening\u2026'); call('getItem', key, S.role).then(function (x) { done(); S.current = x; go('edit', { focus: 'value' }); }).catch(oops); break;
      case 'snapCurrent': openCamera({ key: S.current.key, name: S.current.name }); break;
      case 'pickCurrent': openCamera({ key: S.current.key, name: S.current.name }, 'gallery'); break;
      case 'videoCurrent': openCamera({ key: S.current.key, name: S.current.name }, 'video'); break;
      case 'findCheapest': findCheapest(+el.getAttribute('data-i')); break;
      case 'edit': go('edit', {}); break;
      case 'saveEdit': saveEdit(); break;
      case 'gotItem':
        confirmSheet('Got it? \uD83C\uDF89', 'Mark <b>' + esc(S.current.name) + '</b> as Owned?', 'Yes, got it!', 'Not yet').then(function (ok) {
          if (!ok) return; busy('Saving\u2026');
          return call('markGotIt', 'item', S.current.key, S.current.name, S.role).then(function () { done(); S.boot = null; toast('\u2705 It\u2019s officially ours!', 'good'); go('item', S.params, true); });
        }).catch(oops); break;
      case 'addSnap': openCamera({ mode: 'add' }); break;
      case 'addPick': openCamera({ mode: 'add' }, true); break;
      case 'addClearShots': addState().shots = []; go('add', {}, true); break;
      case 'addNext': addNext(); break;
      case 'addBack': var A = addState(); A.step = Math.max(1, A.step - 1); go('add', {}, true); break;
      case 'addRange': addState().range = el.getAttribute('data-v'); addState().step = 4; go('add', {}, true); break;
      case 'addCond': addState().condition = el.getAttribute('data-v'); document.querySelectorAll('[data-act=addCond]').forEach(function (b) { b.classList.toggle('sel', b === el); });
        var sv = document.querySelector('[data-act=addSave]'); if (sv) sv.disabled = false;
        var chk = document.querySelector('.warn i'); if (chk) chk.outerHTML = esc(addState().condition); break;
      case 'addSave': addSave(); break;
      case 'gotWanted': gotWanted(+el.getAttribute('data-i')); break;
      case 'gotCl': gotCl(+el.getAttribute('data-row')); break;
      case 'clMode': go('checklist', { tab: S.params.tab, all: el.getAttribute('data-all') }, true); break;
      case 'toggleFilters': S.filtersOpen = !($('filterBox') && !$('filterBox').hidden); go('collection', {}, true); break;
      case 'openPhoto': openPhoto(+el.getAttribute('data-i')); break;
      case 'closePhoto': $('lightbox').hidden = true; break;
      case 'heroOpen': if (S.gallery && S.gallery.length) openPhoto(0); break;
      case 'makeMain':
        var ph = S.gallery[+el.getAttribute('data-i')]; busy('Making it the main photo\u2026');
        call('setMainPhoto', S.current.key, S.current.name, ph.id).then(function () { done(); $('lightbox').hidden = true; if (S.current.folderId) delete S.thumbs[S.current.folderId]; toast('\u2B50 That\u2019s the main photo now', 'good'); go('item', S.params, true); }).catch(oops); break;
      case 'replaceMain': openCamera({ key: S.current.key, name: S.current.name, makeMain: true }); break;
      case 'togglePosted': togglePosted(el.getAttribute('data-p')); break;
      case 'postedMode': S.postedMode = el.getAttribute('data-v'); S.shownPosted = 60; go('posted', {}, true); break;
      case 'morePosted': S.shownPosted = (S.shownPosted || 60) + 60; go('posted', {}, true); break;
      case 'markSale': markSale(key, el.getAttribute('data-name')); break;
      case 'gotMissing': gotMissing(+el.getAttribute('data-i')); break;
      case 'doExport': doExport(el.getAttribute('data-k')); break;
      case 'startTour': LS.set('tourPending', '1'); go('home', {}, true); break;
      case 'tourNext': startTour(+el.getAttribute('data-i')); break;
      case 'tourSkip': closeTour(); toast('No problem - the tour is under More \u2192 Help.'); break;
    }
  });
  $('stuckBtn').addEventListener('click', showHelp);
  $('homeBtn').addEventListener('click', function () { if (S.role) { S.history = []; go(S.screen === 'home' ? 'settings' : 'home', {}, true); } });
  $('camInput').addEventListener('change', onFiles);
  $('pickInput').addEventListener('change', onFiles);
  if ($('vidInput')) $('vidInput').addEventListener('change', onFiles);
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) { /* tap outside: ignore so nothing is chosen by accident */ } });

  /* ---------------- start ---------------- */
  if (!LS.get('seenGuide')) go('guide', { i: 0 }, true);
  else if (!S.role) go('who', {}, true);
  else if (S.role === PRIV && THEME.needsPin && !dadUnlocked()) askDadPin(S.role);
  else go('home', {}, true);
})();
