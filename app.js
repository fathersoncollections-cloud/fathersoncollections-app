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
    filters: { q: '', range: '', series: '', status: '', cond: '', posted: '', photos: '', sort: 'newest' }, shown: 60, add: null, camTarget: null,
    kid: LS.get('kidMode') === '1', homeWanted: null
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

  /* ================= v4: offline layer (IndexedDB copy of the last data + a queue of changes) ================= */
  function noop() {}
  var IDB = (function () {
    var dbp = null;
    function db() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('no idb'));
        var r = indexedDB.open('fatherson-app', 2);
        r.onupgradeneeded = function () {
          var d = r.result, have = d.objectStoreNames;
          if (!have.contains('kv')) d.createObjectStore('kv');
          if (!have.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
          if (!have.contains('thumbs')) d.createObjectStore('thumbs');   // v5: one small JPEG per item
        };
        r.onsuccess = function () { var d = r.result; d.onversionchange = function () { d.close(); }; res(d); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(store, mode), req = fn(t.objectStore(store));
          t.oncomplete = function () { res(req ? req.result : undefined); };
          t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
      set: function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); },
      del: function (k) { return tx('kv', 'readwrite', function (s) { return s.delete(k); }); },
      tSet: function (k, v) { return tx('thumbs', 'readwrite', function (s) { return s.put(v, k); }); },
      tDel: function (k) { return tx('thumbs', 'readwrite', function (s) { return s.delete(k); }); },
      tAll: function () {
        return db().then(function (d) {
          return new Promise(function (res, rej) {
            var out = {}, t = d.transaction('thumbs', 'readonly'), cur = t.objectStore('thumbs').openCursor();
            cur.onsuccess = function () { var c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } };
            t.oncomplete = function () { res(out); }; t.onerror = function () { rej(t.error); };
          });
        });
      },
      qAdd: function (v) { return tx('queue', 'readwrite', function (s) { return s.add(v); }); },
      qAll: function () { return tx('queue', 'readonly', function (s) { return s.getAll(); }); },
      qDel: function (id) { return tx('queue', 'readwrite', function (s) { return s.delete(id); }); },
      keys: function () {
        return db().then(function (d) {
          return new Promise(function (res, rej) {
            var out = [], t = d.transaction('kv', 'readonly'), cur = t.objectStore('kv').openCursor();
            cur.onsuccess = function () { var c = cur.result; if (c) { out.push(c.key); c.continue(); } };
            t.oncomplete = function () { res(out); }; t.onerror = function () { rej(t.error); };
          });
        });
      }
    };
  })();
  var NET = {
    offline: navigator.onLine === false, savedAt: 0, queueLen: 0,
    down: function () { if (!this.offline) { this.offline = true; renderNetBar(); } },
    ok: function () { if (this.offline) { this.offline = false; this.savedAt = 0; renderNetBar(); setTimeout(syncQueue, 300); } }
  };
  function rawCall(fn, args) {
    return new Promise(function (resolve, reject) {
      if (window.FS_API) return window.FS_API(fn, args).then(resolve, reject);
      if (!window.google || !google.script) { var e0 = new Error('offline'); e0.network = true; return reject(e0); }
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn].apply(null, args);
    });
  }
  function isNetErr(e) {
    if (navigator.onLine === false) return true;
    return !!(e && (e.network || (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message || ''))));
  }
  function offlineErr() { return new Error('\uD83D\uDCF4 No signal right now, and this bit wasn\u2019t saved on the phone yet. It\u2019ll work again as soon as you\u2019re back online.'); }
  var READ_FNS = { getBootstrap: 1, getWanted: 1, getChecklists: 1, getChecklist: 1, getItem: 1, getStats: 1, getAllMissing: 1, getPostedBoard: 1, getDuplicates: 1, getPhotoTodo: 1, getNoValue: 1, getValueSummary: 1, getItemPhotos: 1, getHistory: 1, getRewards: 1, getQueuePhoto: 1, getScanQueue: 1 };
  var WRITE_FNS = { saveItem: 1, addItem: 1, markGotIt: 1, setPosted: 1, uploadMedia: 1, saveBarcode: 1, setMainPhoto: 1, requestReward: 1, decideReward: 1, saveRewards: 1, savePointRules: 1, saveJobs: 1, completeJob: 1, requestJob: 1, approveJob: 1, rejectJob: 1, decidePhoto: 1, queueScan: 1, dismissScan: 1, markScanAdded: 1 };
  function tokenNow() { return S.kid ? '' : (LS.get('dadToken') || ''); }   // Son's mode never sends the PIN token
  function cacheKey(fn, args) { return 'c|' + fn + '|' + JSON.stringify(args) + '|' + (tokenNow() && dadUnlocked() ? 'p' : 'n'); }
  function hasPending(args) { return args.some(function (a) { return typeof a === 'string' && a.indexOf('pending:') === 0; }); }
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    var full = args.concat([tokenNow()]);
    if (WRITE_FNS[fn]) {
      if (NET.offline && navigator.onLine === false) return queueWrite(fn, args);
      if (hasPending(args)) return queueWrite(fn, args);
      return rawCall(fn, full).then(function (r) { NET.ok(); return r; }, function (e) { if (isNetErr(e)) { NET.down(); return queueWrite(fn, args); } throw e; });
    }
    if (READ_FNS[fn]) {
      var ck = cacheKey(fn, args);
      var fromCache = function () {
        return IDB.get(ck).then(function (hit) {
          if (hit) { NET.savedAt = hit.at; renderNetBar(); return hit.r; }
          var f = offlineFallback(fn, args); if (f !== undefined) return f;
          throw offlineErr();
        }, function () { var f2 = offlineFallback(fn, args); if (f2 !== undefined) return f2; throw offlineErr(); });
      };
      if (navigator.onLine === false) { NET.down(); return fromCache(); }
      return rawCall(fn, full).then(function (r) {
        NET.ok();
        if (fn !== 'getItemPhotos' || (r && r.length)) IDB.set(ck, { at: Date.now(), r: r }).catch(noop);
        return r;
      }, function (e) { if (!isNetErr(e)) throw e; NET.down(); return fromCache(); });
    }
    return rawCall(fn, full).then(function (r) { NET.ok(); return r; }, function (e) { if (isNetErr(e)) { NET.down(); throw offlineErr(); } throw e; });
  }
  function offlineFallback(fn, args) {
    if (fn === 'getItem') {
      var it = itemByKey(args[0]); if (!it) return undefined;
      var o = JSON.parse(JSON.stringify(it));
      o.platforms = (THEME.platforms || []).map(function (p) { return { key: p.key, label: p.label, icon: p.icon, yes: (it.pp || []).indexOf(p.key) >= 0 }; });
      o.offlineCopy = true; return o;
    }
    if (fn === 'getItemPhotos') return [];
    if (fn === 'getWanted') return [];
    return undefined;
  }
  function queueWrite(fn, args) {
    var res = { ok: true, queued: true }, pk = '';
    if (fn === 'addItem' || (fn === 'markGotIt' && args[0] === 'wanted')) {
      pk = 'pending:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      res.key = pk; res.id = ''; res.folderId = ''; res.name = fn === 'addItem' ? args[0].name : args[2];
    }
    if (fn === 'markGotIt' && args[0] !== 'wanted') { res.key = args[0] === 'item' ? args[1] : ''; res.name = args[2]; }
    if (fn === 'saveItem') { res.written = Object.keys(args[2] || {}); res.skipped = []; }
    if (fn === 'uploadMedia') res.fileName = 'the photo (kept on the phone until you\u2019re back online)';
    if (fn === 'saveBarcode') res.barcode = args[2];
    var entry = { fn: fn, args: args, at: Date.now(), pk: pk };
    return IDB.qAdd(entry).then(function () {
      NET.queueLen++; applyQueued(entry); renderNetBar(); return res;
    }, function () { throw offlineErr(); });
  }
  /* Show queued (not yet synced) changes straight away, so the phone looks right offline. */
  function applyQueued(en) {
    var a = en.args, it;
    if (!S.items) return;
    if (en.fn === 'addItem') {
      if (!itemByKey(en.pk)) S.items.unshift({ key: en.pk, id: '', name: a[0].name, range: a[0].range || 'Other', status: a[0].status || 'Owned', condition: a[0].condition || 'Unknown', folderId: '', pp: [], pending: true });
    } else if (en.fn === 'markGotIt' && a[0] === 'wanted') {
      if (!itemByKey(en.pk)) S.items.unshift({ key: en.pk, id: '', name: a[2], range: 'Other', status: 'Owned', condition: 'Unknown', folderId: '', pp: [], pending: true });
    } else if (en.fn === 'markGotIt' && a[0] === 'item') {
      it = itemByKey(a[1]); if (it) it.status = 'Owned';
    } else if (en.fn === 'saveItem') {
      it = itemByKey(a[0]); if (it) Object.keys(a[2] || {}).forEach(function (k) { if (['name', 'range', 'condition', 'packaging', 'status', 'series', 'character', 'maker', 'year'].indexOf(k) >= 0) it[k] = a[2][k]; });
    } else if (en.fn === 'saveBarcode') {
      it = itemByKey(a[0]); if (it) it.bc = String(a[2]);
    }
  }
  var syncing = false;
  function syncQueue() {
    if (syncing || navigator.onLine === false) return Promise.resolve();
    syncing = true;
    var doneN = 0, failed = [];
    return IDB.qAll().then(function (list) {
      NET.queueLen = list.length;
      if (!list.length) return;
      renderNetBar('Syncing ' + list.length + ' change' + (list.length === 1 ? '' : 's') + '\u2026');
      return IDB.get('pendingMap').then(function (pm) {
        pm = pm || {};
        return list.reduce(function (p, en) {
          return p.then(function () {
            var a = en.args.map(function (x) { return typeof x === 'string' && pm[x] ? pm[x] : x; });
            if (hasPending(a)) { failed.push({ fn: en.fn, error: 'the item it belonged to didn\u2019t save' }); return IDB.qDel(en.id); }
            return rawCall(en.fn, a.concat([tokenNow()])).then(function (r) {
              if (en.pk && r && r.key) pm[en.pk] = r.key;
              doneN++; NET.queueLen = Math.max(0, NET.queueLen - 1);
              return IDB.qDel(en.id);
            }, function (e) {
              if (isNetErr(e)) throw e;
              failed.push({ fn: en.fn, name: (en.fn === 'addItem' ? a[0].name : a[1]) || '', error: (e && e.message) || 'error' });
              NET.queueLen = Math.max(0, NET.queueLen - 1);
              return IDB.qDel(en.id);
            });
          });
        }, Promise.resolve()).then(function () { return IDB.set('pendingMap', pm); }, function (e) { IDB.set('pendingMap', pm); throw e; });
      });
    }).then(function () {
      syncing = false; renderNetBar();
      if (doneN || failed.length) {
        S.boot = null;
        if (doneN) toast('\u2705 Back online - ' + doneN + ' change' + (doneN === 1 ? '' : 's') + ' synced to the sheet', 'good');
        if (failed.length) sheet('A couple of things didn\u2019t sync', '<ul>' + failed.map(function (f) { return '<li><b>' + esc(f.name || f.fn) + '</b>: ' + esc(f.error) + '</li>'; }).join('') + '</ul><p class="hint">Nothing was deleted. Try those again now you\u2019re online.</p>');
        if (['home', 'collection', 'kid', 'kidStuff', 'kidHunt', 'wanted'].indexOf(S.screen) >= 0) go(S.screen, S.params, true);
      }
    }, function () { syncing = false; renderNetBar(); });
  }
  function fmtWhen(ms) {
    var d = new Date(ms);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function netBarHtml(msg) {
    if (msg) return '<div id="netBar" class="netBar sync">\u23F3 ' + esc(msg) + '</div>';
    if (NET.offline) return '<div id="netBar" class="netBar off">\uD83D\uDCF4 No signal - showing the copy saved on this phone' + (NET.savedAt ? ' (from ' + esc(fmtWhen(NET.savedAt)) + ')' : '') + '.' +
      (NET.queueLen ? ' <b>' + NET.queueLen + ' change' + (NET.queueLen === 1 ? '' : 's') + '</b> will sync when you\u2019re back online.' : ' You can still look, add and edit - it\u2019ll sync later.') + '</div>';
    if (NET.queueLen) return '<div id="netBar" class="netBar sync">\u23F3 ' + NET.queueLen + ' change' + (NET.queueLen === 1 ? '' : 's') + ' waiting to sync <button class="btn small" data-act="syncNow">Sync now</button></div>';
    return '<div id="netBar" hidden></div>';
  }
  function renderNetBar(msg) {
    var el = $('netBar'); if (!el) return;
    var t = document.createElement('div'); t.innerHTML = netBarHtml(msg);
    el.parentNode.replaceChild(t.firstChild, el);
  }
  window.addEventListener('online', function () { NET.ok(); syncQueue(); });
  window.addEventListener('offline', function () { NET.down(); });


  /* ================= v4: never-show list (extra safety on the phone; the server already hides these) ================= */
  function hz(s) { var x = 0x811c9dc5; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x.toString(36); }
  var HIDE_SETS = [['1wgy7nv','1d6zpta','mfmdd6'],['1wgy7nv','1d6zpta','1l63qgk'],['1d6zpta','mfmdd6','hsvxxv'],['1d6zpta','1l63qgk','hsvxxv'],['9z0ds4','rkam7y'],['9z0ds4','14uzzlw'],['4pxbrz','nlfd37'],['nylwcb'],['itm3ea','rk4q8w'],['1d6zpta','mfmdd6','3w6b96'],['tc6gpo','1l63qgk'],['tc6gpo','1ojryhf'],['1wgq10c','cftjjb'],['ckzsb7','ms7go9','nylwcb'],['1nvng9d','ms7go9','nylwcb']];
  function neverShow(name) {
    var s = String(name || '');
    if (/#\s*194[5-9]\b/.test(s)) return true;
    var toks = norm(s.replace(/&/g, ' and ').replace(/#/g, ' ')).split(' '), hs = {};
    toks.forEach(function (t) { if (t) hs[hz(t)] = 1; });
    if (hs.fqi58g && toks.some(function (t) { return /^194[5-9]$/.test(t); })) return true;
    return HIDE_SETS.some(function (set) { return set.every(function (h) { return hs[h]; }); });
  }
  /* Hidden from Son (same list as the server's HIDE_FROM_SON) */
  var SON_HIDE_RE = /\b(playboy|nude|naked|nudie|topless|xxx|adults? only|over 18s)\b/i;
  function sonHidden(name) { return SON_HIDE_RE.test(String(name || '')); }
  /* Son's mode also leaves out anything Christmassy or gift-related, to be safe.
     Word boundaries so "Santa Cruz" / "Secrets" etc. are not caught; known titles are allow-listed. */
  var KID_SAFE_ALLOW_RE = /santa['\u2019]?s\s+little\s+helper|santa\s+cruz|gift\s+of\s+the\s+maggie|gift\s+with\s+purchase|mathematical\s+secrets/ig;
  var KID_UNSAFE_RE = /\bchristmas\b|\bxmas\b|\bx-mas\b|\bsecrets?\b|\bgifts?\b|\bpresents?\b|\bsanta\b/i;
  function kidSafeText(s) { return String(s || '').replace(KID_SAFE_ALLOW_RE, ' '); }
  function kidSafe(it) {
    if (!it || neverShow(it.name) || sonHidden(it.name)) return false;
    var t = kidSafeText([it.name, it.range, it.series].join(' '));
    return !KID_UNSAFE_RE.test(t);
  }
  /* Christmas presents hidden from Son until Dad says otherwise. By Item ID, so adding photos later does not reveal them. */
  var KID_PRESENT_IDS = { 'FS-0424':1, 'FS-0423':1, 'FS-0418':1, 'FS-0412':1, 'FS-0304':1, 'FS-0124':1, 'FS-0099':1, 'FS-0098':1 };
  function isKidPresent(it) {
    var id = String((it && it.id) || '').toUpperCase();
    return !!(id && KID_PRESENT_IDS[id]);
  }
  function kidVisible(it) {
    if (!kidSafe(it) || isKidPresent(it)) return false;
    return true;
  }
  function filterKidPayload(list) {
    return (list || []).filter(function (it) { return kidVisible(it); });
  }

  /* ================= v4: fuzzy "Do I own it?" ================= */
  var OWNED_ST = ['Owned', 'On order', 'For sale'];
  function isOwned(it) { return OWNED_ST.indexOf(it.status || 'Owned') >= 0; }
  function fz(s) { return norm(String(s || '').replace(/&/g, ' and ').replace(/#/g, ' ')); }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  function fuzzyScore(q, qt, it) {
    if (!it._fz) { it._fzName = fz(it.name); it._fz = fz([it.name, it.character, it.series, it.range, it.id, it.maker, it.year].join(' ')).split(' ').filter(Boolean); }
    if (it._fzName.indexOf(q) >= 0) return 1;
    var sum = 0;
    for (var i = 0; i < qt.length; i++) {
      var w = qt[i], best = 0;
      for (var k = 0; k < it._fz.length && best < 1; k++) {
        var h = it._fz[k], s = 0;
        if (h === w) s = 1;
        else if (w.length >= 2 && h.indexOf(w) === 0) s = 0.9;
        else if (w.length >= 3 && h.indexOf(w) >= 0) s = 0.75;
        else if (w.length >= 4 && !/^\d+$/.test(w)) { var d = lev(w, h); if (d === 1) s = 0.72; else if (d === 2 && w.length >= 7) s = 0.55; }
        if (s > best) best = s;
      }
      sum += best;
    }
    return qt.length ? sum / qt.length : 0;
  }
  function fuzzyFind(query, list, max) {
    var q = fz(query), qt = q.split(' ').filter(Boolean);
    if (!q) return [];
    return list.map(function (it) { return { it: it, s: fuzzyScore(q, qt, it) }; })
      .filter(function (x) { return x.s >= 0.45; })
      .sort(function (a, b) { return b.s - a.s || a.it.name.length - b.it.name.length; }).slice(0, max || 6);
  }
  function ownResultHtml(query) {
    var q = String(query || '').trim();
    if (q.length < 2) return '';
    var items = (S.items || []).filter(function (it) { return !neverShow(it.name) && (!S.kid || kidVisible(it)); });
    var owned = fuzzyFind(q, items.filter(isOwned), 5);
    var wantedItems = fuzzyFind(q, items.filter(function (it) { return it.status === 'Wanted'; }), 2);
    var wl = fuzzyFind(q, (S.homeWanted || []).filter(function (w) { return !neverShow(w.name); }).map(function (w) { return { name: w.name, range: w.range, key: '', status: 'Wanted' }; }), 2);
    var sold = fuzzyFind(q, items.filter(function (it) { return it.status === 'Sold'; }), 2);
    var top = owned[0] ? owned[0].s : 0, h;
    if (top >= 0.8) {
      var strong = owned.filter(function (x) { return x.s >= 0.8; });
      h = '<div class="own yes"><div class="ownHead">\u2705 Yes - you\u2019ve got ' + (strong.length > 1 ? strong.length + ' that match' : 'it') + '!</div>';
    } else if (top >= 0.55) {
      h = '<div class="own maybe"><div class="ownHead">\uD83E\uDD14 Not sure - is it one of these?</div>';
    } else {
      h = '<div class="own no"><div class="ownHead">\u274C Not in the collection</div>';
      if (wantedItems.length || wl.length) h += '<p class="hint">\u2B50 But it\u2019s on the Wanted list: <b>' + esc((wantedItems[0] || wl[0]).it.name) + '</b></p>';
      else h += '<p class="hint">Nothing owned matches \u201C' + esc(q) + '\u201D. Try fewer words, or scan the barcode.</p>';
      if (sold.length && sold[0].s >= 0.8) h += '<p class="hint">You did have <b>' + esc(sold[0].it.name) + '</b> (marked Sold).</p>';
    }
    if (top >= 0.55) h += '<div class="list">' + owned.filter(function (x) { return x.s >= 0.55; }).map(function (x) {
      return '<button class="li ownLi" data-act="item" data-key="' + esc(x.it.key) + '">' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) + '<small>' + esc([x.it.range, x.it.status !== 'Owned' ? x.it.status : '', x.it.condition && x.it.condition !== 'Unknown' ? x.it.condition : ''].filter(Boolean).join(' \u00B7 ')) + '</small></div><span>\u203A</span></button>';
    }).join('') + '</div>';
    return h + '</div>';
  }
  function bindOwnSearch(inputId, outId) {
    var inp = $(inputId), out = $(outId), t = null; if (!inp || !out) return;
    var run = function () { out.innerHTML = ownResultHtml(inp.value); watchThumbs(); };
    inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { if ((inp.value || '').trim().length >= 2) bumpKid('kidSearches'); run(); }, 120); });
    if (inp.value) run();
  }

  /* ================= v4: barcodes ================= */
  function bcDigits(c) { return String(c == null ? '' : c).replace(/[^0-9]/g, ''); }
  function bcKey(c) { return bcDigits(c).replace(/^0+/, ''); }   // UPC-A and EAN-13 with a leading 0 are the same code
  function localBarcodes() { try { return JSON.parse(LS.get('barcodes') || '{}') || {}; } catch (e) { return {}; } }
  function itemBarcode(it) { return (it && (it.bc || localBarcodes()[it.key])) || ''; }
  function itemsByBarcode(code) {
    var k = bcKey(code); if (!k) return [];
    return (S.items || []).filter(function (it) { var b = itemBarcode(it); return b && bcKey(b) === k && !neverShow(it.name) && (!S.kid || kidVisible(it)); });
  }
  function saveBarcodeTo(key, name, code) {
    code = bcDigits(code);
    var m = localBarcodes(); m[key] = code; LS.set('barcodes', JSON.stringify(m));
    var it = itemByKey(key); if (it) it.bc = code;
    busy('Saving the barcode\u2026');
    return call('saveBarcode', key, name, code, S.role).catch(function (e) {
      if (!/unknown action/i.test((e && e.message) || '')) throw e;
      // Older Apps Script version (before the v4 update): keep it in Notes as "Barcode: 123..." instead.
      return call('getItem', key, S.role).then(function (full) {
        if (new RegExp('barcode\\s*[:#]?\\s*' + code).test(String(full.notes || '').replace(/\s/g, '').replace(/barcode:?/i, 'barcode:'))) return { ok: true, where: 'notes' };
        var notes = String(full.notes || ''); notes = notes ? notes + ' | Barcode: ' + code : 'Barcode: ' + code;
        return call('saveItem', key, name, { notes: notes }, S.role).then(function () { return { ok: true, where: 'notes' }; });
      });
    }).then(function (r) {
      done();
      toast(r && r.queued ? '\uD83C\uDFF7\uFE0F Barcode saved on the phone - it\u2019ll go into the sheet when you\u2019re back online' : '\uD83C\uDFF7\uFE0F Barcode saved - next time it\u2019ll match straight away', 'good');
      return r;
    }).catch(oops);
  }
  var SCAN = { stream: null, timer: null, det: undefined, zx: null, opts: null, last: '', hits: 0 };
  var BC_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  function loadZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'lib/zxing.min.js?v4';
      s.onload = function () { if (window.ZXing) res(window.ZXing); else rej(new Error('zx')); };
      s.onerror = function () { rej(new Error('The barcode reader didn\u2019t load - check your signal and try again.')); };
      document.head.appendChild(s);
    });
  }
  function getDetector() {
    if (SCAN.det !== undefined) return Promise.resolve(SCAN.det);
    if (!('BarcodeDetector' in window)) { SCAN.det = false; return Promise.resolve(false); }
    return Promise.resolve(BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : BC_FORMATS).then(function (f) {
      var use = BC_FORMATS.filter(function (x) { return f.indexOf(x) >= 0; });
      SCAN.det = use.indexOf('ean_13') >= 0 ? new BarcodeDetector({ formats: use }) : false; return SCAN.det;
    }, function () { SCAN.det = false; return false; });
  }
  function zxReader(Z) {
    if (SCAN.zx) return SCAN.zx;
    var hints = new Map(), F = Z.BarcodeFormat;
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    var r = new Z.MultiFormatReader(); r.setHints(hints); SCAN.zx = r; return r;
  }
  function zxCanvas(Z, cv) {
    var r = zxReader(Z);
    try { return r.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText(); }
    catch (e) { return ''; } finally { try { r.reset(); } catch (e2) { /* ignore */ } }
  }
  /* Find a barcode in an image/canvas/video frame. Uses the phone's built-in reader when it has one, else ZXing. */
  function detectIn(source, w, h) {
    return getDetector().then(function (det) {
      if (det) return det.detect(source).then(function (r) { return r && r[0] ? r[0].rawValue : ''; }, function () { return ''; });
      return loadZXing().then(function (Z) {
        var cv = document.createElement('canvas'), sc = Math.min(1, 1280 / Math.max(w, h));
        cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
        cv.getContext('2d').drawImage(source, 0, 0, cv.width, cv.height);
        return zxCanvas(Z, cv);
      });
    });
  }
  function scanBox() {
    var box = $('scanBox');
    if (!box) {
      box = document.createElement('div'); box.id = 'scanBox'; box.className = 'scanBox'; box.hidden = true;
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Scan a barcode');
      box.innerHTML = '<video id="scanVideo" playsinline muted autoplay></video><div class="scanFrame"><span class="scanLine"></span></div>' +
        '<div class="scanTop"><b id="scanTitle">Point at the barcode</b><small id="scanMsg">Hold the box steady, about a hand\u2019s width away.</small></div>' +
        '<div class="scanBtns"><button class="btn" data-act="scanType">\u2328\uFE0F Type it</button><button class="btn" data-act="scanPhoto">\uD83D\uDDBC\uFE0F From a photo</button><button class="btn main" data-act="scanClose">\u2715 Close</button></div>' +
        '<input id="scanInput" type="file" accept="image/*" hidden>';
      document.body.appendChild(box);
      $('scanInput').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) scanFromFile(f); });
    }
    return box;
  }
  function openScanner(opts) {
    SCAN.opts = opts || {}; SCAN.last = ''; SCAN.hits = 0;
    var box = scanBox(); var wasOpen = !box.hidden; box.hidden = false; layerOpen(wasOpen);
    $('scanTitle').textContent = SCAN.opts.assign ? 'Scan the barcode for ' + SCAN.opts.assign.name : (SCAN.opts.add ? 'Scan the barcode for this new item' : (S.kid ? 'Scan a box!' : 'Point at the barcode'));
    $('scanMsg').textContent = 'Hold the box steady, about a hand\u2019s width away.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { scanNoCamera(); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(function (stream) {
      if (box.hidden) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      SCAN.stream = stream;
      var v = $('scanVideo'); v.srcObject = stream; var pl = v.play(); if (pl && pl.catch) pl.catch(noop);
      getDetector().then(function (det) { if (!det) return loadZXing(); }).catch(function (e) { $('scanMsg').textContent = e.message; });
      var busyFrame = false;
      SCAN.timer = setInterval(function () {
        if (busyFrame || !v.videoWidth) return;
        busyFrame = true;
        detectIn(v, v.videoWidth, v.videoHeight).then(function (code) {
          busyFrame = false;
          code = bcDigits(code) || String(code || '').trim();
          if (!code) return;
          if (!SCAN.det) { if (code !== SCAN.last) { SCAN.last = code; return; } }   // ZXing: wait for 2 matching reads
          gotCode(code);
        }, function () { busyFrame = false; });
      }, 220);
    }, function () { scanNoCamera(); });
  }
  function scanNoCamera() {
    $('scanTitle').textContent = 'The camera didn\u2019t open';
    $('scanMsg').textContent = 'Allow the camera for this app, or take a photo of the barcode, or type the numbers under it.';
  }
  function stopScanner() {
    clearInterval(SCAN.timer); SCAN.timer = null;
    if (SCAN.stream) { SCAN.stream.getTracks().forEach(function (t) { t.stop(); }); SCAN.stream = null; }
    var v = $('scanVideo'); if (v) v.srcObject = null;
    var box = $('scanBox'); if (box) box.hidden = true;
  }
  function gotCode(code) {
    if (!$('scanBox') || $('scanBox').hidden) return;
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { /* ignore */ }
    NAV.keep = true; stopScanner(); handleCode(code);
  }
  function scanFromFile(file) {
    $('scanMsg').textContent = 'Reading the photo\u2026';
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      detectIn(img, img.naturalWidth, img.naturalHeight).then(function (code) {
        URL.revokeObjectURL(url);
        if (code) gotCode(bcDigits(code) || code);
        else $('scanMsg').textContent = 'Couldn\u2019t spot a barcode in that photo. Get closer so the stripes fill the picture, or type the numbers.';
      }, function (e) { URL.revokeObjectURL(url); $('scanMsg').textContent = (e && e.message) || 'Couldn\u2019t read that photo.'; });
    };
    img.onerror = function () { URL.revokeObjectURL(url); $('scanMsg').textContent = 'Couldn\u2019t open that photo.'; };
    img.src = url;
  }
  function typeCode() {
    var opts = SCAN.opts || {};
    NAV.keep = true;
    stopScanner();
    sheet('\u2328\uFE0F Type the barcode', '<p class="hint">The numbers under the stripes (usually 12 or 13 of them).</p><input type="text" id="bcTyped" inputmode="numeric" autocomplete="off" placeholder="e.g. 5012345678900" style="font-size:22px;letter-spacing:1px">',
      [{ label: 'Check it', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]).then(function (v) {
      var code = bcDigits(($('bcTyped') || {}).value);
      if (v !== 'go') { if (opts.add && S.screen === 'add') go('add', {}, true); return; }
      if (code.length < 6) { toast('That needs to be the numbers under the barcode (8 to 14 of them).', 'oops'); return; }
      SCAN.opts = opts; handleCode(code);
    });
    setTimeout(function () { if ($('bcTyped')) $('bcTyped').focus(); }, 80);
  }
  function handleCode(code) {
    var opts = SCAN.opts || {}, digits = bcDigits(code);
    if (!digits) { layerDrop(); toast('That code isn\u2019t a product barcode (' + String(code).slice(0, 30) + ').', 'oops'); return; }
    if (opts.assign) { showAssignBarcode(digits, opts.assign); return; }
    if (opts.add) { layerDrop(); applyAddBarcode(digits); return; }
    var hits = itemsByBarcode(digits);
    var listHtml = function (list) {
      return '<div class="list">' + list.map(function (it) {
        return '<button class="li ownLi" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc([it.range, isOwned(it) ? '' : it.status].filter(Boolean).join(' \u00B7 ')) + '</small></div><span>\u203A</span></button>';
      }).join('') + '</div>';
    };
    if (hits.length) {
      var own = hits.filter(isOwned);
      var title = own.length ? (S.kid ? '\u2705 We\u2019ve got this one!' : '\u2705 You\u2019ve got it!') : '\u2B50 Not owned yet - it\u2019s ' + (hits[0].status || 'listed');
      sheet(title, '<p class="hint">Barcode ' + esc(digits) + '</p>' + listHtml(hits) + (own.length > 1 ? '<p class="hint">You\u2019ve got ' + own.length + ' with this barcode.</p>' : ''), [{ label: 'Done', value: true, cls: 'main' }, { label: '\uD83D\uDCF7 Scan another', value: 'again' }]).then(function (v) { if (v === 'again') openScanner({}); });
      setTimeout(watchThumbs, 50);
      return;
    }
    S.lastCode = digits;
    showUnknownBarcode(digits);
  }

  function bcLookCardHtml(digits, look) {
    var h = '<p class="hint">Barcode</p><div class="addBcCode">' + esc(digits) + '</div>';
    if (look === 'wait') return h + '<p class="hint" id="bcLookBox">Looking it up\u2026 name, brand and a reference picture if we can find them.</p>';
    if (look && look.name) {
      return h + '<div id="bcLookBox" class="addBcFound"><p><b>' + esc(look.name) + '</b>' +
        (look.brand ? '<br><small>' + esc(look.brand) + '</small>' : '') + '</p>' +
        (look.image ? '<img class="addBcRef" alt="Reference only, not our photo" src="' + esc(look.image) + '" onerror="this.remove()">' : '') +
        '<p class="hint">Reference only \u2014 this picture is not saved as our photo.</p></div>';
    }
    return h + '<p class="hint" id="bcLookBox">No name found for this barcode yet. You can still add it or save it for Dad.</p>';
  }
  function paintBcLookBox(digits, look) {
    var box = $('bcLookBox'); if (!box) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = bcLookCardHtml(digits, look);
    var next = wrap.querySelector('#bcLookBox') || wrap.firstChild;
    box.replaceWith(next);
  }
  function startLookForSheet(digits, cb) {
    lookupBarcode(digits).then(function (r) { paintBcLookBox(digits, r || null); if (cb) cb(r || null); }, function () { paintBcLookBox(digits, null); if (cb) cb(null); });
  }
  function startKidAddFromScan(info) {
    info = info || {};
    var look = info.look || null;
    S.add = {
      step: 1, shots: [], name: (look && look.name) || info.name || '', range: (look && look.range) || '',
      condition: '', more: { maker: (look && look.brand) || info.brand || '' },
      barcode: info.digits, bcLook: look || null, bcRef: (look && look.image) || ''
    };
    go('add');
  }
  function askDadForScan(why, after) {
    S.pinWhy = why;
    S.pinAfter = after || {};
    S.pinReturn = { screen: S.screen, params: S.params || {} };
    S.kidExit = false;
    askDadPin(PRIV);
  }
  function queueScanForDad(payload) {
    busy('Saving it for Dad\u2026');
    return call('queueScan', {
      barcode: payload.digits || payload.barcode,
      name: (payload.look && payload.look.name) || payload.name || '',
      brand: (payload.look && payload.look.brand) || payload.brand || '',
      image: (payload.look && payload.look.image) || payload.image || '',
      key: payload.key || '',
      item: payload.item || payload.name || '',
      kind: payload.kind || 'new'
    }, S.kid ? KID_ROLE : S.role).then(function (r) {
      done();
      toast('Saved for Dad \u2014 he\u2019ll see it on his Home.', 'good');
      return r;
    }, function (e) {
      done();
      if (/unknown action/i.test((e && e.message) || '')) {
        toast('This needs the latest sheet update (v4.7) before it can wait for Dad. Use \u201CDad, add it\u201D for now.', 'oops');
        return null;
      }
      oops(e);
      return null;
    });
  }
  function loadScanQueue() {
    return call('getScanQueue', S.role).then(function (r) { return r || { waiting: 0, pending: [] }; }, function (e) {
      if (/unknown action/i.test((e && e.message) || '')) return { waiting: 0, pending: [], unsupported: true };
      throw e;
    });
  }
  function paintScanQueueHome(r) {
    var n = (r && (r.waiting != null ? r.waiting : (r.pending ? r.pending.length : 0))) || 0;
    if (S.boot && typeof S.boot.scanQueue === 'number' && !(r && (r.waiting != null || r.pending))) n = S.boot.scanQueue;
    var box = $('homeScanQ');
    if (box) {
      if (!n) box.innerHTML = '';
      else box.innerHTML = '<div class="card yel tile" id="scanQTile"><div class="head">\uD83C\uDFF7\uFE0F Waiting for Dad</div><div class="big">' + n + '</div>' +
        '<div class="hint">scan' + (n === 1 ? '' : 's') + ' saved for you to add or dismiss.</div>' +
        '<button class="btn main" data-act="go" data-to="scanQueue">Review</button></div>';
    }
    if ($('dadInbox')) paintDadInbox(null, n);
  }
  function showUnknownBarcode(digits) {
    S.lastCode = digits;
    var lookState = 'wait';
    var body = function () {
      return bcLookCardHtml(digits, lookState) +
        (S.kid ? '' :
          '<div class="search" style="margin-top:10px"><input id="bcName" type="search" placeholder="\uD83D\uDD0D What is it? e.g. Bartman 503" autocomplete="off" style="font-size:20px"></div><div id="bcNameOut"></div>' +
          '<div class="stack" style="margin-top:10px"><a class="btn full" href="https://www.google.co.uk/search?q=' + encodeURIComponent(digits) + '" target="_blank" rel="noopener">\uD83D\uDD0E Look the barcode up on Google \u2197</a>' +
          '<button class="btn yel full" data-act="bcAddNew">\u2795 It\u2019s new - add it with this barcode</button></div>');
    };
    var buttons = S.kid
      ? [{ label: 'Dad, add it', value: 'dad', cls: 'main' }, { label: 'Save for Dad later', value: 'later' }, { label: '\uD83D\uDCF7 Scan another', value: 'again' }, { label: 'Close', value: '' }]
      : [{ label: '\uD83D\uDCF7 Scan another', value: 'again' }, { label: 'Close', value: false, cls: 'main' }];
    sheet(S.kid ? '\uD83E\uDD37 Not in our collection yet' : '\uD83E\uDD37 No match for that barcode yet',
      (S.kid ? '<p>This barcode isn\u2019t saved on anything we\u2019ve got yet.</p>' : '<p>This barcode isn\u2019t saved on any item yet. Most of the collection doesn\u2019t have barcodes saved, so <b>search by name</b> \u2014 if you\u2019ve got it, tap it to save the barcode and next time it\u2019ll match straight away.</p>') + body(),
      buttons).then(function (v) {
      var info = { digits: digits, look: S.lastLook || null, kind: 'new' };
      if (v === 'again') openScanner({});
      else if (v === 'dad') askDadForScan('bcAdd', info);
      else if (v === 'later') queueScanForDad(info);
    });
    if (!S.kid) {
      var inp = $('bcName'), t = null;
      if (inp) inp.addEventListener('input', function () {
        clearTimeout(t); t = setTimeout(function () {
          var res = fuzzyFind(inp.value, (S.items || []).filter(function (it) { return !neverShow(it.name); }), 6);
          $('bcNameOut').innerHTML = !inp.value.trim() ? '' : (res.length ? '<p class="hint">Tap the one it is to save the barcode on it:</p><div class="list">' + res.map(function (x) {
            return '<button class="li ownLi" data-act="bcAssign" data-key="' + esc(x.it.key) + '">' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) + '<small>' + esc([x.it.range, x.it.status].filter(Boolean).join(' \u00B7 ')) + '</small></div><span class="pill green">This one</span></button>';
          }).join('') + '</div>' : '<div class="nudge">\u274C Nothing in the collection matches that name.</div>');
          watchThumbs();
        }, 150);
      });
    }
    startLookForSheet(digits, function (r) { S.lastLook = r; });
  }
  function showAssignBarcode(digits, assign) {
    S.lastCode = digits;
    S.lastLook = null;
    var buttons = S.kid
      ? [{ label: 'Dad, save it', value: 'dad', cls: 'main' }, { label: 'Save for Dad later', value: 'later' }, { label: 'Cancel', value: '' }]
      : [{ label: 'Yes, save it', value: 'save', cls: 'main' }, { label: 'Cancel', value: '' }];
    sheet('\uD83C\uDFF7\uFE0F Scan barcode',
      '<p>Save this barcode onto <b>' + esc(assign.name) + '</b>? Next time you scan this box it\u2019ll match straight away.</p>' + bcLookCardHtml(digits, 'wait'),
      buttons).then(function (v) {
      var info = { digits: digits, look: S.lastLook || null, kind: 'assign', key: assign.key, item: assign.name, name: assign.name };
      if (v === 'save') saveBarcodeTo(assign.key, assign.name, digits).then(function () { if (S.screen === 'item' || S.screen === 'kidItem') go(S.screen, S.params, true); });
      else if (v === 'dad') askDadForScan('bcAssign', info);
      else if (v === 'later') queueScanForDad(info);
    });
    startLookForSheet(digits, function (r) { S.lastLook = r; });
  }
  function scanQAdd(id) {
    loadScanQueue().then(function (r) {
      var x = ((r && r.pending) || []).filter(function (q) { return q.id === id; })[0];
      if (!x) { toast('That one isn\u2019t waiting any more.', 'oops'); go('scanQueue', {}, true); return; }
      if (x.kind === 'assign' && x.key) {
        busy('Saving the barcode\u2026');
        return saveBarcodeTo(x.key, x.item || x.name, x.barcode).then(function () {
          return call('markScanAdded', id, S.role).catch(function (e) { if (!/unknown action/i.test((e && e.message) || '')) throw e; });
        }).then(function () { done(); go('item', { key: x.key }); }).catch(oops);
      }
      S.add = { step: 1, shots: [], name: x.name || '', range: '', condition: '', more: { maker: x.brand || '' }, barcode: x.barcode, bcLook: (x.name ? { name: x.name, brand: x.brand, image: x.image } : null), bcRef: x.image || '', scanQId: id };
      call('markScanAdded', id, S.role).catch(function (e) { if (!/unknown action/i.test((e && e.message) || '')) oops(e); }).then(function () { go('add'); });
    }).catch(oops);
  }
  function scanQDismiss(id) {
    confirmSheet('Dismiss this scan?', 'It will be marked dismissed and stay in the sheet. Nothing is deleted.', 'Yes, dismiss', 'Keep it').then(function (ok) {
      if (!ok) return;
      busy('Marking it dismissed\u2026');
      return call('dismissScan', id, S.role).then(function () { done(); toast('Dismissed \u2014 it is still in the sheet.', 'good'); go('scanQueue', {}, true); }, function (e) {
        done();
        if (/unknown action/i.test((e && e.message) || '')) toast('This needs the latest sheet update (v4.7).', 'oops');
        else oops(e);
      });
    });
  }


  /* ================= v4: collection value on Home (private) ================= */
  function monthKey(d) { d = d || new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function todayKey() { var d = new Date(); return monthKey(d) + '-' + ('0' + d.getDate()).slice(-2); }
  function localValueSummary() {
    var own = (S.items || []).filter(function (it) { return isOwned(it) && !it.pending; });
    var total = 0, valued = 0, upd = null, m = monthKey();
    own.forEach(function (it) { if (it.v != null) { total += +it.v; valued++; } if (it.vu !== undefined) { upd = upd || 0; if (String(it.vu).slice(0, 7) === m) upd++; } });
    total = Math.round(total * 100) / 100;
    var key = 'valsnap_' + m, snap = null;
    try { snap = JSON.parse(LS.get(key) || 'null'); } catch (e) { snap = null; }
    if (!snap) { snap = { total: total, date: todayKey() }; LS.set(key, JSON.stringify(snap)); }
    return { total: total, valued: valued, items: own.length, notValued: own.length - valued, updatedThisMonth: upd, monthStart: snap, change: Math.round((total - snap.total) * 100) / 100, local: true };
  }
  function shortDate(iso) { var p = String(iso || '').split('-'); if (p.length < 3) return iso || ''; return (+p[2]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(+p[1] || 1) - 1]; }
  function valueCardHtml(vs) {
    if (!vs) return '';
    var h = '<div class="card yel valueCard"><div class="head">\uD83D\uDD12 Collection value</div><div class="big">' + gbp(vs.total) + '</div>' +
      '<div class="hint"><b>' + vs.items + '</b> items owned \u00B7 ' + vs.valued + ' with a value' + (vs.notValued ? ' (' + vs.notValued + ' still to value)' : '') + '</div>';
    var ms = vs.monthStart;
    if (ms && ms.date && ms.date !== todayKey() && vs.change != null) {
      h += '<div class="vchg ' + (vs.change >= 0 ? 'up' : 'down') + '">' + (vs.change >= 0 ? '\u25B2 +' : '\u25BC ') + gbp(Math.abs(vs.change)).replace(/^/, vs.change < 0 ? '-' : '') + ' this month <small>(since ' + esc(shortDate(ms.date)) + ')</small></div>';
    } else {
      h += '<div class="hint">\uD83D\uDCC8 This month: tracking from ' + esc(shortDate((ms && ms.date) || todayKey())) + ' (the sheet has no older totals)</div>';
    }
    if (vs.updatedThisMonth != null) h += '<div class="hint">' + vs.updatedThisMonth + ' value' + (vs.updatedThisMonth === 1 ? '' : 's') + ' updated this month</div>';
    h += '<button class="btn small" data-act="go" data-to="value">See the value page</button></div>';
    return h;
  }

  /* ================= v4: Wanted deal alerts ================= */
  function dealCount() {
    if (S.homeWanted) return S.homeWanted.filter(function (w) { return w.deal && !neverShow(w.name); }).length;
    return (S.boot && S.boot.tiles && S.boot.tiles.wanted && S.boot.tiles.wanted.deals) || 0;
  }
  function refreshDealBadges() {
    var n = dealCount();
    var tb = document.querySelector('#tabbar [data-tab=wanted]');
    if (tb) { var b = tb.querySelector('.tbBadge'); if (n && !b) { b = document.createElement('span'); b.className = 'tbBadge'; tb.appendChild(b); } if (b) { if (n) b.textContent = n; else b.remove(); } }
    var hb = $('dealLine'); if (hb) hb.innerHTML = n ? '<span class="pill red">\uD83D\uDD25 ' + n + ' deal' + (n === 1 ? '' : 's') + ' under your max price</span>' : '';
  }
  function missingToWanted(rows) {
    return (rows || []).map(function (r) {
      return { kind: 'checklist', ref: r.tab + '|' + r.row, name: r.name, range: r.set || r.tab, series: r.number || '', year: r.year || '', conditionWanted: '', notes: '' };
    });
  }
  function mergeWantedAndMissing(wanted, missing) {
    var out = [], seen = {};
    (wanted || []).forEach(function (w) {
      out.push(w);
      var k = norm(w.name);
      if (k) seen[k] = out.length - 1;
    });
    missingToWanted(missing).forEach(function (w) {
      var k = norm(w.name);
      if (k && seen[k] !== undefined) {
        var cur = out[seen[k]];
        if (cur && !cur.year && w.year) cur.year = w.year;
        if (cur && !cur.series && w.series) cur.series = w.series;
        return;
      }
      if (k) seen[k] = out.length;
      out.push(w);
    });
    return out;
  }
  function loadHomeWanted() {
    var role = S.kid ? (THEME.roles.filter(function (r) { return r !== PRIV; })[0] || 'Son') : S.role;
    return Promise.all([
      call('getWanted', role).catch(function () { return []; }),
      call('getAllMissing').catch(function () { return []; })
    ]).then(function (res) {
      var list = mergeWantedAndMissing(res[0] || [], res[1] || []).filter(function (w) { return !neverShow(w.name); });
      S.homeWanted = list;
      refreshDealBadges();
      return list;
    }).catch(function () { return S.homeWanted || []; });
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
  var SHEET_OK = null;
  function finishSheet(value) {
    var sh = $('sheet'); if (sh) sh.hidden = true;
    var fn = SHEET_OK; SHEET_OK = null;
    if (fn) fn(value);
  }
  function sheet(title, bodyHtml, buttons) {
    return new Promise(function (resolve) {
      if (SHEET_OK) { var prev = SHEET_OK; SHEET_OK = null; prev(false); }
      SHEET_OK = resolve;
      var wasOpen = $('sheet') && !$('sheet').hidden;
      $('sheetTitle').textContent = title;
      $('sheetBody').innerHTML = bodyHtml || '';
      var bb = $('sheetButtons'); bb.innerHTML = '';
      (buttons || [{ label: 'OK', value: true, cls: 'main' }]).forEach(function (b) {
        var el = document.createElement('button');
        el.className = 'btn full ' + (b.cls || ''); el.textContent = b.label;
        el.addEventListener('click', function () {
          NAV.sheetValue = b.value;
          if (NAV.pushed > 0) layerBack(); else finishSheet(b.value);
        });
        bb.appendChild(el);
      });
      $('sheet').hidden = false;
      layerOpen(wasOpen);
    });
  }
  function confirmSheet(title, body, yes, no) {
    return sheet(title, '<p>' + body + '</p>', [{ label: yes || 'Yes', value: true, cls: 'main' }, { label: no || 'Not now', value: false }]);
  }

  /* Phone Back (Android): close the top overlay or step; don't leave the app. */
  var NAV = { pushed: 0, keep: false, skip: false, sheetValue: undefined, tourFinished: false };
  function layerPush() {
    try { history.pushState({ fs: 1, t: Date.now() }, ''); NAV.pushed++; } catch (e) { /* ignore */ }
  }
  function layerOpen(wasOpen) {
    if (NAV.keep) { NAV.keep = false; return; }
    if (!wasOpen) layerPush();
  }
  function layerBack() {
    if (NAV.pushed > 0) { try { history.back(); } catch (e) { dismissTop(); } }
    else dismissTop();
  }
  function layerDrop() {
    if (NAV.keep) NAV.keep = false;
    if (NAV.pushed <= 0) return;
    NAV.skip = true; NAV.pushed--;
    try { history.back(); } catch (e) { NAV.skip = false; }
  }
  function overlayOpen(id) { var el = $(id); return !!(el && !el.hidden); }
  function dismissTop() {
    var box = $('scanBox');
    if (box && !box.hidden) { stopScanner(); return true; }
    if (overlayOpen('sheet')) {
      var v = NAV.sheetValue; NAV.sheetValue = undefined;
      finishSheet(v !== undefined ? v : false);
      return true;
    }
    if (overlayOpen('lightbox')) { $('lightbox').hidden = true; return true; }
    if (overlayOpen('dadNote')) { hideDadNote(); return true; }
    if (overlayOpen('dadLetter')) { hideDadLetter(); return true; }
    var tour = $('tour');
    if (tour && !tour.hidden) { var done = !!NAV.tourFinished; NAV.tourFinished = false; closeTour(done); return true; }
    if (S.screen === 'add' && S.add && S.add.step > 1) {
      keepAddName();
      S.add.step = Math.max(1, S.add.step - 1);
      go('add', {}, true);
      return true;
    }
    if (S.history && S.history.length) { back(); return true; }
    if (S.screen === 'add') { go(S.kid ? 'kid' : 'home', {}, true); return true; }
    return false;
  }
  window.addEventListener('popstate', function () {
    if (NAV.skip) { NAV.skip = false; return; }
    if (NAV.pushed > 0) NAV.pushed--;
    dismissTop();
  });

  /* ---------------- navigation ---------------- */
  var TABS = function () {
    if (S.kid) return [['kid', '\uD83C\uDFE0', 'Home'], ['kidStuff', '\uD83E\uDDF8', 'Our stuff'], ['kidHunt', '\u2B50', 'Hunt'], ['kidBadges', '\uD83C\uDFC6', 'Badges'], ['scan', '\uD83D\uDCF7', 'Scan']];
    return [['home', '\uD83C\uDFE0', 'Home'], ['collection', '\uD83D\uDDC2\uFE0F', 'Collection'], ['add', '\u2795', 'Add'], ['wanted', '\u2B50', 'Wanted'], ['more', '\u2630', 'More']];
  };
  function renderTabs() {
    var nav = $('tabbar');
    nav.hidden = !S.role;
    nav.innerHTML = TABS().map(function (t) {
      var cur = S.screen === t[0] || (t[0] === 'collection' && (S.screen === 'item' || S.screen === 'edit')) ||
        (t[0] === 'more' && MORE_SCREENS.indexOf(S.screen) >= 0) || (t[0] === 'wanted' && (S.screen === 'checklists' || S.screen === 'checklist' || S.screen === 'missing'));
      var dn = t[0] === 'wanted' ? dealCount() : 0;
      return '<button data-tab="' + t[0] + '"' + (cur ? ' aria-current="page"' : '') + '><span class="ic">' + t[1] + '</span>' + t[2] + (dn ? '<span class="tbBadge">' + dn + '</span>' : '') + '</button>';
    }).join('');
    $('whoBadge').textContent = S.kid ? KID_ROLE + '\u2019s mode' : (S.role ? 'Hi ' + S.role + ' \u00B7 tap to switch' : THEME.tagline);
  }
  var MORE_SCREENS = ['more', 'stats', 'posted', 'spares', 'swaps', 'wheel', 'history', 'export', 'help', 'settings', 'value', 'photos', 'novalue', 'checklists', 'rewards', 'scanQueue'];
  function go(screen, params, noHistory) {
    closeTour(); if ($('lightbox')) $('lightbox').hidden = true;
    if (S.kid) { if (screen === 'item') screen = 'kidItem'; else if (KID_SCREENS.indexOf(screen) < 0) { screen = 'kid'; params = {}; } }
    if (!noHistory && S.screen && S.screen !== screen) { S.history.push([S.screen, S.params]); layerPush(); }
    if (S.history.length > 30) S.history.shift();
    S.screen = screen; S.params = params || {};
    document.body.classList.toggle('isDadHome', !S.kid && screen === 'home' && S.role === PRIV);
    document.body.classList.toggle('isKidHome', !!S.kid);
    renderTabs();
    var fn = SCREENS[screen] || SCREENS.home;
    window.scrollTo(0, 0);
    fn(S.params);
    $('main').focus({ preventScroll: true });
  }
  function back() {
    var prev = S.history.pop();
    if (prev) go(prev[0], prev[1], true); else go(S.kid ? 'kid' : 'home', {}, true);
  }
  function setMain(html) { $('main').innerHTML = netBarHtml() + html + '<p class="foot">' + esc(THEME.footer) + '</p>'; }
  function backBtn() { return '<button class="btn small" data-act="back">\u2190 Back</button>'; }

  /* ---------------- data ---------------- */
  function loadBoot(force) {
    if (S.boot && !force) return Promise.resolve(S.boot);
    busy('Getting the collection\u2026');
    warmThumbs();
    return call('getBootstrap', S.kid ? KID_ROLE : S.role).then(function (b) {
      var privNow = isPriv() && !S.kid;
      b.items = (b.items || []).filter(function (it) { return !neverShow(it.name) && (privNow || !sonHidden(it.name)); });
      if (S.kid) b.items = filterKidPayload(b.items);
      S.boot = b; S.items = b.items;
      prefetchThumbs(S.kid ? b.items.filter(function (it) { return isOwned(it) && kidVisible(it); }) : b.items);
      return IDB.qAll().then(function (q) { NET.queueLen = q.length; q.forEach(applyQueued); }, noop).then(function () {
        if (S.kid) { S.items = filterKidPayload(S.items || []); if (S.boot) S.boot.items = S.items; }
        done(); renderNetBar(); return b;
      });
    });
  }
  function itemByKey(key) { for (var i = 0; i < S.items.length; i++) if (S.items[i].key === key) return S.items[i]; return null; }

  /* ================= v5 thumbnails: small, cached on the phone, retried, tap to retry =================
     Drive's thumbnails arrive at ~1280x1600 (~366 KB each as text). Each one is shrunk on the phone to a 320px
     square JPEG (~15-25 KB), kept in its own IndexedDB entry, and (with Apps Script v4.2) handed back to the
     server once so every later load is small. Only cards on screen are fetched, newest-visible first, a few
     at a time, with a time limit and automatic retries; anything that still fails shows "Tap to retry". */
  var TH = { at: {}, done: {}, fail: {}, busy: {}, queue: [], running: 0, small: null, timer: null, kind: {}, pre: {}, bad: {}, autoAt: {}, autoN: {} };
  var TH_MAX_TRIES = 3, TH_PARALLEL = 3, TH_TIMEOUT = 45000, TH_STALE = 3 * 864e5;
  function thumbInner(fid) {
    var t = S.thumbs[fid];
    if (typeof t === 'string') return '<img alt="" decoding="async" src="' + t + '">';
    if (t === null) return noPhotoHtml(TH.kind[fid] === 'video');
    if ((TH.fail[fid] || 0) >= TH_MAX_TRIES) return '<span class="thRetry" data-act="thumbRetry" data-fid2="' + esc(fid) + '" role="button" aria-label="Photo didn\u2019t load. Tap to try again">\u21BB<small>Tap to retry</small></span>';
    return '<span class="thWait" aria-label="Loading photo"></span>';
  }
  /* v7: a card with no picture says why, so it never looks like a photo that failed to load */
  function noPhotoHtml(video) {
    return video ? '<span class="thNone" aria-label="Only a video so far">\uD83C\uDFAC<small>Video only</small></span>'
      : '<span class="thNone" aria-label="No photo yet">\uD83D\uDCF7<small>No photo yet</small></span>';
  }
  /* v7l: local reference pictures for items with no Drive folder. Real photos always win. */
  var STANDIN_IDS = {"FS-0066":1, "FS-0098":1, "FS-0124":1, "FS-0276":1, "FS-0304":1, "FS-0312":1, "FS-0412":1, "FS-0415":1, "FS-0417":1, "FS-0418":1, "FS-0423":1, "FS-0424":1};
  var WANT_REF_IDS = {"jakks-pacific__2-5in-playset__simpsons-living-room-diorama-with-homer":1, "jakks-pacific__2-5in-wave-1__bart":1, "jakks-pacific__2-5in-wave-1__homer":1, "jakks-pacific__2-5in-wave-1__lisa":1, "jakks-pacific__2-5in-wave-2__itchy":1, "jakks-pacific__2-5in-wave-2__scratchy":1, "jakks-pacific__2-5in-wave-3__grampa":1, "jakks-pacific__2-5in-wave-3__milhouse":1, "jakks-pacific__2-5in-wave-3__ralph":1, "jakks-pacific__2-5in-wave-4__principal-skinner":1, "jakks-pacific__2-5in-wave-4__selma-bouvier":1, "jakks-pacific__5in-premium-treehouse-of-horror__fly-boy-bart":1, "jakks-pacific__5in-premium-treehouse-of-horror__grim-reaper-homer":1, "jakks-pacific__5in-premium-treehouse-of-horror__king-homer":1, "jakks-pacific__5in-premium-treehouse-of-horror__vampire-krusty":1, "jakks-pacific__5in-premium-treehouse-of-horror__werewolf-ned-flanders":1, "jakks-pacific__5in-premium__fat-tony":1, "jakks-pacific__5in-premium__king-size-homer":1, "jakks-pacific__5in-premium__the-chosen-one-homer":1, "jakks-pacific__5in-wave-3__homer-at-the-bat":1, "jakks-pacific__5in-wave-3__marge-with-maggie":1, "jakks-pacific__5in-wave-3__milhouse-with-bicycle":1, "jakks-pacific__5in-wave-4__bart-with-skateboard-blue-shirt":1, "jakks-pacific__5in-wave-5__bart-hockey":1, "jakks-pacific__5in-wave-5__troy-mcclure":1, "lego__41632__brickheadz-homer-simpson-krusty-the-clown":1, "lego__71016__kwik-e-mart":1, "lego__71202__lego-dimensions-level-pack-the-simpsons-homer":1, "lego__71211__lego-dimensions-fun-pack-bart":1, "lego__71227__lego-dimensions-fun-pack-krusty":1};
  function standinUrl(it) {
    var id = it && it.id;
    if (!id || !STANDIN_IDS[id] || it.folderId) return '';
    return 'assets/standins/' + id + '.webp';
  }
  function filmBadgeHtml() {
    return '<span class="filmBadge" title="Still needs a real photo"><img src="assets/simpsons/donut.webp" alt="">D\u2019oh! Still to film</span>';
  }
  function standinBlock(it, cls, extraAttr) {
    var src = standinUrl(it);
    if (!src) return '';
    return '<div class="' + cls + ' isStandin"' + (extraAttr || '') + '><img class="standinImg" alt="" src="' + esc(src) + '">' + filmBadgeHtml() + '</div>';
  }
  function thumbHtml(it) {
    if (it.folderId) return '<div class="thumb" data-fid="' + esc(it.folderId) + '">' + thumbInner(it.folderId) + '</div>';
    var s = standinBlock(it, 'thumb');
    if (s) return s;
    return '<div class="thumb" data-nothumb>' + noPhotoHtml(false) + '</div>';
  }
  function paintThumb(fid) {
    document.querySelectorAll('[data-fid="' + fid + '"]').forEach(function (el) { el.innerHTML = thumbInner(fid); });
  }
  function thumbNeeded(fid) {
    if (!fid || TH.busy[fid] || TH.queue.indexOf(fid) >= 0) return false;
    if ((TH.fail[fid] || 0) >= TH_MAX_TRIES) return false;
    var t = S.thumbs[fid];
    if (t === null) return false;
    if (typeof t === 'string') return !TH.done[fid] && Date.now() - (TH.at[fid] || 0) > TH_STALE;   // quiet re-check
    return true;
  }
  function queueThumb(fid) {
    if (!thumbNeeded(fid)) return;
    TH.queue.push(fid);
    clearTimeout(TH.timer); TH.timer = setTimeout(pumpThumbs, 120);
  }
  var observer = null;
  function onScreen(el, pad) { var r = el.getBoundingClientRect(); return r.bottom > -pad && r.top < innerHeight + pad && r.width > 0; }
  function watchThumbs() {
    var els = document.querySelectorAll('[data-fid]');
    if (!('IntersectionObserver' in window)) { els.forEach(function (el) { if (onScreen(el, 600)) queueThumb(el.getAttribute('data-fid')); }); return; }
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) queueThumb(en.target.getAttribute('data-fid')); });
    }, { rootMargin: '400px 0px' });
    els.forEach(function (el) { observer.observe(el); });
    sweepThumbs(); setTimeout(sweepThumbs, 700);    // v7: cards already on screen are asked for even if the observer is late
  }
  /* safety net: after scrolling stops, anything on screen that still needs a photo is asked for */
  var thScrollT = null;
  function sweepThumbs() { document.querySelectorAll('[data-fid]').forEach(function (el) { if (onScreen(el, 400)) queueThumb(el.getAttribute('data-fid')); }); }
  window.addEventListener('scroll', function () { clearTimeout(thScrollT); thScrollT = setTimeout(sweepThumbs, 250); }, { passive: true });
  function pickThumbBatch(n) {
    var vis = [], near = [];
    TH.queue.forEach(function (fid) {
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (!el) { if (TH.pre[fid]) near.push(fid); return; }   // not on the page: only first-screen pre-fetches go ahead
      (onScreen(el, 50) ? vis : near).push(fid);
    });
    var all = vis.concat(near);
    TH.queue = all.slice(n);
    return all.slice(0, n);
  }
  function pumpThumbs() {
    if (navigator.onLine === false) return;
    while (TH.running < TH_PARALLEL && TH.queue.length) {
      var batch = pickThumbBatch(TH.small === false ? 4 : 10);
      if (!batch.length) break;
      runThumbBatch(batch);
    }
  }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { var e = new Error('timeout'); e.timeout = true; rej(e); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function fetchThumbs(batch) {
    /* straight to the API (not call()), so a slow photo never flips the whole app into "No signal" */
    var old = function () { return rawCall('getThumbs', [batch, tokenNow()]).then(function (m) { return { thumbs: m || {}, big: {}, old: true }; }); };
    if (TH.small === false) return old();
    return rawCall('getThumbsSmall', [batch, tokenNow()]).then(function (r) {
      if (!r || typeof r !== 'object' || !r.thumbs) throw new Error('bad reply');
      TH.small = true; return r;
    }, function (e) {
      if (/unknown action/i.test((e && e.message) || '')) { TH.small = false; return old(); }   // Apps Script not updated yet
      throw e;
    });
  }
  function runThumbBatch(batch) {
    TH.running++;
    batch.forEach(function (f) { TH.busy[f] = 1; });
    withTimeout(fetchThumbs(batch), TH_TIMEOUT).then(function (r) {
      setTimeout(autoRetryThumbs, 0);   // the line works again: give failed photos on screen one more go
      return Promise.all(batch.map(function (fid) {
        if (!Object.prototype.hasOwnProperty.call(r.thumbs, fid)) { delete TH.busy[fid]; TH.queue.push(fid); return null; }  // server ran out of time: ask again
        var v = r.thumbs[fid], kind = r.kinds && r.kinds[fid];
        delete TH.pre[fid];
        if (!v && kind === 'error') { delete TH.busy[fid]; thumbFailed(fid); return null; }   // Drive hiccup: try again
        if (!v) {
          delete TH.busy[fid]; TH.done[fid] = 1; TH.kind[fid] = kind || '';
          if (typeof S.thumbs[fid] !== 'string') { S.thumbs[fid] = null; paintThumb(fid); }
          return null;
        }
        return shrinkThumb(v).then(function (small) {
          delete TH.busy[fid];
          if (!small) { TH.bad[fid] = (TH.bad[fid] || 0) + 1; thumbFailed(fid); return; }
          S.thumbs[fid] = small; TH.at[fid] = Date.now(); TH.done[fid] = 1; delete TH.fail[fid];
          IDB.tSet(fid, { d: small, at: TH.at[fid] }).catch(noop);
          paintThumb(fid);
          if (r.big && r.big[fid] && small !== v && small.length < 88000) rawCall('putThumbSmall', [fid, r.big[fid], small, '']).catch(noop);
        });
      }));
    }, function (e) {
      batch.forEach(function (fid) { delete TH.busy[fid]; thumbFailed(fid, navigator.onLine === false); });
    }).then(function () {
      TH.running--; pumpThumbs();
    }, function () { TH.running--; pumpThumbs(); });
  }
  function thumbFailed(fid, offline) {
    if (typeof S.thumbs[fid] === 'string') { TH.done[fid] = 1; return; }      // keep the saved one
    if (!offline) TH.fail[fid] = (TH.fail[fid] || 0) + 1;
    if (offline || (TH.fail[fid] || 0) >= TH_MAX_TRIES) { if (offline) TH.fail[fid] = TH_MAX_TRIES; paintThumb(fid); return; }
    setTimeout(function () { queueThumb(fid); }, 1500 * TH.fail[fid]);       // try again shortly
  }
  /* v7: never give up on a photo that's on screen - try again every so often (20 s, 40 s, ... up to 3 min) */
  function autoRetryThumbs(now) {
    var t = Date.now();
    Object.keys(TH.fail).forEach(function (fid) {
      if (TH.fail[fid] < TH_MAX_TRIES) return;
      if (!now && t < (TH.autoAt[fid] || 0)) return;
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (!el || !onScreen(el, 400)) return;
      TH.autoN[fid] = (TH.autoN[fid] || 0) + 1;
      TH.autoAt[fid] = t + Math.min(180000, 20000 * TH.autoN[fid]);
      retryThumb(fid);
    });
  }
  function thumbsWakeUp() {          // back to the app, or signal back: re-check the screen straight away
    if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
    TH.autoAt = {}; autoRetryThumbs(true); sweepThumbs(); pumpThumbs();
  }
  document.addEventListener('visibilitychange', thumbsWakeUp);
  window.addEventListener('pageshow', thumbsWakeUp);
  setInterval(function () { if (document.visibilityState !== 'hidden' && navigator.onLine !== false) { autoRetryThumbs(); sweepThumbs(); } }, 20000);
  /* a saved thumbnail that the phone can't draw (empty or broken) is thrown away and fetched again */
  document.addEventListener('error', function (e) {
    var im = e.target; if (!im || im.tagName !== 'IMG' || !im.closest) return;
    var box = im.closest('[data-fid]'); if (!box) return;
    var fid = box.getAttribute('data-fid');
    if ((TH.bad[fid] = (TH.bad[fid] || 0) + 1) > 2) return;
    forgetThumb(fid); paintThumb(fid); queueThumb(fid);
  }, true);
  /* first screen: fetch the newest items' photos as soon as the list arrives, before they're even drawn */
  function prefetchThumbs(items) {
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    (items || []).slice().sort(function (a, b) { return idn(b) - idn(a) || b.row - a.row; }).filter(function (it) { return it.folderId; }).slice(0, 12)
      .forEach(function (it) { if (thumbNeeded(it.folderId)) { TH.pre[it.folderId] = 1; queueThumb(it.folderId); } });
  }
  var thWarm = false;
  function warmThumbs() {              // wakes Apps Script up while the list is loading, so the first batch isn't the slow one
    if (thWarm || navigator.onLine === false) return; thWarm = true;
    rawCall('getThumbsSmall', [[], '']).catch(function () { thWarm = false; });
  }
  function retryThumb(fid) { delete TH.fail[fid]; delete TH.done[fid]; paintThumb(fid); queueThumb(fid); }
  window.addEventListener('online', function () {
    Object.keys(TH.fail).forEach(function (fid) { if (TH.fail[fid] >= TH_MAX_TRIES && document.querySelector('[data-fid="' + fid + '"]')) retryThumb(fid); });
    thumbsWakeUp();
  });
  /* shrink a big thumbnail to a 320px square JPEG (what the card shows anyway) */
  function shrinkThumb(src) {
    return new Promise(function (res) {
      if (src.length < 60000) return res(src);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(w, h);
          if (!s) return res(null);
          var out = Math.min(320, s), c = document.createElement('canvas'); c.width = c.height = out;
          c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, out, out);
          var d = c.toDataURL('image/jpeg', 0.75);
          res(/^data:image\/jpeg/.test(d) && d.length < src.length ? d : src);
        } catch (e) { res(src); }
      };
      img.onerror = function () { res(null); };
      img.src = src;
    });
  }
  /* kept on the phone (one entry per item), so photos show straight away and with no signal */
  function goodThumb(d) { return typeof d === 'string' && d.length > 300 && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/]{100}/.test(d); }
  function loadSavedThumbs() {
    return IDB.tAll().then(function (m) {
      Object.keys(m || {}).forEach(function (k) {
        var v = m[k];
        if (!v || !goodThumb(v.d)) { IDB.tDel(k).catch(noop); return; }   // v7: empty or broken - fetch it again
        if (typeof S.thumbs[k] !== 'string') { S.thumbs[k] = v.d; TH.at[k] = v.at || 0; paintThumb(k); }
      });
      migrateOldThumbs();
    }).catch(noop);
  }
  /* v4 kept every big thumbnail in one huge entry; shrink them into the new store once, then drop it */
  function migrateOldThumbs() {
    IDB.get('thumbs').then(function (old) {
      if (!old) return;
      var keys = Object.keys(old), i = 0;
      var next = function () {
        if (i >= keys.length) { old = null; return IDB.del('thumbs').catch(noop); }
        var k = keys[i++], v = old[k];
        if (!goodThumb(v) || typeof S.thumbs[k] === 'string') return next();
        return shrinkThumb(v).then(function (small) {
          if (goodThumb(small) && typeof S.thumbs[k] !== 'string') { S.thumbs[k] = small; TH.at[k] = 0; paintThumb(k); return IDB.tSet(k, { d: small, at: 0 }).catch(noop); }
        }).then(function () { return new Promise(function (r) { setTimeout(r, 30); }); }).then(next);
      };
      return next();
    }).catch(noop);
  }
  function forgetThumb(fid) {
    if (!fid) return;
    delete S.thumbs[fid]; delete TH.at[fid]; delete TH.done[fid]; delete TH.fail[fid]; delete TH.kind[fid];
    IDB.tDel(fid).catch(noop);
  }
  /* Refresh: keep showing what we have, but quietly re-check each photo as it comes on screen */
  function thumbsRefresh() {
    TH.done = {}; TH.fail = {}; TH.at = {}; TH.autoAt = {}; TH.autoN = {}; TH.bad = {}; TH.kind = {};
    Object.keys(S.thumbs).forEach(function (k) { if (typeof S.thumbs[k] !== 'string') delete S.thumbs[k]; });
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
    if (!mode) {   // every "Take photo" asks: camera or gallery
      return sheet('\uD83D\uDCF7 Add a photo', '<p class="hint">Snap it now, or pick one you already took.</p>', [
        { label: '\uD83D\uDCF7 Take photo (camera)', value: 'camera', cls: 'main' },
        { label: '\uD83D\uDDBC\uFE0F Choose from gallery', value: 'gallery' },
        { label: 'Cancel', value: '' }
      ]).then(function (v) { if (v) openInput(target, v === 'camera' ? 'camera' : 'gallery'); });
    }
    openInput(target, mode);
  }
  function openInput(target, mode) {
    S.camTarget = target;
    var inp = mode === 'video' ? $('vidInput') : mode === 'camera' ? $('camInput') : $('pickInput');
    inp.value = '';
    inp.click();
  }
  function onFiles(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    var target = S.camTarget; S.camTarget = null;
    if (!files.length || !target) return;
    if (target.mode === 'add') { addShots(files); return; }
    var n = 0, names = [], pending = 0;
    busy('Saving to the item\u2019s folder\u2026');
    files.reduce(function (p, f) {
      return p.then(function () { return prepareFile(f); }).then(function (pf) {
        return call('uploadMedia', target.key, target.name, pf.mime, pf.b64, target.makeMain ? 'Main' : 'auto', !!target.makeMain && n === 0);
      }).then(function (r) { n++; names.push(r.fileName); if (r.pending) pending++; if (r.folderId && !r.pending) updateFolder(target.key, r.folderId); });
    }, Promise.resolve()).then(function () {
      done();
      if (S.kid) bumpKid('kidPhotos', n);
      if (pending) toast(n === 1 ? 'Nice one! Dad will have a look, then you get 10 points.' : 'Nice one! Dad will have a look at the photos.', 'good');
      else {
        toast(target.makeMain ? '\u2B50 New main photo saved. The old one is still in the folder.' : '\uD83C\uDF89 Saved ' + (n === 1 ? names[0] : n + ' files') + '. Nice one!', 'good');
        var it = itemByKey(target.key); if (it && it.folderId) forgetThumb(it.folderId);
        if (S.boot && S.boot.tiles && S.boot.tiles.photos.next && S.boot.tiles.photos.next.key === target.key) S.boot = null;
      }
      if (S.screen === 'item' || S.screen === 'kidItem') go(S.screen, S.params, true);
      else if (S.screen === 'photos' || S.screen === 'home' || S.screen === 'kid' || S.screen === 'kidStuff') { S.boot = null; go(S.screen, S.params, true); }
    }).catch(function (e) { oops(e); if (n) toast('Saved ' + n + ', but one didn\u2019t go. Try that one again from the item page.', 'oops'); });
  }
  function updateFolder(key, fid) { var it = itemByKey(key); if (it) it.folderId = fid; }
  function pointsNote(r, msg) {
    var pts = r && r.points, bit = pts > 0 ? ('+' + pts + ' point' + (pts === 1 ? '' : 's') + '!') : '';
    if (msg && bit) toast(msg + ' ' + bit, 'good');
    else if (bit) toast(bit, 'good');
    else if (msg) toast(msg, 'good');
    return pts > 0;
  }

  /* ---------------- help text ---------------- */
  var HELP = {
    home: ['This is your to-do board.', '\u201CDo I own it?\u201D at the top: type any name and it tells you straight away. Or tap \uD83D\uDCF7 Scan and point at a box\u2019s barcode.', 'Each box has one button that sorts that job out. Start with whichever has the biggest number.', 'No signal? The app shows the copy saved on the phone and syncs your changes later.'],
    collection: ['Everything you own, with the newest photo of each.', 'Type in the search box or use the three filters (range, status, condition).', 'Tap any picture to open it.'],
    item: ['This is one item.', 'Tap \u201CAdd photo / video\u201D to use the camera - it saves straight into the item\u2019s own Drive folder.', 'Tap a photo to see it big, or make it the main photo. Videos play here in the app (Open in Drive is still there if you need it).',
    'Tap Scan barcode to link a box\u2019s number. You\u2019ll see the looked-up name before it is saved.', 'Tap \u201CEdit details\u201D to fix the name, category, condition and so on.', 'Tap a platform under \u201CPosted on\u201D once it\u2019s been posted.'],
    edit: ['Change anything, then tap Save.', 'Year is just the 4 numbers, like 1999. Anything else goes in Year note.', 'Nothing gets deleted from here - the worst that can happen is a typo you can fix.'],
    add: ['Four quick steps: photo, name, range, condition.', 'On the name step you can scan or type the barcode so it\u2019s saved with the new item.', 'If we find a match we\u2019ll fill the name, maker and range for you to check. A catalogue picture is a reference only — it is never saved as our photo.', 'Everything else is optional - you can add it later.', 'If it looks like you already have it, I\u2019ll ask before adding a second one.'],
    wanted: ['Things you\u2019re hunting for.', 'Got one? Tap \u201CGot it\u201D and it moves into the collection (I\u2019ll check first).'],
    checklists: ['How close you are to each full set.', 'Tap a set to see what\u2019s missing.'],
    checklist: ['Green = got it. The rest are still missing.', 'Tap \u201CGot it\u201D to tick one off - I\u2019ll check first.'],
    value: ['Private: only for ' + PRIV + '.', 'Totals, top 10 and paid vs value. These are estimates, mostly from sold prices.'],
    photos: ['Items that still need our own photos.', 'Tap \u201CTake photo\u201D and it goes straight into that item\u2019s folder.', 'Remember: no faces or people in shot.'],
    novalue: ['Items without a value yet.', 'Tap \u201CAdd value\u201D to type your best guess.'],
    settings: ['Switch between ' + THEME.roles.join(' and ') + ', take the tour again, or open the sheet and Drive folders.'],
    rewards: ['Son\u2019s points and rewards live here.', 'Photos he adds wait for you to say yes (that\u2019s when the 10 points land). Nothing is deleted if you say no.', 'Approve a reward with your PIN each time. You can add or switch off rewards; money words are not allowed.'],
    kidRewards: ['You earn points for photos (once Dad says yes), ticking things off, and new finds.', 'Ask Dad for a reward when you have enough points. Hidden or secret things never earn points, and there are never prices here.'],
    more: ['Everything else lives here: stats, posted on socials, spares, the missing list, export and help.', 'Tap any big button.'],
    stats: ['Totals and charts for the whole collection.', 'Money only shows for ' + PRIV + '.'],
    posted: ['What\u2019s been posted on socials, and what hasn\u2019t yet.', 'Tap an item, then tap a platform button to tick it.'],
    spares: ['Things you have more than one of.', 'Tap \u201CMark for sale\u201D on the copy you\u2019d sell. Nothing is deleted.'],
    history: ['When each thing joined the collection, newest first.', 'Items with no date are at the bottom.'],
    missing: ['Everything still needed from every full-set checklist.', 'Search, or pick one checklist. Tap \u201CGot it\u201D to tick one off.'],
    export: ['Save a list into Drive as a spreadsheet file (CSV) or a PDF.', 'Filter in Collection first to export just some items.'],
    help: ['All the help topics are on this page.', 'Tap a topic to open it, or take the tour.'],
    kid: ['Big buttons and photos, and never any prices.', 'On this day and set progress show on Home when there is something to see. Spin the wheel picks something to film next. Doubles to swap lists spare copies, with photos and no prices.'],
    swaps: ['Things we own more than once, with photos and no prices.', 'Tap a photo to open that copy. Dad can still mark things for sale on Spares & duplicates.'],
    wheel: ['Spin to pick something we already own to film next.', 'It prefers items that have not been posted yet. Tap the result to open that item.']
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
      if (v === 'refresh') { S.boot = null; thumbsRefresh(); go(S.screen || 'home', S.params, true); }
      if (v === 'guide') go('guide', { i: 0 });
      if (v === 'tour') { LS.set('tourPending', '1'); go('home', {}, true); }
      if (v === 'help') go('help');
      if (v === 'who') go('who');
    });
  }

  /* ---------------- screens ---------------- */
  var SCREENS = {};

  SCREENS.scanQueue = function () {
    if (S.kid) { go('kid', {}, true); return; }
    busy('Opening the scan queue\u2026');
    loadScanQueue().then(function (r) {
      done();
      if (r.unsupported) {
        setMain(backBtn() + '<h1>\uD83C\uDFF7\uFE0F Scan queue</h1><div class="nudge">This needs the latest Apps Script (v4.7) pasted into the sheet. Until then, nothing is waiting here.</div>');
        return;
      }
      var list = r.pending || [];
      var h = backBtn() + '<h1>\uD83C\uDFF7\uFE0F Scan queue</h1><p class="hint">Things ' + esc(KID_ROLE) + ' saved for you. Add one, or dismiss it (it stays in the sheet, marked dismissed \u2014 nothing is deleted).</p>';
      if (!list.length) h += '<div class="nudge">Nothing waiting just now.</div>';
      h += list.map(function (x) {
        return '<div class="card scanQItem"><div class="addBcCode">' + esc(x.barcode) + '</div>' +
          (x.image ? '<img class="addBcRef" alt="" src="' + esc(x.image) + '" onerror="this.remove()">' : '') +
          '<p><b>' + esc(x.name || 'No name found yet') + '</b>' + (x.brand ? '<br><small>' + esc(x.brand) + '</small>' : '') + '</p>' +
          '<p class="hint">' + (x.kind === 'assign' ? 'Save onto ' + esc(x.item || x.key) : 'New item to add') + (x.day ? ' \u00B7 ' + esc(x.day) : '') + '</p>' +
          '<div class="row"><button class="btn main" data-act="scanQAdd" data-id="' + esc(x.id) + '">' + (x.kind === 'assign' ? 'Save on item' : 'Add it') + '</button>' +
          '<button class="btn" data-act="scanQDismiss" data-id="' + esc(x.id) + '">Dismiss</button></div></div>';
      }).join('');
      setMain(h);
    }).catch(oops);
  }


  /* ================= v4: Son's mode (big tiles, photos, no money, nothing Christmassy) ================= */
  var KID_ROLE = THEME.roles.filter(function (r) { return r !== PRIV; })[0] || 'Son';
  var KID_SCREENS = ['kid', 'kidStuff', 'kidItem', 'kidHunt', 'kidBadges', 'kidRewards', 'kidNotes', 'pin', 'add', 'swaps', 'wheel', 'checklists', 'checklist'];
  function enterKid() {
    LS.set('kidPrevRole', S.role || '');
    clearDadToken();                    // money needs the PIN again after Son's mode
    S.kid = true; LS.set('kidMode', '1');
    S.role = KID_ROLE; LS.set('role', KID_ROLE);
    S.boot = null; S.items = []; S.homeWanted = null; S.history = []; S.add = null;
    S.kidGreeting = true;
    pickFunUnitRandom();
    pickJokeOnOpen();
    recordBadgeVisit();
    go('kid', {}, true);
  }
  function exitKid() {
    sheet('Back to the full app?', '<p>' + (THEME.needsPin ? 'Grown-ups only: it needs ' + esc(PRIV) + '\u2019s PIN.' : 'Switch back to the full view?') + '</p>',
      [{ label: '\uD83D\uDD13 Yes, full app', value: true, cls: 'main' }, { label: 'Stay in ' + KID_ROLE + '\u2019s mode', value: false }]).then(function (ok) {
      if (!ok) return;
      if (THEME.needsPin) { S.kidExit = true; askDadPin(PRIV); }
      else leaveKid(LS.get('kidPrevRole') || PRIV);
    });
  }
  function leaveKid(role) {
    S.kid = false; S.kidExit = false; LS.set('kidMode', ''); S.boot = null; S.homeWanted = null;
    enterRole(role);
  }
  function kidItems() {
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    return (S.items || []).filter(function (it) { return isOwned(it) && kidVisible(it); }).sort(function (a, b) { return idn(b) - idn(a); });   // newest finds first
  }
  function kidTile(it, act) {
    return '<button class="ktile" data-act="' + (act || 'kidItem') + '" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<span class="kname">' + esc(it.name) + '</span></button>';
  }
  SCREENS.kid = function () {
    loadBoot().then(function () {
      var mine = kidItems();
      var h = '<div class="kidHead"><div class="mascot small">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteK') + '</div><h1>Hiya wee man \uD83D\uDC4B</h1></div>' +
        jokeHtml() +
        funWorthHtml() +
        '<div id="kidRewardsHome"></div>' +
        '<div id="kidWays"></div>' +
        '<div id="kidFilm"></div>' +
        '<div class="kfeatures">' +
        '<button type="button" class="kfeature pinkL" data-act="go" data-to="kidBadges"><span>\uD83C\uDFC6</span><span class="kfeatTxt"><b>My badges</b><small id="kidBadgeN">see what you\u2019ve earned</small></span></button>' +
        '<div id="kidMissions"></div>' +
        '<button type="button" class="kfeature yel" data-act="go" data-to="kidRewards"><span>\u2B50</span><span class="kfeatTxt"><b>My points</b><small id="kidPtsN">earn rewards!</small></span></button>' +
        '</div>' +
        '<div id="kidOnThisDay"></div><div id="kidSetBars"></div>' +
        '<div class="ownCard card"><label class="ownLabel" for="kidSearch">\uD83D\uDD0D Have we got it?</label><input id="kidSearch" class="ownInput" type="search" placeholder="Type a name\u2026" autocomplete="off"><div id="kidOwnOut"></div></div>' +
        '<div class="kgrid">' +
        '<button class="kbig yel" data-act="go" data-to="kidStuff"><span>\uD83E\uDDF8</span><b>Our stuff</b><small>' + mine.length + ' things</small></button>' +
        '<button class="kbig pink" data-act="go" data-to="kidHunt"><span>\u2B50</span><b>On the hunt</b><small id="kidHuntN">find these!</small></button>' +
        '<button class="kbig skyL" data-act="scan"><span>\uD83D\uDCF7</span><b>Scan a box</b><small>have we got it?</small></button>' +
        '<button class="kbig green" data-act="kidNew"><span>\u2795</span><b>New find!</b><small>snap it and save it</small></button>' +
        '<button class="kbig yel" data-act="go" data-to="wheel"><span>\uD83C\uDFA1</span><b>Spin the wheel</b><small>what shall we film?</small></button>' +
        '<button class="kbig" data-act="go" data-to="swaps"><span>\uD83D\uDD01</span><b>Doubles to swap</b><small>spares, no prices</small></button>' +
        '<button class="kbig paper" data-act="letterOpen"><span>\u2709\uFE0F</span><b>Letter from Dad</b><small>How it all started</small></button>' +
        '<button class="kbig paper" data-act="notesOpen"><span>\uD83D\uDCDD</span><b>Notes from Dad</b><small>little messages</small></button>' +
        '</div>' +
        '<div class="center" style="margin-top:18px"><button class="btn small" data-act="kidExit">\uD83D\uDD13 Grown-ups: full app</button></div>';
      setMain(h);
      try { paintStillToFilm(); } catch (eF) {}
      bindOwnSearch('kidSearch', 'kidOwnOut');
      paintHomeFunAndMiles();
      checkNewBadges().then(function (B) { var n = B.filter(function (b) { return b.got; }).length; if ($('kidBadgeN')) $('kidBadgeN').textContent = n + ' badge' + (n === 1 ? '' : 's') + ' so far!'; paintMissions(B); }).catch(noop);
      loadHomeWanted().then(function (w) { var n = w.filter(function (x) { return kidSafe(x); }).length; if ($('kidHuntN')) $('kidHuntN').textContent = n + ' to find!'; });
      loadRewards(true).then(function (r) { if ($('kidPtsN') && r) $('kidPtsN').textContent = r.balance + ' points \u00B7 ' + ((r.level && r.level.name) || ''); try { paintRewardsHome(r); } catch (eR) {} try { paintWaysToEarn(r); } catch (eJ) {} }).catch(function () { try { paintWaysToEarn({}); } catch (eJ2) {} });
      recordBadgeVisit();
      maybeShowLetter();
      bindFunSwipe();
    }).catch(oops);
  };
  SCREENS.kidStuff = function () {
    loadBoot().then(function () {
      var all = kidItems(), q = S.kidQ || '';
      var h = '<h1>\uD83E\uDDF8 Our stuff</h1><div class="search"><input id="kidQ" type="search" class="ownInput" placeholder="\uD83D\uDD0D Find something\u2026" value="' + esc(q) + '" autocomplete="off"></div><div id="kidGrid"></div>';
      setMain(h);
      var draw = function () {
        var html = '';
        if (q) {
          var list = fuzzyFind(q, all, 60).map(function (x) { return x.it; });
          html = '<p class="hint">' + list.length + ' thing' + (list.length === 1 ? '' : 's') + ' found</p><div class="kstuff">' + list.map(kidTile).join('') + '</div>';
        } else {
          var film = stillToFilmItems();
          var got = all.filter(function (it) { return it.folderId; });
          var shown = got.slice(0, S.kidShown || 40);
          html = '<p class="hint">' + all.length + ' thing' + (all.length === 1 ? '' : 's') + ' - tap one to see it or add a photo</p>';
          if (film.length) {
            html += '<div class="kstuffFilm"><h2>D\u2019oh! Still to film</h2><p class="hint">' + film.length + ' to film — tap one when you\u2019ve taken photos</p>' +
              '<div class="kstuff">' + film.map(function (it) { return kidTile(it, 'filmAsk'); }).join('') + '</div></div>';
          }
          html += (film.length ? '<h2 class="kstuffGot">Got a photo</h2>' : '') +
            '<div class="kstuff">' + shown.map(kidTile).join('') + '</div>' +
            (got.length > shown.length ? '<p class="center"><button class="btn" data-act="kidMore">Show more</button></p>' : '');
        }
        $('kidGrid').innerHTML = html;
        watchThumbs();
      };
      var t = null;
      $('kidQ').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { q = S.kidQ = e.target.value; S.kidShown = 40; draw(); }, 150); });
      S.redrawKid = draw; draw();
    }).catch(oops);
  };
  SCREENS.kidItem = function (p) {
    loadBoot().then(function () {
      var it = itemByKey(p.key);
      if (!it || !kidVisible(it)) { go('kidStuff', {}, true); return; }
      S.current = it;
      var t = it.folderId ? S.thumbs[it.folderId] : null;
      var heroWrap;
      if (it.folderId) {
        var hero = t ? '<img alt="" src="' + t + '">' : thumbInner(it.folderId);
        heroWrap = '<div class="khero" id="kHero" data-act="heroOpen" data-fid="' + esc(it.folderId) + '" role="button">' + hero + '</div>';
      } else if (standinUrl(it)) {
        heroWrap = standinBlock(it, 'khero', ' id="kHero"');
      } else {
        heroWrap = '<div class="khero" id="kHero">' + noPhotoHtml(false) + '</div>';
      }
      var h = backBtn() + '<div class="card center kidItem">' + heroWrap +
        '<h1>' + esc(it.name) + '</h1><div class="chips" style="justify-content:center">' + [it.range, it.character, it.year].filter(function (x) { return x && !/^unknown$/i.test(x); }).map(function (x) { return '<span class="chip on">' + esc(x) + '</span>'; }).join('') + '</div>' +
        '<div id="kGallery" class="gallery kidGal"></div>' +
        '<div class="stack" style="margin-top:14px"><button class="btn main full kbtn" data-act="kidSnap">\uD83D\uDCF7 Add a photo</button>' +
        '<button class="btn full kbtn" data-act="scanAssign">\uD83D\uDCF7 Scan barcode</button>' +
        (itemBarcode(it) ? '<p class="hint">Saved barcode: ' + esc(itemBarcode(it)) + '</p>' : '') +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full kbtn" data-act="kidGotItem">\uD83C\uDF89 We got it!</button>' : '<div class="pill green" style="font-size:18px;padding:6px 14px">\u2705 We\u2019ve got this!</div>') +
        '</div></div>';
      setMain(h);
      if (it.folderId) {
        watchThumbs();
        call('getItemPhotos', it.folderId).then(function (ph) {
          S.gallery = ph || [];
          paintKidItemMedia();
          var f = S.gallery.filter(function (x) { return x.thumb; })[0];
          if (f && $('kHero') && typeof S.thumbs[it.folderId] !== 'string') {
            shrinkThumb(f.thumb).then(function (s) { if (s && $('kHero')) { S.thumbs[it.folderId] = s; paintThumb(it.folderId); paintKidItemMedia(); } });
          }
        }).catch(noop);
      }
    }).catch(oops);
  };
  function paintKidItemMedia() {
    var hero = $('kHero'), box = $('kGallery'), list = S.gallery || [];
    if (hero && list.length) {
      hero.setAttribute('data-act', 'heroOpen');
      hero.setAttribute('role', 'button');
      var first = list[0];
      hero.classList.toggle('hasVideo', !!first.video);
      if (first.video && !hero.querySelector('.playIc')) hero.insertAdjacentHTML('beforeend', playBadgeHtml());
      if (!first.video) {
        var ic = hero.querySelector('.playIc'); if (ic && ic.parentNode) ic.parentNode.removeChild(ic);
      }
    }
    if (box) {
      box.innerHTML = list.length ? list.map(function (x, i) { return galleryThumbHtml(x, i); }).join('') : '';
    }
  }
  SCREENS.kidHunt = function () {
    busy('Getting the hunt list\u2026');
    loadHomeWanted().then(function (list) {
      done();
      var kl = list.filter(function (w) { return kidSafe(w); });
      S.kidWanted = kl;
      setMain('<h1>\u2B50 On the hunt</h1><p class="hint">Spotted one? Tap \u201CFound it!\u201D</p>' + renderWantedGroups(kl, true));
    }).catch(oops);
  };
  function kidGot(i) {
    var w = (S.kidWanted || [])[i]; if (!w) return;
    var fromList = w.kind === 'checklist';
    confirmSheet('Found it? \uD83C\uDF89', fromList ? 'Did we get <b>' + esc(w.name) + '</b>? I\u2019ll tick it off the hunt list.' : 'Did we get <b>' + esc(w.name) + '</b>? It\u2019ll go into our collection.', 'Yes, we got it!', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy(fromList ? 'Ticking it off\u2026' : 'Adding it to our stuff\u2026');
      return call('markGotIt', w.kind, w.ref, w.name, KID_ROLE).then(function (r) {
        done(); bumpKid('kidFound'); S.boot = null; S.homeWanted = null;
        pointsNote(r, r.queued ? '\uD83C\uDF89 Got it! It\u2019ll save when there\u2019s signal.' : (fromList || r.suggestAdd ? '\uD83C\uDF89 Brilliant! Ticked off the hunt list.' : '\uD83C\uDF89 Brilliant! It\u2019s in our collection.'));
        return confirmSheet('Take a photo?', 'Snap <b>' + esc(r.name || w.name) + '</b> now? (No faces - hands are fine.)', '\uD83D\uDCF7 Take photo', 'Later').then(function (snap) {
          if (snap && r.key) openCamera({ key: r.key, name: r.name || w.name });
          else go('kidHunt', {}, true);
        });
      });
    }).catch(oops);
  }


  /* ================= v7: letter from Dad + points / rewards ================= */
  var DAD_LETTER = {
    title: 'How it all started',
    paras: [
      'It was 2024. You were up in the loft with me, poking about in boxes nobody had opened in years, when you pulled one out and shouted, \u201CDad, what\u2019s THIS?\u201D',
      'It was my old Simpsons box, the figures and bits I\u2019d kept since I was a boy, sure that one day they\u2019d matter to someone. I just didn\u2019t know it would be you.',
      'You held up Homer like you\u2019d found treasure. And honestly, you had. Not because of what any of it was worth, but because of what it started. From that day on it wasn\u2019t my collection any more. It was ours.',
      'Every figure in this app has a story: car boot finds, eBay battles, birthday surprises, and lots of Saturday mornings filming them on the kitchen table. Some are rare, some are a bit battered, and every one of them is here because we chose it together.',
      'So if you\u2019re reading this all grown up, maybe with a wee one of your own: the best thing in this collection was never on a shelf. It was the time we spent building it.'
    ],
    sign: 'Love you, wee man.',
    from: 'Dad x',
    mum: 'Our logo is a gift from Mum: the whole family, pets and all.'
  };
  function londonDay() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function fillDadLetter() {
    var box = $('letterInner'); if (!box) return;
    box.innerHTML = '<h1 id="letterTitle">' + esc(DAD_LETTER.title) + '</h1>' +
      DAD_LETTER.paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') +
      '<div class="letterSign"><p class="love">' + esc(DAD_LETTER.sign) + '</p><p class="dad">' + esc(DAD_LETTER.from) + '</p></div>' +
      '<p class="letterMum">' + esc(DAD_LETTER.mum) + '</p>' +
      '<img class="letterLogo" src="assets/family.jpg" alt="Our family logo, a gift from Mum">';
  }
  function showDadLetter(force) {
    fillDadLetter();
    var el = $('dadLetter'); if (!el) return;
    var wasOpen = !el.hidden;
    el.hidden = false;
    dressOverlay(el);
    bumpKid('kidDadReads');
    layerOpen(wasOpen);
    try { var b = el.querySelector('.letterGo'); if (b) b.focus(); } catch (e) { /* ignore */ }
  }
  var LETTER_EVERY_DAYS = 10;
  function londonDayDiff(fromIso, toIso) {
    var a = String(fromIso || '').split('-').map(Number);
    var b = String(toIso || '').split('-').map(Number);
    if (a.length < 3 || b.length < 3 || !a[0] || !b[0]) return null;
    var ms = Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2]);
    return Math.round(ms / 86400000);
  }
  function letterLastShown() {
    return LS.get('kidLetterShown') || LS.get('kidLetterDay') || '';
  }
  function markLetterShown() {
    var d = londonDay();
    LS.set('kidLetterShown', d);
    LS.set('kidLetterDay', d);
  }
  function letterDue() {
    var last = letterLastShown();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return true;
    var n = londonDayDiff(last, londonDay());
    return n == null || n >= LETTER_EVERY_DAYS;
  }
  function hideDadLetter() {
    var el = $('dadLetter'); if (el) { el.hidden = true; el.classList.remove('popIn'); }
    markLetterShown();
  }
  function bumpKidNoteCount() {
    var n = parseInt(LS.get('kidNoteVisits') || '0', 10);
    if (!(n >= 0)) n = 0;
    n += 1;
    if (n >= 5) {
      LS.set('kidNoteVisits', '0');
      return true;
    }
    LS.set('kidNoteVisits', String(n));
    return false;
  }
  function maybeShowLetter() {
    if (!S.kid) return;
    var greeting = !!S.kidGreeting;
    S.kidGreeting = false;
    if (!greeting) return;
    if (letterDue()) { markLetterShown(); showDadLetter(false); return; }
    if (bumpKidNoteCount()) showDadNote();
  }

  var DAD_NOTES = [
    'Proud of you, wee man. Always.',
    'Remember the loft? Best day ever. Dad x',
    'Every shelf in this house has a bit of you on it.',
    'Gentle hands with the boxes. Some of these are older than me!',
    "You've got a better eye for a bargain than I do.",
    "Win or lose on eBay, we're a team.",
    'Homer would be proud. So am I.',
    'Got a new photo to take? Go get it, Collector Pro!',
    'The best thing in this collection is you.',
    'Saturday mornings with you are my favourite.',
    "Keep being curious. That's what real collectors do.",
    'Come Up The Dons! Now go find a Simpsons treasure.',
    'Love you more than Homer loves donuts. Dad x',
    "One day this'll all be yours. Look after it like we did together.",
    'Thanks for being my best collecting buddy.'
  ];
  function noteHasSign(t) { return /(?:^|\s)Dad x\s*$/.test(String(t || '')); }
  function notesSeen() {
    try {
      var a = JSON.parse(LS.get('kidNotesSeen') || '[]');
      return Array.isArray(a) ? a.map(Number).filter(function (n) { return n >= 0 && n < DAD_NOTES.length; }) : [];
    } catch (e) { return []; }
  }
  function nextNoteIndex() {
    var seen = notesSeen();
    if (seen.length >= DAD_NOTES.length) { LS.set('kidNotesSeen', '[]'); seen = []; }
    for (var i = 0; i < DAD_NOTES.length; i++) if (seen.indexOf(i) < 0) return i;
    return 0;
  }
  function markNoteSeen(i) {
    var a = notesSeen();
    if (a.indexOf(i) < 0) a.push(i);
    LS.set('kidNotesSeen', JSON.stringify(a));
  }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  function dressOverlay(el) {
    if (!el) return;
    var sky = el.querySelector('.letterSky');
    if (sky && !sky.innerHTML) sky.innerHTML = cloudsSvg();
    el.classList.remove('popIn');
    try { void el.offsetWidth; } catch (e) {}
    el.classList.add('popIn');
  }
  function noteEmojiFor(t) {
    var s = String(t || '').toLowerCase();
    var rules = [
      [/loft|\bbox/, '\uD83D\uDCE6'],
      [/donut/, '\uD83C\uDF69'],
      [/dons|football|come up/, '\u26BD'],
      [/tractor|farm/, '\uD83D\uDE9C'],
      [/photo|camera|snap/, '\uD83D\uDCF7'],
      [/ebay|bargain/, '\uD83E\uDD1D'],
      [/curious|treasure|hunt|find/, '\uD83D\uDD0D'],
      [/saturday|morning/, '\u2600\uFE0F'],
      [/shelf|house|yours/, '\uD83C\uDFE0'],
      [/homer/, '\uD83C\uDF69'],
      [/proud|love you|buddy|best thing|wee man/, '\u2764\uFE0F']
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
    return Math.random() < 0.5 ? '\u2764\uFE0F' : '\u2B50';
  }
  var NOTE_BYE = [
    'Aww thanks!', 'Cheers Dad!', 'Woohoo!', 'Ay caramba!', 'Mmm, donuts\u2026',
    'Eat my shorts!', 'Love you too!', 'Come on the Dons!', 'Excellent\u2026',
    'Okily dokily!', 'Cowabunga!', 'Got it, boss!', 'Ha-ha!', 'Nice one!',
    'Legend, Dad!', 'You bet!', 'Too right!', 'Ace!', 'Brilliant!',
    'Hi-diddly-ho!', 'D\u2019oh\u2026 thanks!', 'Aye aye!', 'Cracking!',
    'Love a note!', 'Noted!', 'Right you are!', 'On it!', 'Cool beans!',
    'Ya dancer!', 'Pure dead brilliant!', 'Let\u2019s go!', 'Best Dad ever!'
  ];
  var NOTE_CHASE_SAY = ['Too slow!', 'Missed me!', 'Over here!', 'Nearly!', 'Heh heh!', 'Try again!', 'Catch me!'];
  var NOTE_UI = { chase: false, need: 0, got: 0, skipTimer: 0, fromPointer: 0 };
  function clearNoteChase() {
    NOTE_UI.chase = false; NOTE_UI.need = 0; NOTE_UI.got = 0;
    if (NOTE_UI.skipTimer) { clearTimeout(NOTE_UI.skipTimer); NOTE_UI.skipTimer = 0; }
    var btn = $('noteGoBtn') || document.querySelector('#dadNote [data-act="noteGo"]');
    if (btn) {
      btn.style.position = ''; btn.style.left = ''; btn.style.top = '';
      btn.style.right = ''; btn.style.bottom = ''; btn.style.margin = '';
      btn.style.width = ''; btn.style.maxWidth = '';
      btn.classList.remove('noteWobble');
    }
    var skip = $('noteSkip'); if (skip) skip.hidden = true;
    var cap = $('noteChaseSay'); if (cap) cap.hidden = true;
  }
  function setupNoteButton() {
    clearNoteChase();
    var btn = $('noteGoBtn') || document.querySelector('#dadNote [data-act="noteGo"]');
    if (btn) btn.textContent = NOTE_BYE[Math.floor(Math.random() * NOTE_BYE.length)];
    if (btn && !btn.getAttribute('data-note-bound')) {
      btn.setAttribute('data-note-bound', '1');
      btn.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;
        NOTE_UI.fromPointer = Date.now();
        if (e.cancelable) e.preventDefault();
        onNoteGo(e);
      });
    }
    NOTE_UI.chase = !reducedMotion() && Math.random() < 1 / 3;
    if (NOTE_UI.chase) {
      NOTE_UI.need = 2 + Math.floor(Math.random() * 3);
      NOTE_UI.got = 0;
      NOTE_UI.skipTimer = setTimeout(function () { var sk = $('noteSkip'); if (sk) sk.hidden = false; }, 5000);
    }
  }
  function jumpNoteButton() {
    var wrap = $('dadNote'), btn = $('noteGoBtn') || (wrap && wrap.querySelector('[data-act="noteGo"]'));
    if (!wrap || !btn) return;
    var vv = window.visualViewport;
    var vx = (vv && vv.offsetLeft) || 0, vy = (vv && vv.offsetTop) || 0;
    var vw = (vv && vv.width) || window.innerWidth, vh = (vv && vv.height) || window.innerHeight;
    var padX = 12, padTop = 16, padBot = 16;
    try {
      var cs = getComputedStyle(wrap);
      padTop = Math.max(16, parseFloat(cs.paddingTop) || 0);
      padBot = Math.max(16, parseFloat(cs.paddingBottom) || 0);
      padX = Math.max(12, parseFloat(cs.paddingLeft) || 0);
    } catch (e) {}
    var bw = btn.offsetWidth, bh = btn.offsetHeight;
    var minL = vx + padX, minT = vy + padTop;
    var maxL = vx + vw - bw - padX, maxT = vy + vh - bh - padBot;
    if (maxL < minL) maxL = minL;
    if (maxT < minT) maxT = minT;
    var left, top, tries = 0, cur = btn.getBoundingClientRect();
    do {
      left = minL + Math.random() * (maxL - minL);
      top = minT + Math.random() * (maxT - minT);
      tries++;
    } while (tries < 10 && Math.hypot(left - cur.left, top - cur.top) < Math.min(90, Math.max(40, (maxL - minL) / 3)));
    btn.style.position = 'fixed';
    btn.style.margin = '0';
    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(top) + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    btn.style.width = bw + 'px';
    btn.style.maxWidth = 'calc(100vw - 24px)';
    btn.classList.remove('noteWobble');
    try { void btn.offsetWidth; } catch (e2) {}
    btn.classList.add('noteWobble');
    var cap = $('noteChaseSay');
    if (cap) {
      cap.textContent = NOTE_CHASE_SAY[Math.floor(Math.random() * NOTE_CHASE_SAY.length)];
      cap.hidden = false;
      var capW = 130;
      cap.style.left = Math.round(Math.min(vx + vw - capW - 8, Math.max(vx + 8, left))) + 'px';
      cap.style.top = Math.round(Math.max(vy + padTop, top - 34)) + 'px';
    }
  }
  function onNoteGo(e) {
    if (NOTE_UI.chase) {
      NOTE_UI.got += 1;
      if (NOTE_UI.got < NOTE_UI.need) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        jumpNoteButton();
        return;
      }
    }
    thanksDadNote();
  }
  function thanksDadNote() {
    clearNoteChase();
    sprinkleConfetti($('dadNote'), function () {
      if (NAV.pushed > 0) layerBack(); else hideDadNote();
    });
  }
  function sprinkleConfetti(root, done) {
    if (!root || reducedMotion()) { if (done) done(); return; }
    var box = root.querySelector('.noteSprinkles');
    if (!box) { box = document.createElement('div'); box.className = 'noteSprinkles'; root.appendChild(box); }
    box.innerHTML = '';
    var colors = ['#F4A0B5', '#FED90F', '#FFFFFF', '#E4572E', '#1A3A9C', '#7BD389'];
    var wr = root.getBoundingClientRect();
    var cx = wr.width / 2, cy = wr.height * 0.62;
    for (var i = 0; i < 28; i++) {
      var d = document.createElement('span');
      d.className = 'noteSprinkle';
      d.style.left = cx + 'px';
      d.style.top = cy + 'px';
      d.style.background = colors[i % colors.length];
      var ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 150;
      d.style.setProperty('--sx', (Math.cos(ang) * dist) + 'px');
      d.style.setProperty('--sy', (Math.sin(ang) * dist) + 'px');
      box.appendChild(d);
    }
    setTimeout(function () { box.innerHTML = ''; if (done) done(); }, 720);
  }

  function showDadNote(idx) {
    var fromList = arguments.length > 0 && idx != null;
    var i = fromList ? +idx : nextNoteIndex();
    if (!(i >= 0 && i < DAD_NOTES.length)) return;
    var el = $('dadNote'); if (!el) return;
    var t = DAD_NOTES[i];
    if ($('noteBody')) $('noteBody').textContent = t;
    var emo = $('noteEmoji'); if (emo) emo.textContent = noteEmojiFor(t);
    var sign = $('noteSign'); if (sign) sign.hidden = noteHasSign(t);
    var wasOpen = !el.hidden;
    el.hidden = false;
    dressOverlay(el);
    setupNoteButton();
    bumpKid('kidDadReads');
    layerOpen(wasOpen);
    if (!fromList) markNoteSeen(i);
    try { var b = el.querySelector('[data-act="noteGo"]'); if (b) b.focus(); } catch (e) { /* ignore */ }
  }
  function hideDadNote() {
    clearNoteChase();
    var el = $('dadNote');
    if (el) { el.hidden = true; el.classList.remove('popIn'); var sp = el.querySelector('.noteSprinkles'); if (sp) sp.innerHTML = ''; }
  }
  SCREENS.kidNotes = function () {
    var h = backBtn() + '<h1>\uD83D\uDCDD Notes from Dad</h1><p class="hint">Little notes Dad leaves for you. The big letter is still under Letter from Dad.</p>' +
      DAD_NOTES.map(function (t, i) {
        return '<button type="button" class="noteLi" data-act="noteOpen" data-i="' + i + '"><p>' + esc(t) + '</p>' +
          (noteHasSign(t) ? '' : '<p class="noteLiSign">Dad x</p>') + '</button>';
      }).join('');
    setMain(h);
  }

  var JOKES = [
    { q: "What do you call a boomerang that won't come back?", a: "A stick." },
    { q: "What's orange and sounds like a parrot?", a: "A carrot." },
    { q: "Why did the bicycle fall over?", a: "It was two-tyred." },
    { q: "What do you call cheese that isn't yours?", a: "Nacho cheese." },
    { q: "Why don't eggs tell jokes?", a: "They'd crack each other up." },
    { q: "What do you call a bear with no teeth?", a: "A gummy bear." },
    { q: "What did the ocean say to the beach?", a: "Nothing, it just waved." },
    { q: "Why was the broom late?", a: "It over-swept." },
    { q: "What do you call a fake noodle?", a: "An impasta." },
    { q: "Why did the cookie go to the doctor?", a: "It felt crumby." },
    { q: "What has hands but can't clap?", a: "A clock." },
    { q: "Why can't your nose be 12 inches long?", a: "Because then it would be a foot." },
    { q: "What do you call a sleeping bull?", a: "A bulldozer." },
    { q: "Why did the golfer bring two pairs of trousers?", a: "In case he got a hole in one." },
    { q: "What do you call a pile of cats?", a: "A meowtain." },
    { q: "Why did the tomato blush?", a: "Because it saw the salad dressing." },
    { q: "What's brown and sticky?", a: "A stick." },
    { q: "Why was six afraid of seven?", a: "Because seven eight nine." },
    { q: "What do you call a fly without wings?", a: "A walk." },
    { q: "Why did the calendar get stressed?", a: "Its days were numbered." },
    { q: "What do you call a song sung in a car?", a: "A cartoon." },
    { q: "What do you call an alligator in a vest?", a: "An investigator." },
    { q: "Why are frogs so happy?", a: "They eat whatever bugs them." },
    { q: "What do you call a pig that does karate?", a: "A pork chop." },
    { q: "Why did the cow become an astronaut?", a: "To visit the moooon." },
    { q: "What do you call a magic dog?", a: "A labracadabrador." },
    { q: "Why do bees have sticky hair?", a: "They use honeycombs." },
    { q: "How do you stop a bull from charging?", a: "Take away its credit card." },
    { q: "What do you call a fish with no eyes?", a: "A fsh." },
    { q: "Why did the banana go to the doctor?", a: "It wasn't peeling well." },
    { q: "Why did the tea bag go to school?", a: "It wanted to be a brew-n medallist." },
    { q: "Why did the milk go to school?", a: "To become a little cultured." },
    { q: "What do you call cheese at a football match?", a: "A little cheer-dar." },
    { q: "Why was the maths book so sad?", a: "It had too many problems." },
    { q: "What is a teacher's favourite tea?", a: "Proper-tea." },
    { q: "Why did the student eat his homework?", a: "The teacher said it was a piece of cake." },
    { q: "What's a maths teacher's favourite season?", a: "Sum-mer." },
    { q: "Why did the teacher wear sunglasses?", a: "Her pupils were so bright." },
    { q: "Why did the boy bring a ladder to school?", a: "He wanted to go to high school." },
    { q: "Why did the goldfish go to school?", a: "To swim to the top of the class." },
    { q: "Why did the teddy go to school?", a: "To become a stuffed-with-knowledge bear." },
    { q: "Why did the crayon go to school?", a: "It wanted to draw attention, very politely." },
    { q: "Why did the school bell blush?", a: "It had just been rung in front of everyone." },
    { q: "Why did the owl make a great teacher?", a: "Because it was a little wise and very patient." },
    { q: "Why did the apple go to school?", a: "It wanted to become a little core-educated." },
    { q: "What did one crayon say to the other?", a: "You're looking very bright today." },
    { q: "Why did the present go to school?", a: "It wanted to be well wrapped up in knowledge." },
    { q: "Why did the stadium get so hot?", a: "All the fans were in it." },
    { q: "Why did the footballer take a pencil to the match?", a: "So he could draw a foul." },
    { q: "Why was the football team so cool?", a: "They had lots of fans." },
    { q: "I used to be a goalkeeper.", a: "But I let myself down." },
    { q: "Why did the player bring string to the game?", a: "To tie the score." },
    { q: "What's a ghost's favourite position?", a: "Ghoul-keeper." },
    { q: "Why did the football go to school?", a: "To get a little more kick out of class." },
    { q: "Why did the referee go to the optician?", a: "He kept missing the offside." },
    { q: "How do footballers stay cool?", a: "They stand next to the fans." },
    { q: "Why did the striker bring a torch?", a: "It was a late kick-off." },
    { q: "Why was the pitch so well behaved?", a: "It knew where the lines were." },
    { q: "What do footballers eat with their pies?", a: "A nice cup of team." },
    { q: "Why was the football wet?", a: "It was a cup tie." },
    { q: "Why was the goalpost so proud?", a: "It had been a great sport all season." },
    { q: "What's a penguin's favourite football position?", a: "Left wing, with a very smart waddle." },
    { q: "Why did the Dons take a ladder to Pittodrie?", a: "They wanted to reach the top of the league." },
    { q: "Knock knock. Who's there? Don. Don who?", a: "Dons are at home today — coming?" },
    { q: "Why was the Dons scarf so cheerful?", a: "It was red and gold with excitement." },
    { q: "What do you call an Aberdeen fan with a packed lunch?", a: "A happy Pittodrie pie fan." },
    { q: "Why do the Dons never get lost on match day?", a: "They always Come Up The Dons." },
    { q: "What's the Dons' favourite kind of weather?", a: "A red-hot home game." },
    { q: "Why did the football take a bus to Aberdeen?", a: "It had a ticket for Pittodrie." },
    { q: "What do Dons fans sing in a bakery?", a: "Come on you buns." },
    { q: "Why was the Pittodrie grass grinning?", a: "The Dons had just scored." },
    { q: "Why did the Dons bring a pencil to the derby?", a: "To draw a win." },
    { q: "What do you call a rainy match at Pittodrie?", a: "A perfect day for a pie and a cheer." },
    { q: "Why did the pencil case go to the match?", a: "It wanted to draw 1-0 to the Dons." },
    { q: "Why did the donut go to Pittodrie?", a: "It wanted to see a jammy goal." },
    { q: "Why did the chicken watch the Dons?", a: "It heard there might be a fowl at the final whistle." },
    { q: "Why did the snowman take a scarf to Pittodrie?", a: "Even frozen fans like to cheer in red and gold." },
    { q: "Why did the scarecrow get a medal?", a: "He was outstanding in his field." },
    { q: "What has ears but can't hear?", a: "A field of corn." },
    { q: "Why did the tractor turn up early?", a: "It wanted to get ahead of the plough." },
    { q: "What do you call a tractor that tells jokes?", a: "A laugh-a-Massey." },
    { q: "Why don't tractors ever get lost?", a: "They always follow the furrows." },
    { q: "What did the farmer say to the Massey Ferguson?", a: "You really drive me bale-y." },
    { q: "What do you call a sheep with a sports car?", a: "A Lamborghini." },
    { q: "Why did the chicken join the farm band?", a: "It had the drumsticks." },
    { q: "What do you get if you cross a tractor with a kangaroo?", a: "A machine that jumps to the next field." },
    { q: "Why was the barn so noisy?", a: "The cows had a moo-sical." },
    { q: "What's a tractor's favourite snack?", a: "Hay-stackers." },
    { q: "What did the horse say after a long trot?", a: "That's enough, I'm hoarse." },
    { q: "Why don't farmers tell secrets in a field of corn?", a: "Too many ears." },
    { q: "What's a scarecrow's favourite fruit?", a: "Straw-berries." },
    { q: "Why did the Massey Ferguson blush?", a: "It saw the combine looking at it." },
    { q: "What do you call a cow in a field of daisies?", a: "A happy moo-d." },
    { q: "Why did the tractor take a nap?", a: "It had had a long, tyred day." },
    { q: "What's the fastest vegetable on the farm?", a: "The runner bean." },
    { q: "Why did the tractor honk at the sheep?", a: "It was just saying 'after ewe'." },
    { q: "What's the warmest jumper on the farm?", a: "The woolly one from a very kind sheep." },
    { q: "How do you know if Santa's been in the kitchen?", a: "The mince pies are missing and the carrots have a nibble." },
    { q: "Why did the bauble blush?", a: "It saw the fairy on top of the tree." },
    { q: "What do elves use to keep score?", a: "A wrapping tally." },
    { q: "What did one snowflake say to the other?", a: "Don't flake out on me now." },
    { q: "Why did the ghost go to the Christmas party?", a: "It was there in spirit." },
    { q: "What's the best seat at Christmas dinner?", a: "The one nearest the roast potatoes." },
    { q: "What do you call a sleeping dinosaur?", a: "A dino-snore." },
    { q: "Why did the dinosaur cross the road?", a: "Because chickens hadn't been invented yet." },
    { q: "How do you know there's a dinosaur in the fridge?", a: "The door won't shut." },
    { q: "What's a T-rex's favourite biscuit?", a: "One it can actually hold, which is tricky." },
    { q: "Why can't a T-rex clap?", a: "Because they're extinct, and also those little arms." },
    { q: "What do you call a dinosaur at a tea party?", a: "A dino-scone." },
    { q: "Why was the pterodactyl so good at tennis?", a: "It had a smashing wingspan." },
    { q: "How does a dinosaur cheer at a match?", a: "Dino-score!" },
    { q: "What do you call a dinosaur that writes jokes?", a: "A pun-asaurus." },
    { q: "What do you say to a cold stegosaurus?", a: "Here's a jumper, you look a little dino-sore." },
    { q: "Where do dinosaurs buy their wellies?", a: "At a dino-store." },
    { q: "Why did the triceratops take a pencil to the museum?", a: "To draw its favourite fossils." },
    { q: "What do dinosaurs have that no other animals have?", a: "Baby dinosaurs." },
    { q: "How do you ask a dinosaur to lunch?", a: "Tea-rex?" },
    { q: "What do you call a dinosaur that sits on a biscuit?", a: "A dino-crunch." },
    { q: "Why are dinosaurs brilliant at hide-and-seek in museums?", a: "They're already standing very, very still." },
    { q: "Why did the dinosaur take a bus to the museum?", a: "Its little arms couldn't reach the tickets." },
    { q: "What do you call a dinosaur that loves football?", a: "A goal-asaurus." },
    { q: "What's a dinosaur's favourite crisp flavour?", a: "Roar-ast chicken." },
    { q: "What do you call a dinosaur in wellies?", a: "Ready for a very muddy adventure." },
    { q: "What do you call a quiet classroom of dinosaurs?", a: "A dino-hush, just before lunch." },
    { q: "What do you call a dinosaur that loves school?", a: "A very clever dino-swot, in the nicest way." },
    { q: "What do you call a dinosaur that never gives up?", a: "A try-try-try-ceratops." },
    { q: "Knock knock. Who's there? Boo. Boo who?", a: "Don't cry, it's only a joke!" },
    { q: "Knock knock. Who's there? Lettuce. Lettuce who?", a: "Lettuce in, it's freezing out here!" },
    { q: "Knock knock. Who's there? Atch. Atch who?", a: "Bless you!" },
    { q: "Knock knock. Who's there? Nobel. Nobel who?", a: "No bell, that's why I knocked!" },
    { q: "Knock knock. Who's there? Tank. Tank who?", a: "You're welcome!" },
    { q: "Knock knock. Who's there? Ice cream. Ice cream who?", a: "Ice cream if you don't let me in!" },
    { q: "Knock knock. Who's there? Orange. Orange who?", a: "Orange you going to let me in?" },
    { q: "Knock knock. Who's there? A little old lady. A little old lady who?", a: "I didn't know you could yodel!" },
    { q: "Knock knock. Who's there? Harry. Harry who?", a: "Harry up, it's chilly on the step!" },
    { q: "Knock knock. Who's there? Annie. Annie who?", a: "Annie more jokes you'd like?" },
    { q: "Knock knock. Who's there? Luke. Luke who?", a: "Luke through the keyhole and you'll see!" },
    { q: "Knock knock. Who's there? Cows go. Cows go who?", a: "No, cows go moo!" },
    { q: "Knock knock. Who's there? Hawaii. Hawaii who?", a: "I'm fine, Hawaii you?" },
    { q: "Knock knock. Who's there? Interrupting cow. Interrupting cow who?", a: "MOO! She didn't even wait to be asked." },
    { q: "Knock knock. Who's there? Spell. Spell who?", a: "W-H-O. That was a short spelling test!" },
    { q: "Knock knock. Who's there? Wooden shoe. Wooden shoe who?", a: "Wooden shoe like to hear another joke?" },
    { q: "Knock knock. Who's there? Olive. Olive who?", a: "Olive this joke a lot, do you?" },
    { q: "Knock knock. Who's there? Justin. Justin who?", a: "Justin time for another joke!" },
    { q: "Knock knock. Who's there? Icy. Icy who?", a: "Icy you waving from the window!" },
    { q: "Knock knock. Who's there? Dozen. Dozen who?", a: "Dozen anyone want to let me in?" },
    { q: "Knock knock. Who's there? Alpaca. Alpaca who?", a: "Alpaca the hamper if you pack the crisps!" },
    { q: "Knock knock. Who's there? Donut. Donut who?", a: "Donut you want to hear a Homer joke too?" },
    { q: "Knock knock. Who's there? Radio. Radio who?", a: "Radio not, here comes another joke!" },
    { q: "Knock knock. Who's there? Nessie. Nessie who?", a: "Nessie you around the loch later!" },
    { q: "Knock knock. Who's there? Irn-Bru. Irn-Bru who?", a: "Irn-Bru-tiful day for a joke, isn't it?" },
    { q: "Knock knock. Who's there? Tractor. Tractor who?", a: "Tractor maybe we can go for a ride in the field!" },
    { q: "What do you call a rabbit that tells jokes?", a: "A funny bunny." },
    { q: "Why did the dog sit in the shade?", a: "It didn't want to be a hot dog." },
    { q: "What do you call a deer with no eyes?", a: "No eye deer." },
    { q: "What do you call a deer with no eyes and no legs?", a: "Still no eye deer." },
    { q: "How do you get an elephant into a fridge?", a: "Open the door, put the elephant in, close the door." },
    { q: "How do you get a giraffe into a fridge?", a: "Open the door, take the elephant out, put the giraffe in." },
    { q: "All the animals come to the lion's party, except one. Who's missing?", a: "The giraffe — it's still in the fridge." },
    { q: "Why does Homer keep a donut in his pocket?", a: "In case of a pink-icing emergency." },
    { q: "What's Homer's favourite day of the week?", a: "Donut-day, which is luckily all of them." },
    { q: "Why did Bart take a skateboard to class?", a: "He wanted to roll into first period." },
    { q: "Why did Krusty open a burger stall?", a: "So he could clown around in the kitchen." },
    { q: "Why was Ralph so happy at lunch?", a: "He found a sandwich and called it his best friend." },
    { q: "What did Ralph say to the crayon?", a: "You're a pretty colour. Want to be pals?" },
    { q: "Why did Homer go to the bakery at dawn?", a: "The early man gets the donut." },
    { q: "What's Bart's favourite kind of test?", a: "A short one, with a skateboard at the end." },
    { q: "Why did Marge hide the extra donuts?", a: "She knew Homer had a super-sniffer." },
    { q: "What do you call Homer at the fridge?", a: "A man on a very important mission." },
    { q: "What's Ralph's favourite lesson?", a: "Show and tell, especially if lunch is invited." },
    { q: "Why did Lisa take her saxophone to the park?", a: "So the trees could enjoy a little jazz." },
    { q: "What did the pink donut say to Homer?", a: "Don't worry, I've saved you a bite." },
    { q: "What's Maggie's favourite game?", a: "Peekaboo, with a very quiet encore." },
    { q: "Why did Homer wear a chef's hat?", a: "He was the official donut inspector." },
    { q: "What's Bart's favourite type of weather?", a: "The kind that's perfect for a skate." },
    { q: "Why did Ralph bring a stick to show and tell?", a: "He thought it might be a magic wand, or a good friend." },
    { q: "What's Homer's plan for Christmas Eve?", a: "Guard the mince pies, then accidentally test them." },
    { q: "What do you call a joke that's come all the way from Springfield?", a: "A Homer-made giggle." },
    { q: "Why did Bart's skateboard go to school?", a: "To pass with flying wheels." },
    { q: "What do you call a dinosaur that lives in a loch?", a: "Nessie-saurus." },
    { q: "Why did the Irn-Bru go to school?", a: "To get a little brighter." },
    { q: "What's a bagpipe's favourite subject?", a: "Reed-ing." },
    { q: "Why did Nessie hide under the water?", a: "She was playing a long game of hide-and-seek." },
    { q: "What do you get if you cross a cow and a bagpipe?", a: "A lot of milk and a lot of puff." },
    { q: "Why did the haggis go to the party?", a: "Because it was the toast of Burns Night supper." },
    { q: "What's the most musical potato in Scotland?", a: "A tattie that plays the pipes." },
    { q: "Why did the can of Irn-Bru blush?", a: "It saw the shortbread looking sweet." },
    { q: "What's Nessie's favourite snack?", a: "Fish and ships, by the loch." },
    { q: "Why did the bagpipes go to the doctor?", a: "They were a little flat." },
    { q: "What do Highland cows say in winter?", a: "It's brrr-illiant up here." },
    { q: "Why did the Aberdeen rowie go to school?", a: "To become well rounded." },
    { q: "Why was the tablet so popular?", a: "It was a sweetie from the start." },
    { q: "What did the loch say to Nessie?", a: "You're my favourite monster pal." },
    { q: "What's the cheeriest drink in Scotland?", a: "Irn-Bru, on a sunny Saturday." },
    { q: "What do you call a bagpipe that tells jokes?", a: "A stand-up piper." },
    { q: "Why did the haggis sit at the front?", a: "It wanted a good view of supper." },
    { q: "What's Nessie's favourite game?", a: "I spy, with my little loch." },
    { q: "Why did Nessie start a choir?", a: "She wanted to make a little loch-al music." },
    { q: "What do you call a cow that plays the bagpipes?", a: "A moo-sician from the glen." },
    { q: "What's the sweetest thing in a Scottish tin?", a: "A Tunnock's teacake, no contest." }
  ];

  function jokesSeen() {
    try {
      var a = JSON.parse(LS.get('kidJokesSeen') || '[]');
      return Array.isArray(a) ? a.map(Number).filter(function (n) { return n >= 0 && n < JOKES.length; }) : [];
    } catch (e) { return []; }
  }
  function markJokeSeen(i) {
    var a = jokesSeen();
    if (a.indexOf(i) < 0) a.push(i);
    LS.set('kidJokesSeen', JSON.stringify(a));
  }
  function nextJokeIndex(except) {
    var seen = jokesSeen();
    if (seen.length >= JOKES.length) { LS.set('kidJokesSeen', '[]'); seen = []; }
    var pool = [];
    for (var i = 0; i < JOKES.length; i++) if (seen.indexOf(i) < 0 && i !== except) pool.push(i);
    if (!pool.length) {
      LS.set('kidJokesSeen', '[]');
      for (var j = 0; j < JOKES.length; j++) if (j !== except) pool.push(j);
      if (!pool.length) pool = [0];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function pickJokeOnOpen() {
    if (!JOKES.length) return;
    var i = nextJokeIndex();
    LS.set('kidJoke', String(i));
    markJokeSeen(i);
  }
  function jokeHtml() {
    if (!S.kid) return '';
    var i = parseInt(LS.get('kidJoke') || '-1', 10);
    if (!(i >= 0 && i < JOKES.length)) { i = nextJokeIndex(); LS.set('kidJoke', String(i)); markJokeSeen(i); }
    var j = JOKES[i];
    return '<button type="button" class="kidJoke" id="kidJoke" data-act="jokeNext" aria-label="Tap for another joke">' +
      '<p class="jokeQ">' + esc(j.q) + '</p>' +
      '<p class="jokeA">' + esc(j.a) + '</p>' +
      '<p class="jokeHint">Tap for another</p></button>';
  }
  function showNextJoke() {
    var cur = parseInt(LS.get('kidJoke') || '0', 10);
    var i = nextJokeIndex(cur);
    LS.set('kidJoke', String(i));
    markJokeSeen(i);
    bumpKid('kidJokes');
    var el = $('kidJoke'); if (!el) return;
    var j = JOKES[i];
    var q = el.querySelector('.jokeQ'), a = el.querySelector('.jokeA');
    if (q) q.textContent = j.q;
    if (a) a.textContent = j.a;
  }

  /* What's it worth: swipe-only comparisons from his interests.
     gbp is an approximate typical UK figure used only to work out the count.
     It is never shown on this card, and never in Son's mode.
     Figures are rounded typicals (shop prices or mid estimates), not exact quotes. */
  var FUN_UNITS = [
    { id: "donkey", emoji: "🫏", art: "a", one: "donkey", many: "donkeys", gbp: 350 },
    { id: "rescue_dog", emoji: "🐶", art: "a", one: "rescue dog", many: "rescue dogs", gbp: 200 },
    { id: "puppy", emoji: "🐶", art: "a", one: "family puppy", many: "family puppies", gbp: 500 },
    { id: "labrador", emoji: "🦮", art: "a", one: "Labrador puppy", many: "Labrador puppies", gbp: 1000 },
    { id: "dog_treats", emoji: "🦴", art: "a", one: "bag of dog treats", many: "bags of dog treats", gbp: 4 },
    { id: "dog_food", emoji: "🥫", art: "a", one: "bag of dog food", many: "bags of dog food", gbp: 20 },
    { id: "dog_bed", emoji: "🛏️", art: "a", one: "dog bed", many: "dog beds", gbp: 25 },
    { id: "rescue_cat", emoji: "🐱", art: "a", one: "rescue cat", many: "rescue cats", gbp: 90 },
    { id: "kitten", emoji: "🐱", art: "a", one: "kitten", many: "kittens", gbp: 150 },
    { id: "cat_treats", emoji: "🐟", art: "a", one: "bag of cat treats", many: "bags of cat treats", gbp: 3 },
    { id: "cat_tree", emoji: "🌳", art: "a", one: "cat tree", many: "cat trees", gbp: 40 },
    { id: "highland_cow", emoji: "🐄", art: "a", one: "Highland cow", many: "Highland cows", gbp: 1000 },
    { id: "cow_toy", emoji: "🐄", art: "a", one: "Highland cow soft toy", many: "Highland cow soft toys", gbp: 15 },
    { id: "donkey_toy", emoji: "🫏", art: "a", one: "donkey soft toy", many: "donkey soft toys", gbp: 15 },
    { id: "donkey_feed", emoji: "🌾", art: "a", one: "sack of donkey feed", many: "sacks of donkey feed", gbp: 12 },
    { id: "hotwheels", emoji: "🏎️", art: "a", one: "boxed Hot Wheels car", many: "boxed Hot Wheels cars", gbp: 2 },
    { id: "hw_5pack", emoji: "🚗", art: "a", one: "Hot Wheels 5-pack", many: "Hot Wheels 5-packs", gbp: 8 },
    { id: "hw_premium", emoji: "🏁", art: "a", one: "Hot Wheels premium car", many: "Hot Wheels premium cars", gbp: 8 },
    { id: "hw_track", emoji: "🏁", art: "a", one: "Hot Wheels track set", many: "Hot Wheels track sets", gbp: 25 },
    { id: "hw_mega", emoji: "🏎️", art: "a", one: "Hot Wheels mega track set", many: "Hot Wheels mega track sets", gbp: 40 },
    { id: "match_attax", emoji: "⚽", art: "a", one: "Match Attax pack", many: "Match Attax packs", gbp: 2 },
    { id: "match_eco", emoji: "⚽", art: "a", one: "Match Attax eco pack", many: "Match Attax eco packs", gbp: 6 },
    { id: "match_multi", emoji: "⚽", art: "a", one: "Match Attax mega multipack", many: "Match Attax mega multipacks", gbp: 8 },
    { id: "match_tin", emoji: "🗃️", art: "a", one: "Match Attax tin", many: "Match Attax tins", gbp: 10 },
    { id: "match_mega_tin", emoji: "🗃️", art: "a", one: "Match Attax mega tin", many: "Match Attax mega tins", gbp: 15 },
    { id: "signed_card", emoji: "🖊️", art: "a", one: "typical signed football card", many: "typical signed football cards", gbp: 40 },
    { id: "graded_card", emoji: "💎", art: "a", one: "typical graded football card", many: "typical graded football cards", gbp: 40 },
    { id: "choc_bar", emoji: "🍫", art: "a", one: "chocolate bar", many: "chocolate bars", gbp: 1.2 },
    { id: "haribo", emoji: "🍬", art: "a", one: "bag of sweets", many: "bags of sweets", gbp: 1.5 },
    { id: "teacake", emoji: "🧁", art: "a", one: "Tunnock's teacake", many: "Tunnock's teacakes", gbp: 0.7 },
    { id: "teacake_box", emoji: "🧁", art: "a", one: "box of Tunnock's teacakes", many: "boxes of Tunnock's teacakes", gbp: 3.5 },
    { id: "caramel_wafer", emoji: "🍫", art: "a", one: "Tunnock's caramel wafer", many: "Tunnock's caramel wafers", gbp: 0.55 },
    { id: "tablet", emoji: "🍬", art: "a", one: "bag of tablet", many: "bags of tablet", gbp: 3.5 },
    { id: "pickmix", emoji: "🍭", art: "a", one: "pick-and-mix cup", many: "pick-and-mix cups", gbp: 2.5 },
    { id: "lolly", emoji: "🍭", art: "a", one: "lollipop", many: "lollipops", gbp: 0.5 },
    { id: "share_bag", emoji: "🍬", art: "a", one: "share bag of sweets", many: "share bags of sweets", gbp: 2 },
    { id: "icecream", emoji: "🍦", art: "an", one: "ice cream", many: "ice creams", gbp: 2.5 },
    { id: "footy_shirt", emoji: "👕", art: "a", one: "replica football shirt", many: "replica football shirts", gbp: 70 },
    { id: "footy_scarf", emoji: "🧣", art: "a", one: "football scarf", many: "football scarves", gbp: 20 },
    { id: "footy_ticket", emoji: "🎫", art: "a", one: "typical match ticket", many: "typical match tickets", gbp: 35 },
    { id: "footy_programme", emoji: "📰", art: "a", one: "match programme", many: "match programmes", gbp: 4 },
    { id: "signed_shirt", emoji: "✍️", art: "a", one: "typical signed football shirt", many: "typical signed football shirts", gbp: 150 },
    { id: "football", emoji: "⚽", art: "a", one: "football", many: "footballs", gbp: 15 },
    { id: "football_boots", emoji: "👟", art: "a", one: "pair of football boots", many: "pairs of football boots", gbp: 55 },
    { id: "footy_badge", emoji: "📌", art: "a", one: "football pin badge", many: "football pin badges", gbp: 4 },
    { id: "mf_tractor", emoji: "🚜", art: "a", one: "used Massey Ferguson tractor", many: "used Massey Ferguson tractors", gbp: 20000 },
    { id: "mf_toy", emoji: "🚜", art: "a", one: "Massey Ferguson toy tractor", many: "Massey Ferguson toy tractors", gbp: 30 },
    { id: "mf_cap", emoji: "🧢", art: "a", one: "Massey Ferguson cap", many: "Massey Ferguson caps", gbp: 18 },
    { id: "mf_keyring", emoji: "🔑", art: "a", one: "Massey Ferguson keyring", many: "Massey Ferguson keyrings", gbp: 8 },
    { id: "mf_sign", emoji: "🪧", art: "a", one: "Massey Ferguson workshop sign", many: "Massey Ferguson workshop signs", gbp: 25 },
    { id: "pedal_tractor", emoji: "🚜", art: "a", one: "pedal tractor", many: "pedal tractors", gbp: 130 },
    { id: "vbucks_800", emoji: "🪙", art: "an", one: "800 V-Bucks pack", many: "800 V-Bucks packs", gbp: 7 },
    { id: "battle_pass", emoji: "🎟️", art: "a", one: "Fortnite Battle Pass", many: "Fortnite Battle Passes", gbp: 7 },
    { id: "vbucks_2400", emoji: "🪙", art: "a", one: "2,400 V-Bucks pack", many: "2,400 V-Bucks packs", gbp: 17.5 },
    { id: "vbucks_4500", emoji: "🪙", art: "a", one: "4,500 V-Bucks pack", many: "4,500 V-Bucks packs", gbp: 28 },
    { id: "vbucks_12500", emoji: "🪙", art: "a", one: "12,500 V-Bucks pack", many: "12,500 V-Bucks packs", gbp: 70 },
    { id: "ps5_digital", emoji: "🎮", art: "a", one: "PS5 Digital Edition", many: "PS5 Digital Editions", gbp: 520 },
    { id: "ps5", emoji: "🎮", art: "a", one: "PlayStation 5", many: "PlayStation 5s", gbp: 570 },
    { id: "ps5_pro", emoji: "🎮", art: "a", one: "PS5 Pro", many: "PS5 Pros", gbp: 790 },
    { id: "dualsense", emoji: "🎮", art: "a", one: "DualSense controller", many: "DualSense controllers", gbp: 55 },
    { id: "ps5_game", emoji: "💿", art: "a", one: "PlayStation 5 game", many: "PlayStation 5 games", gbp: 60 }
  ];

  function funTotalNum() {
    var t = S.boot && S.boot.funTotal;
    return t && typeof t.total === 'number' && isFinite(t.total) ? t.total : null;
  }
  function funUnitIndex() {
    var i = parseInt(LS.get('kidFunUnit') || '0', 10);
    if (!(i >= 0 && i < FUN_UNITS.length)) i = 0;
    return i;
  }
  function pickFunUnitRandom() {
    if (!FUN_UNITS.length) return;
    LS.set('kidFunUnit', String(Math.floor(Math.random() * FUN_UNITS.length)));
  }
  function setFunUnitIndex(i, dir) {
    var n = FUN_UNITS.length;
    i = ((i % n) + n) % n;
    LS.set('kidFunUnit', String(i));
    paintFunWorth(dir || 0);
  }
  function funPhrase(n, u) {
    var art = u.art || 'a', one = u.one, many = u.many;
    var about = function (s) { return 'about ' + s; };
    if (n >= 20) return about(Math.round(n).toLocaleString('en-GB') + ' ' + many);
    if (n >= 2) {
      var half = Math.round(n * 2) / 2;
      if (half === Math.round(half)) return about(Math.round(half) + ' ' + many);
      return about(Math.floor(half) + ' and a half ' + many);
    }
    if (n >= 1.25) return about('one and a half ' + many);
    if (n >= 0.75) return about(art + ' ' + one);
    if (n >= 0.4) return about('half ' + art + ' ' + one);
    if (n >= 0.28) return about('a third of ' + art + ' ' + one);
    if (n >= 0.15) return about('a quarter of ' + art + ' ' + one);
    if (n > 0) return 'a little bit of ' + art + ' ' + one;
    return 'a few treasures, and growing';
  }
  function funSlideInner() {
    var total = funTotalNum();
    if (total == null) return '';
    var u = FUN_UNITS[funUnitIndex()];
    var count = u.gbp ? total / u.gbp : 0;
    var nShow = count >= 1 ? Math.min(8, Math.max(1, Math.round(Math.min(count, 8)))) : 1;
    var em = '';
    for (var i = 0; i < nShow; i++) em += u.emoji;
    var line = 'Our collection is worth ' + funPhrase(count, u) + '! ' + u.emoji;
    return '<div class="funEmojis" aria-hidden="true">' + em + '</div><p class="funLine">' + esc(line) + '</p>';
  }
  function funWorthHtml() {
    if (funTotalNum() == null) return '';
    return '<div class="funWorth" id="funWorth">' +
      '<p class="funLabel">What\u2019s our collection worth?</p>' +
      '<div class="funViewport"><div class="funSlide">' + funSlideInner() + '</div></div>' +
      '<p class="funHint">Swipe or tap to try another</p></div>';
  }
  var FUN_ANIM = { busy: false, ignoreTap: false };
  function paintFunWorth(dir) {
    var view = document.querySelector('#funWorth .funViewport');
    if (!view) return;
    var next = document.createElement('div');
    next.className = 'funSlide';
    next.innerHTML = funSlideInner();
    var old = view.querySelector('.funSlide');
    if (!old || !dir || FUN_ANIM.busy) {
      view.innerHTML = '';
      view.appendChild(next);
      FUN_ANIM.busy = false;
      return;
    }
    FUN_ANIM.busy = true;
    view.style.minHeight = old.offsetHeight + 'px';
    next.classList.add(dir > 0 ? 'funFromRight' : 'funFromLeft');
    view.appendChild(next);
    old.classList.add(dir > 0 ? 'funToLeft' : 'funToRight');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        next.classList.add('funIn');
        old.classList.add('funOut');
      });
    });
    var done = function () {
      if (old && old.parentNode) old.parentNode.removeChild(old);
      next.classList.remove('funFromRight', 'funFromLeft', 'funIn');
      view.style.minHeight = '';
      FUN_ANIM.busy = false;
    };
    var t = setTimeout(done, 380);
    next.addEventListener('transitionend', function (e) {
      if (e.propertyName && e.propertyName.indexOf('transform') < 0) return;
      clearTimeout(t); done();
    }, { once: true });
  }
  function cycleFunWorth(dir) {
    if (funTotalNum() == null) return;
    dir = dir || 1;
    if (FUN_ANIM.busy) return;
    setFunUnitIndex(funUnitIndex() + dir, dir);
    if (S.kid) bumpKid('kidWorthSwipes');
  }
  function bindFunSwipe() {
    var root = document.getElementById('funWorth');
    if (!root || root.getAttribute('data-fun-bound') === '1') return;
    root.setAttribute('data-fun-bound', '1');
    var st = { down: false, x: 0, y: 0, axis: '', dragging: false };
    var view, slide;
    function grab() {
      view = root.querySelector('.funViewport');
      slide = view ? view.querySelector('.funSlide:last-child') : null;
    }
    function start(x, y) {
      if (FUN_ANIM.busy) return;
      st.down = true; st.x = x; st.y = y; st.axis = ''; st.dragging = false;
      grab();
    }
    function move(x, y, ev) {
      if (!st.down || FUN_ANIM.busy) return;
      var dx = x - st.x, dy = y - st.y;
      if (!st.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (st.axis === 'y') { st.down = false; return; }
      }
      if (st.axis !== 'x') return;
      st.dragging = true;
      if (ev && ev.cancelable) ev.preventDefault();
      if (slide) {
        slide.style.transition = 'none';
        slide.style.transform = 'translateX(' + dx + 'px)';
      }
    }
    function end(x) {
      if (!st.down) return;
      st.down = false;
      var dx = x - st.x;
      if (slide) { slide.style.transition = ''; slide.style.transform = ''; }
      if (st.axis === 'x' && Math.abs(dx) >= 40) {
        FUN_ANIM.ignoreTap = true;
        cycleFunWorth(dx < 0 ? 1 : -1);
        setTimeout(function () { FUN_ANIM.ignoreTap = false; }, 400);
      }
    }
    root.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0]; start(t.clientX, t.clientY);
    }, { passive: true });
    root.addEventListener('touchmove', function (e) {
      var t = e.changedTouches[0]; move(t.clientX, t.clientY, e);
    }, { passive: false });
    root.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0]; end(t.clientX);
    }, { passive: true });
    root.addEventListener('touchcancel', function () { st.down = false; if (slide) { slide.style.transition = ''; slide.style.transform = ''; } }, { passive: true });
    root.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.funArrow')) return;
      start(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) {
      if (!st.down) return;
      move(e.clientX, e.clientY, e);
    });
    window.addEventListener('mouseup', function (e) {
      if (!st.down) return;
      end(e.clientX);
    });
    root.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.funArrow')) return;
      if (FUN_ANIM.ignoreTap || FUN_ANIM.busy || st.dragging) { st.dragging = false; return; }
      cycleFunWorth(1);
    });
  }

  var RW = null;
  function rwIsActive(x) {
    if (!x) return false;
    var v = x.active;
    if (v === false || v == null || v === '') return false;
    if (v === true) return true;
    return !/^(no|false|0|off)$/i.test(String(v).trim());
  }
  function rwArr(x) { return Array.isArray(x) ? x : []; }
  function sortByCost(list) {
    return rwArr(list).slice().sort(function (a, b) {
      return ((a && a.cost) || 0) - ((b && b.cost) || 0) || String((a && a.title) || '').localeCompare(String((b && b.title) || ''));
    });
  }
  /* Same live list Son sees: active rewards only, no local/hardcoded defaults. */
  function activeRewards(r) {
    if (!r) return [];
    var all = rwArr(r.allRewards);
    if (all.length) return sortByCost(all.filter(rwIsActive));
    return sortByCost(r.rewards);
  }
  function forgetRewardsCache(keepKey) {
    return IDB.keys().then(function (keys) {
      return Promise.all((keys || []).filter(function (k) {
        return String(k).indexOf('c|getRewards|') === 0 && k !== keepKey;
      }).map(function (k) { return IDB.del(k); }));
    }, function () { return null; });
  }
  function forgetAllRewardsCache() {
    return IDB.keys().then(function (keys) {
      return Promise.all((keys || []).filter(function (k) {
        return String(k).indexOf('c|getRewards|') === 0;
      }).map(function (k) { return IDB.del(k); }));
    }, function () { return null; });
  }
  function loadRewards(force) {
    if (RW && !force && navigator.onLine === false) return Promise.resolve(RW);
    RW = force ? null : RW;
    if (RW && !force) return Promise.resolve(RW);
    return call('getRewards', S.kid ? KID_ROLE : S.role).then(function (r) {
      RW = r;
      forgetRewardsCache(cacheKey('getRewards', [S.kid ? KID_ROLE : S.role])).catch(noop);
      return r;
    });
  }
  function niceWhen(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
    catch (e) { return String(iso).slice(0, 16); }
  }
  function rwAction(a) {
    return ({ photo: 'Photo', found: 'Ticked off a find', update: 'Updated something', add: 'New item', streak: '3-day streak bonus', job: 'Job done' })[a] || a;
  }
  function nextRewardGoal(r) {
    var list = activeRewards(r), bal = (r && r.balance) || 0, i;
    for (i = 0; i < list.length; i++) {
      if ((list[i].cost || 0) > bal) return { item: list[i], need: list[i].cost - bal, canAsk: false };
    }
    if (list.length) return { item: list[list.length - 1], need: 0, canAsk: true };
    return null;
  }
  function rewardEmoji(t) {
    var s = String(t || '').toLowerCase();
    if (/cinema/.test(s)) return '\uD83C\uDF7F';
    if (/film|movie|friday/.test(s)) return '\uD83C\uDFAC';
    if (/sweet|treat/.test(s)) return '\uD83C\uDF6C';
    if (/chore/.test(s)) return '\uD83E\uDDF9';
    if (/stay up|later|bedtime/.test(s)) return '\uD83C\uDF19';
    if (/takeaway/.test(s)) return '\uD83C\uDF55';
    if (/bowl|soft play/.test(s)) return '\uD83C\uDFB3';
    if (/blind box/.test(s)) return '\uD83C\uDF81';
    if (/ebay|hunt down/.test(s)) return '\uD83D\uDD0D';
    if (/wanted list|simpsons item/.test(s)) return '\uD83D\uDCCB';
    if (/family day/.test(s)) return '\uD83C\uDFA1';
    if (/day out/.test(s)) return '\uD83D\uDE97';
    return '\u2B50';
  }
  function rwPct(bal, cost) {
    if (!cost || cost <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round(100 * (bal || 0) / cost)));
  }
  function rewardsHomeCardHtml(r, kid) {
    if (!r) return '';
    var list = activeRewards(r), bal = r.balance || 0, nxt = nextRewardGoal(r);
    var bits = [];
    if (!kid && r.queue && r.queue.length) bits.push(r.queue.length + ' photo' + (r.queue.length === 1 ? '' : 's') + ' waiting');
    if (!kid && r.pendingRequests && r.pendingRequests.length) bits.push(r.pendingRequests.length + ' reward' + (r.pendingRequests.length === 1 ? '' : 's') + ' to decide');
    var h = '<div class="card yel rwHomeCard"><h2>\u2B50 ' + (kid ? 'My rewards' : esc(KID_ROLE) + '\u2019s rewards') + '</h2>' +
      '<p class="funSub">' + bal + ' point' + (bal === 1 ? '' : 's') + ' to spend' +
      ((r.level && r.level.name) ? ' \u00B7 ' + esc(r.level.name) : '') +
      (bits.length ? ' \u00B7 ' + bits.join(' \u00B7 ') : '') + '</p>';
    if (nxt && nxt.item) {
      var heroPct = nxt.canAsk ? 100 : rwPct(bal, nxt.item.cost);
      h += '<div class="rwHero' + (nxt.canAsk ? ' ready' : '') + '">' +
        '<div class="rwHeroEyebrow">' + (nxt.canAsk ? 'Ready to ask' : 'Next up') + '</div>' +
        '<div class="rwHeroEmoji" aria-hidden="true">' + rewardEmoji(nxt.item.title) + '</div>' +
        '<h3 class="rwHeroTitle">' + esc(nxt.item.title) + '</h3>' +
        '<div class="rwHeroBar" aria-hidden="true"><i data-w="' + heroPct + '%"></i></div>' +
        '<div class="rwHeroMeta"><span class="rwHeroBadge' + (nxt.canAsk ? ' ready' : '') + '">' +
        (nxt.canAsk ? 'Ready to ask!' : nxt.need + ' more points!') + '</span>' +
        '<span class="pill">' + nxt.item.cost + ' pts</span></div></div>';
    } else {
      h += '<p class="hint">Dad hasn\u2019t set any rewards yet.</p>';
    }
    var rest = list.filter(function (x) { return !nxt || !nxt.item || x.id !== nxt.item.id; });
    if (!rest.length && list.length > 1 && nxt && nxt.item) {
      rest = list.filter(function (x) { return x.title !== nxt.item.title; });
    }
    if (rest.length) {
      var shown = 4;
      h += '<div class="rwPrizeGrid">';
      rest.forEach(function (x, i) {
        var pending = kid && rwArr(r.requests).some(function (q) { return q.title === x.title && q.status === 'Pending'; });
        var unlocked = (x.cost || 0) <= bal;
        var pct = rwPct(bal, x.cost);
        var cls = 'rwPrize' + (unlocked ? ' ready' : ' locked') + (i >= shown ? ' more' : '');
        h += '<div class="' + cls + '">' +
          (unlocked ? '' : '<span class="rwPrizeLock" aria-hidden="true">\uD83D\uDD12</span>') +
          '<div class="rwPrizeEm" aria-hidden="true">' + rewardEmoji(x.title) + '</div>' +
          '<b>' + esc(x.title) + '</b>' +
          '<div class="rwMiniBar" aria-hidden="true"><i data-w="' + pct + '%"></i></div>' +
          '<div class="rwPrizeMeta"><span class="pill">' + x.cost + ' pts</span>' +
          (pending ? '<span class="pill yel">Asked</span>' : (unlocked ? '<span class="pill green">Ready</span>' : '')) +
          '</div></div>';
      });
      h += '</div>';
      if (rest.length > shown) h += '<button type="button" class="btn rwSeeAll" data-act="rwSeeAll" aria-expanded="false">See all</button>';
    }
    if (kid) h += '<button type="button" class="btn main" data-act="go" data-to="kidRewards">Open my points</button>';
    else if (isPriv()) h += '<button type="button" class="btn main" data-act="go" data-to="rewards">Open rewards</button>';
    h += '</div>';
    return h;
  }
  function paintRewardBars(box) {
    if (!box) return;
    requestAnimationFrame(function () {
      var bars = box.querySelectorAll('.rwHeroBar > i, .rwMiniBar > i');
      for (var i = 0; i < bars.length; i++) {
        (function (el) {
          var w = el.getAttribute('data-w') || '0%';
          el.style.width = '0%';
          requestAnimationFrame(function () { el.style.width = w; });
        })(bars[i]);
      }
    });
  }
  function paintRewardsHome(r) {
    var box = $('kidRewardsHome') || $('homeRewards') || $('rwHomeTile');
    if (!box || !r) return;
    try { box.innerHTML = rewardsHomeCardHtml(r, !!S.kid); paintRewardBars(box); }
    catch (e) { box.innerHTML = '<div class="card yel"><h2>\u2B50 Rewards</h2><p class="hint">Couldn\u2019t show the list just now. Try refresh.</p></div>'; }
  }
  function rwLevelCard(r) {
    var lv = r.level || {}, nextAt = lv.nextAt, have = r.earned || 0, min = lv.min || 0;
    var span = nextAt ? (nextAt - min) : 1, done = nextAt ? Math.min(1, (have - min) / span) : 1;
    return '<div class="card yel ptsCard center"><div class="hint">' + esc(lv.name || '') + '</div><div class="big">' + (r.balance || 0) + '</div><div class="hint">points to spend' +
      (r.held ? ' \u00B7 ' + r.held + ' waiting on Dad' : '') + '</div>' +
      '<div class="ptsBar" aria-hidden="true"><i style="width:' + Math.round(100 * done) + '%"></i></div>' +
      '<p class="hint">' + (lv.next ? (nextAt - have) + ' more to become ' + esc(lv.next) : 'Top level! Comic Book Guy would be proud.') +
      (r.streak ? '<br>' + (r.helpedToday ? r.streak + ' day' + (r.streak === 1 ? '' : 's') + ' in a row' + (r.streak >= 3 ? ' \u2014 streak bonus unlocked!' : '. Keep going for a bonus at 3.') : 'Help today to keep your ' + r.streak + '-day streak') : '') +
      '</p></div>';
  }
  function rwNeedOk() {
    return '<div class="nudge">This bit needs a quick update on the collection sheet (version 4.4). Until then, photos and the rest of the app still work as usual.</div>';
  }

  SCREENS.kidRewards = function () {
    busy('Counting your points\u2026');
    loadBoot().then(function () { return loadRewards(true); }).then(function (r) {
      done();
      var rewards = activeRewards(r).map(function (x) {
        var pending = rwArr(r.requests).some(function (q) { return q.title === x.title && q.status === 'Pending'; });
        var need = x.cost - (r.balance || 0);
        var btn = pending ? '<span class="pill yel">Asked \u2014 waiting for Dad</span>' :
          (need > 0 ? '<span class="hint">' + need + ' more points to go</span>' :
            '<button class="btn main" data-act="rwAsk" data-id="' + esc(x.id) + '">Ask Dad</button>');
        return '<div class="rwItem"><div class="row"><b>' + esc(x.title) + '</b><span class="pill">' + x.cost + ' pts</span></div>' + btn + '</div>';
      }).join('');
      var reqs = rwArr(r.requests).length ? '<h2>Your asks</h2><div class="rwList">' + rwArr(r.requests).map(function (q) {
        return '<div class="rwItem"><b>' + esc(q.title) + '</b><small>' + esc(q.status) + (q.when ? ' \u00B7 ' + esc(niceWhen(q.when)) : '') + '</small></div>';
      }).join('') + '</div>' : '';
      var recent = '';
      try {
        recent = rwArr(r.recent).length ? '<h2>Lately</h2><div class="list rwLog">' + rwArr(r.recent).slice(0, 12).map(function (x) {
          return '<div class="li"><div class="grow">' + esc(rwAction(x.action)) + (x.item ? '<small>' + esc(x.item) + '</small>' : '') + '</div><span class="pill">' + (x.points > 0 ? '+' : '') + x.points + '</span></div>';
        }).join('') + '</div>' : '';
      } catch (eRec) { recent = ''; }
      var extra = '';
      try {
        var photo = ptsVal(r, 'photo', 10);
        extra += (r.waiting ? '<div class="nudge">Dad is having a look at ' + r.waiting + ' photo' + (r.waiting === 1 ? '' : 's') + '. You get ' + photo + ' point' + (photo === 1 ? '' : 's') + ' for each one he says yes to.</div>' : '');
      } catch (eWait) { /* keep rewards visible */ }
      try { extra += waysToEarnHtml(r, true) || ''; } catch (eJobs) { /* keep rewards visible */ }
      setMain(backBtn() + '<h1>\u2B50 My points</h1>' + rwLevelCard(r) + extra +
        '<h2>Rewards you can ask for</h2><div class="rwList">' +
        (rewards || '<p class="hint">Dad hasn\u2019t set any rewards yet.</p>') + '</div>' + reqs + recent);
    }).catch(function (e) { done(); setMain(backBtn() + '<h1>\u2B50 My points</h1>' + rwNeedOk()); });
  };

  SCREENS.rewards = function () {
    if (!isPriv()) { go('home', {}, true); return; }
    busy('Getting the rewards\u2026');
    loadRewards(true).then(function (r) {
      done();
      var q = (r.queue || []).map(function (p) {
        return '<div class="rwItem" data-qid="' + esc(p.id) + '"><div class="qThumb" id="qth-' + esc(p.id) + '"><span class="thWait"></span></div>' +
          '<b>' + esc(p.item) + '</b><small>' + esc([p.label, niceWhen(p.when)].filter(Boolean).join(' \u00B7 ')) + '</small>' +
          '<label class="field" style="font-weight:700"><input type="checkbox" class="qMain" checked> Make this the main photo</label>' +
          '<div class="row"><button class="btn green" data-act="rwPhotoYes" data-id="' + esc(p.id) + '">Yes, it\u2019s in</button>' +
          '<button class="btn" data-act="rwPhotoNo" data-id="' + esc(p.id) + '">Not this time</button></div></div>';
      }).join('');
      var asks = (r.pendingRequests || []).map(function (x) {
        return '<div class="rwItem"><div class="row"><b>' + esc(x.title) + '</b><span class="pill">' + x.cost + ' pts</span></div><small>' + esc(niceWhen(x.when)) + '</small>' +
          '<div class="row"><button class="btn green" data-act="rwYes" data-id="' + esc(x.id) + '">Yes (PIN)</button>' +
          '<button class="btn" data-act="rwNo" data-id="' + esc(x.id) + '">Not this time (PIN)</button></div></div>';
      }).join('');
      var pendingJobs = (r.pendingJobs || []).map(function (x) {
        return '<div class="rwItem" data-id="' + esc(x.id) + '" data-title="' + esc(x.title) + '" data-cost="' + esc(x.cost) + '"><div class="row"><b>' + esc(x.title) + '</b><span class="pill">+' + x.cost + '</span></div><small>' + esc(niceWhen(x.when)) + '</small>' +
          '<div class="row"><button class="btn green" data-act="jobYes" data-id="' + esc(x.id) + '">Yes, approve (PIN)</button>' +
          '<button class="btn" data-act="jobNo" data-id="' + esc(x.id) + '">Not this time (PIN)</button></div></div>';
      }).join('');
      var jobRows = '';
      try {
        jobRows = sortJobsList(rwArr(r.allJobs).filter(function (x) { return !x.kind || x.kind !== 'collection'; })).map(function (x) {
          var doneBtn = x.doneToday ? '<span class="pill yel">Done today</span>' :
            (x.pending ? '<span class="pill yel">Waiting for Dad</span>' : '<span class="hint">Son ticks this when it\u2019s done</span>');
          return '<div class="rwItem" data-id="' + esc(x.id) + '"><p class="rwEditHead">Edit this job</p>' +
            '<div class="row wrap ptsEmojiRow"><label class="field ptsEmojiField">Icon <input type="text" class="jobIcon" maxlength="8" value="' + esc(x.icon || x.emoji || '') + '" placeholder="auto" autocomplete="off"></label>' +
            '<label class="field grow">Job name <input type="text" class="jobTitle" data-id="' + esc(x.id) + '" value="' + esc(x.title) + '" maxlength="60" autocomplete="off"></label></div>' +
            '<label class="field">Points <input type="number" class="jobCost" data-id="' + esc(x.id) + '" value="' + x.cost + '" min="5" step="5"></label>' +
            '<label class="rwOnRow"><input type="checkbox" class="jobOn" data-id="' + esc(x.id) + '"' + (rwIsActive(x) ? ' checked' : '') + '> On the list</label>' +
            '<div class="row" style="margin-top:8px">' + doneBtn + '</div></div>';
        }).join('');
      } catch (eJobs) { jobRows = ''; }
      function rewardEditRow(x, on) {
        return '<div class="rwItem' + (on ? '' : ' rwOff') + '" data-id="' + esc(x.id) + '"><p class="rwEditHead">' + (on ? 'On the list' : 'Off the list') + '</p>' +
          '<label class="field">Reward name <input type="text" class="rwTitle" data-id="' + esc(x.id) + '" value="' + esc(x.title) + '" maxlength="60" autocomplete="off"></label>' +
          '<label class="field">Points needed <input type="number" class="rwCost" data-id="' + esc(x.id) + '" value="' + x.cost + '" min="5" step="5"></label>' +
          '<label class="rwOnRow"><input type="checkbox" class="rwOn" data-id="' + esc(x.id) + '"' + (on ? ' checked' : '') + '> On the list</label></div>';
      }
      var editorSrc = rwArr(r.allRewards);
      if (!editorSrc.length) editorSrc = activeRewards(r).map(function (x) { return { id: x.id, title: x.title, cost: x.cost, active: true }; });
      var onList = sortByCost(editorSrc.filter(rwIsActive));
      var offList = sortByCost(editorSrc.filter(function (x) { return !rwIsActive(x); }));
      var all = onList.map(function (x) { return rewardEditRow(x, true); }).join('');
      var allOff = offList.map(function (x) { return rewardEditRow(x, false); }).join('');
      var pts = (r.points || {});
      var log = (r.log || []).slice(0, 80).map(function (x) {
        return '<div class="li"><div class="grow">' + esc(rwAction(x.action)) + (x.item ? '<small>' + esc(x.item) + (x.detail ? ' \u00B7 ' + esc(x.detail) : '') + '</small>' : (x.detail ? '<small>' + esc(x.detail) + '</small>' : '')) +
          '<small>' + esc(niceWhen(x.when)) + '</small></div><span class="pill">' + (x.points > 0 ? '+' : '') + x.points + '</span></div>';
      }).join('');
      setMain(backBtn() + '<h1>\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</h1>' +
        '<div class="card skyL"><b>' + (r.earned || 0) + '</b> points earned \u00B7 <b>' + (r.balance || 0) + '</b> to spend \u00B7 ' + esc((r.level && r.level.name) || '') +
        (r.streak ? ' \u00B7 ' + r.streak + '-day streak' : '') + '</div>' +
        '<h2>Photos waiting</h2>' + (q ? '<div class="rwList">' + q + '</div>' : '<p class="hint">None waiting \u2014 you\u2019re all caught up.</p>') +
        '<h2>Reward asks</h2>' + (asks ? '<div class="rwList">' + asks + '</div>' : '<p class="hint">No asks waiting.</p>') +
        '<h2>Jobs waiting</h2>' + (pendingJobs ? '<div class="rwList">' + pendingJobs + '</div>' : '<p class="hint">None waiting \u2014 you\u2019re all caught up.</p>') +
        '<h2>Jobs</h2><p class="hint">Give each job a name and points. Son ticks a job when it\u2019s done; you approve it with your PIN and the points are added (once per job per day). Switch one off rather than deleting it. No money in the names, please.</p><div class="rwList" id="jobEdit">' + jobRows + '</div>' +
        '<p><button type="button" class="rwAdd" data-act="jobAdd">+ Add job</button></p>' +
        '<h2>Rewards he can ask for</h2><p class="hint">This is the same live list he sees, from the App - Rewards sheet. Tick \u201COn the list\u201D to show or hide one. Switch one off rather than deleting it. No money in the names, please.</p><div class="rwList" id="rwEdit">' + (all || '<p class="hint">No active rewards yet.</p>') + '</div>' +
        (allOff ? '<h2>Off the list</h2><p class="hint">Hidden from him until you tick them back on. Nothing is deleted.</p><div class="rwList rwOffList" id="rwEditOff">' + allOff + '</div>' : '') +
        '<p><button type="button" class="rwAdd" data-act="rwAdd">+ Add reward</button></p>' +
        pointRulesEditorHtml(r) +
        '<p class="center"><button class="btn main" data-act="rwSave" id="rwSaveBtn">Save</button></p>' +
        '<h2>Activity log</h2><div class="list rwLog">' + (log || '<p class="hint">Nothing yet.</p>') + '</div>');
      (r.queue || []).forEach(function (p) {
        call('getQueuePhoto', p.id, S.role).then(function (ph) {
          var box = $('qth-' + p.id); if (!box) return;
          if (ph && ph.video && !ph.thumb) { box.innerHTML = '\uD83C\uDFAC'; return; }
          if (ph && ph.thumb) shrinkThumb(ph.thumb).then(function (s) { if ($('qth-' + p.id)) $('qth-' + p.id).innerHTML = s ? '<img alt="" src="' + s + '">' : '\uD83D\uDCF7'; });
          else box.innerHTML = '\uD83D\uDCF7';
        }).catch(function () { var box = $('qth-' + p.id); if (box) box.innerHTML = '\uD83D\uDCF7'; });
      });
    }).catch(function (e) { done(); setMain(backBtn() + '<h1>\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</h1>' + rwNeedOk()); });
  };

  function askReward(id) {
    if (!id) return;
    confirmSheet('Ask Dad?', 'He\u2019ll get this on his rewards page, and the points are held until he says yes or no.', 'Yes, ask him', 'Not now').then(function (ok) {
      if (!ok) return;
      busy('Sending to Dad\u2026');
      return call('requestReward', id, KID_ROLE).then(function () {
        done(); RW = null; toast('Asked! Dad will take a look.', 'good'); go('kidRewards', {}, true);
      });
    }).catch(oops);
  }
  function decideRewardUI(id, yes) {
    if (!id) return;
    var wrap = sheet('Dad\u2019s PIN', '<p class="hint">Needed each time you ' + (yes ? 'approve' : 'say no to') + ' a reward.</p><input id="rwPin" type="password" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="\u2022\u2022\u2022\u2022">',
      [{ label: yes ? 'Yes, approve' : 'No, not this time', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]);
    setTimeout(function () { var i = $('rwPin'); if (i) i.focus(); }, 50);
    wrap.then(function (v) {
      var pin = ($('rwPin') && $('rwPin').value) || '';
      if (v !== 'go') return;
      if (!/^\d{4}$/.test(pin)) { toast('That needs to be the 4-digit PIN.', 'oops'); return; }
      busy(yes ? 'Approving\u2026' : 'Saving\u2026');
      return call('decideReward', id, !!yes, pin, S.role).then(function (r) {
        done(); RW = null; toast(r.status === 'Approved' ? 'Approved \u2014 points spent.' : 'Okay, not this time. The points go back.', 'good'); go('rewards', {}, true);
      });
    }).catch(oops);
  }
  function decidePhotoUI(id, yes, makeMain) {
    if (!id) return;
    var title = yes ? 'Add this photo to the item?' : 'Say no to this photo?';
    var body = yes ? 'It moves into the item\u2019s folder and he gets 10 points. Nothing else is changed.' : 'The file stays in the waiting folder (nothing is deleted) and no points are given.';
    confirmSheet(title, body, yes ? 'Yes, it\u2019s in' : 'Not this time', 'Cancel').then(function (ok) {
      if (!ok) return;
      busy(yes ? 'Adding it to the folder\u2026' : 'Saving\u2026');
      return call('decidePhoto', id, !!yes, !!makeMain, S.role).then(function (r) {
        done(); RW = null;
        if (yes && r.folderId) { updateFolder(r.key, r.folderId); forgetThumb(r.folderId); }
        pointsNote(r, yes ? 'It\u2019s in the folder.' : 'Left in the waiting folder \u2014 nothing deleted.');
        go('rewards', {}, true);
      });
    }).catch(oops);
  }
  function addRewardRow() {
    var box = $('rwEdit'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'rwItem';
    el.innerHTML = '<p class="rwEditHead">New reward</p>' +
      '<label class="field">Reward name <input type="text" class="rwTitle" maxlength="60" placeholder="e.g. Pick the next film" autocomplete="off"></label>' +
      '<label class="field">Points needed <input type="number" class="rwCost" min="5" step="5" value="100"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="rwOn" checked> On the list</label>';
    box.appendChild(el);
    var inp = el.querySelector('.rwTitle'); if (inp) inp.focus();
    var btn = $('rwSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }
  function addJobRow() {
    var box = $('jobEdit'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'rwItem';
    el.innerHTML = '<p class="rwEditHead">New job</p>' +
      '<div class="row wrap ptsEmojiRow"><label class="field ptsEmojiField">Icon <input type="text" class="jobIcon" maxlength="8" placeholder="auto" autocomplete="off"></label>' +
      '<label class="field grow">Job name <input type="text" class="jobTitle" maxlength="60" placeholder="e.g. Clean your room" autocomplete="off"></label></div>' +
      '<label class="field">Points <input type="number" class="jobCost" min="5" step="5" value="50"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="jobOn" checked> On the list</label>';
    box.appendChild(el);
    sortJobEditor();
    var inp = el.querySelector('.jobTitle'); if (inp) inp.focus();
    var btn = $('rwSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }

  var POINT_RULE_DEFAULTS = [
    { key: 'photo', title: 'Add a photo', desc: 'Snap one of our things. You get the points when Dad says yes.', emoji: '\uD83D\uDCF8', pts: 10 },
    { key: 'found', title: 'Tick one off the Hunt', desc: 'Found it on Hunt or Wanted? Mark it ours.', emoji: '\u2B50', pts: 5 },
    { key: 'update', title: 'Update a thing', desc: 'Help fill in details on something we already have.', emoji: '\u270F\uFE0F', pts: 5 },
    { key: 'add', title: 'Add a new find', desc: 'Save something new to our collection.', emoji: '\uD83D\uDCE6', pts: 20 },
    { key: 'streak', title: '3-day helper bonus', desc: 'Help on 3 days in a row and get a bonus on top.', emoji: '\uD83D\uDD25', pts: 15 }
  ];
  function builtInPointRules(r) {
    var saved = rwArr(r && r.pointRules);
    var byKey = {};
    saved.forEach(function (x) { if (x && x.key) byKey[x.key] = x; });
    return POINT_RULE_DEFAULTS.map(function (d) {
      var s = byKey[d.key] || {};
      return {
        key: d.key, auto: true,
        title: s.title || d.title,
        desc: s.desc || d.desc,
        emoji: s.emoji || d.emoji,
        pts: (s.pts != null ? s.pts : ptsVal(r, d.key, d.pts)),
        active: s.active !== false
      };
    });
  }
  function customCollectionJobs(r, includeOff) {
    var list = rwArr(r && (includeOff ? (r.allCollectionJobs || r.collectionJobs) : (r.collectionJobs || r.allCollectionJobs)));
    if (!includeOff) list = list.filter(function (j) { return j && j.active !== false; });
    return list.map(function (j) {
      return { id: j.id, key: j.id, auto: false, title: j.title, desc: j.desc || '', emoji: j.emoji || '\uD83C\uDFA5', pts: j.cost, cost: j.cost, active: j.active !== false, pending: j.pending, pendingId: j.pendingId, doneToday: j.doneToday };
    });
  }
  function pointRuleRowHtml(x) {
    var auto = !!x.auto;
    return '<div class="rwItem' + (x.active === false ? ' rwOff' : '') + '" data-key="' + esc(x.key || '') + '" data-id="' + esc(x.id || '') + '" data-auto="' + (auto ? '1' : '0') + '">' +
      '<p class="rwEditHead">' + (auto ? 'Automatic' : 'Son taps, you approve') + '</p>' +
      '<div class="row wrap ptsEmojiRow"><label class="field ptsEmojiField">Icon <input type="text" class="ptsEmoji" maxlength="8" placeholder="auto" value="' + esc(x.emoji || '') + '" autocomplete="off"></label>' +
      '<label class="field grow">Name <input type="text" class="ptsTitle" maxlength="60" value="' + esc(x.title || '') + '" autocomplete="off"></label></div>' +
      '<label class="field">Description <input type="text" class="ptsDesc" maxlength="160" value="' + esc(x.desc || '') + '" autocomplete="off"></label>' +
      '<label class="field">Points <input type="number" class="ptsCost" min="' + (auto ? '0' : '5') + '" step="1" value="' + (x.pts != null ? x.pts : (auto ? 0 : 15)) + '"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="ptsOn"' + (x.active !== false ? ' checked' : '') + '> On the list</label></div>';
  }
  function pointRulesEditorHtml(r) {
    var built = builtInPointRules(r);
    var custom = customCollectionJobs(r, true);
    var rows = sortJobsList(built.concat(custom).map(function (x) { return { title: x.title, cost: x.pts, _x: x }; })).map(function (s) { return pointRuleRowHtml(s._x); }).join('');
    return '<h2>Collection jobs</h2><p class="hint">The five automatic ones: change the name, the description and the points, or switch one off (it won\u2019t award, and Son won\u2019t see it). You can also add your own \u2014 Son taps them, you approve with your PIN. Switching off doesn\u2019t delete it.</p>' +
      '<div class="rwList" id="ptsEdit">' + rows + '</div>' +
      '<p><button type="button" class="rwAdd" data-act="ptsAdd">+ Add a collection job</button></p>';
  }
  function collectPointRulesForm() {
    var rules = [], customJobs = [], bad = '', incomplete = 0, payload = { photo: 10, found: 5, update: 5, add: 20, streak: 15 };
    document.querySelectorAll('#ptsEdit .rwItem').forEach(function (el) {
      var auto = el.getAttribute('data-auto') === '1';
      var key = el.getAttribute('data-key') || '';
      var title = ((el.querySelector('.ptsTitle') || {}).value || '').replace(/\s+/g, ' ').trim();
      var desc = ((el.querySelector('.ptsDesc') || {}).value || '').replace(/\s+/g, ' ').trim();
      var emoji = ((el.querySelector('.ptsEmoji') || {}).value || '').trim();
      var cost = parseInt((el.querySelector('.ptsCost') || {}).value, 10);
      var on = el.querySelector('.ptsOn');
      var active = on ? on.checked : true;
      if (/[\u00a3$\u20ac]|\b\d+\s*p\b|\bpounds?\b|\bquid\b|\bmoney\b|\bcash\b|\bdollars?\b|\beuros?\b|\bpence\b/i.test(title + ' ' + desc)) bad = 'Keep money out of the names and descriptions.';
      if (auto) {
        if (!title) { incomplete++; return; }
        if (!(cost >= 0 && cost <= 100000)) bad = bad || 'Points should be a whole number from 0 up.';
        var rec = { key: key, title: title, desc: desc, emoji: emoji, pts: cost, active: active };
        rules.push(rec);
        if (key) payload[key] = cost;
      } else {
        if (!title) { if ((el.querySelector('.ptsCost') || {}).value) incomplete++; return; }
        if (!(cost >= 5 && cost <= 100000)) bad = bad || 'Custom collection jobs need a whole number of points from 5 up.';
        customJobs.push({ id: el.getAttribute('data-id') || '', title: title, desc: desc, emoji: emoji || '\uD83C\uDFA5', cost: cost, active: active });
      }
    });
    payload.rules = rules;
    payload.customJobs = customJobs;
    return { payload: payload, rules: rules, customJobs: customJobs, bad: bad, incomplete: incomplete };
  }
  function sortPointRulesEditor() {
    var box = $('ptsEdit'); if (!box) return;
    var focus = document.activeElement;
    var rows = Array.prototype.slice.call(box.querySelectorAll('.rwItem'));
    var named = [], blank = [];
    rows.forEach(function (el) {
      var title = (((el.querySelector('.ptsTitle') || {}).value) || '').replace(/\s+/g, ' ').trim();
      (title ? named : blank).push(el);
    });
    named.sort(function (a, b) {
      var ca = parseInt(((a.querySelector('.ptsCost') || {}).value), 10) || 0;
      var cb = parseInt(((b.querySelector('.ptsCost') || {}).value), 10) || 0;
      if (ca !== cb) return ca - cb;
      var ta = (((a.querySelector('.ptsTitle') || {}).value) || '').trim();
      var tb = (((b.querySelector('.ptsTitle') || {}).value) || '').trim();
      return ta.localeCompare(tb, 'en', { sensitivity: 'base' });
    });
    named.concat(blank).forEach(function (el) { box.appendChild(el); });
    if (focus && box.contains(focus) && typeof focus.focus === 'function') {
      try { focus.focus(); } catch (eF) { /* ignore */ }
    }
  }
  function addPointRuleRow() {
    var box = $('ptsEdit'); if (!box) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = pointRuleRowHtml({ auto: false, title: '', desc: '', emoji: '\uD83C\uDFA5', pts: 15, active: true });
    box.appendChild(wrap.firstChild);
    sortPointRulesEditor();
    var inp = box.querySelector('.rwItem:last-child .ptsTitle'); if (inp) inp.focus();
    var btn = $('rwSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }

  function collectJobsForm() {
    var list = [], bad = '', incomplete = 0;
    document.querySelectorAll('#jobEdit .rwItem').forEach(function (el) {
      var titleEl = el.querySelector('.jobTitle'), costEl = el.querySelector('.jobCost');
      if (!titleEl || !costEl) return;
      var title = (titleEl.value || '').replace(/\s+/g, ' ').trim();
      var cost = parseInt(costEl.value, 10);
      var on = el.querySelector('.jobOn');
      var id = (titleEl.getAttribute('data-id') || el.getAttribute('data-id') || '');
      if (!title) { if (id || (costEl.value || '').trim()) incomplete++; return; }
      if (/[\u00a3$\u20ac]|\b\d+\s*p\b|\bpounds?\b|\bquid\b|\bmoney\b|\bcash\b|\bdollars?\b|\beuros?\b|\bpence\b/i.test(title)) bad = 'Keep money out of job names.';
      if (!(cost >= 5 && cost <= 100000)) bad = bad || 'Job points should be a whole number from 5 up.';
      var icon = ((el.querySelector('.jobIcon') || {}).value || '').trim();
      list.push({ id: id, title: title, cost: cost, active: on ? on.checked : true, icon: icon, emoji: icon });
    });
    return { list: list, bad: bad, incomplete: incomplete };
  }
  function sortJobsList(list) {
    return (list || []).slice().sort(function (a, b) {
      var ca = Number(a.cost) || 0, cb = Number(b.cost) || 0;
      if (ca !== cb) return ca - cb;
      return String(a.title || '').localeCompare(String(b.title || ''), 'en', { sensitivity: 'base' });
    });
  }
  function sortJobEditor() {
    var box = $('jobEdit'); if (!box) return;
    var focus = document.activeElement;
    var rows = Array.prototype.slice.call(box.querySelectorAll('.rwItem'));
    var named = [], blank = [];
    rows.forEach(function (el) {
      var title = (((el.querySelector('.jobTitle') || {}).value) || '').replace(/\s+/g, ' ').trim();
      (title ? named : blank).push(el);
    });
    named.sort(function (a, b) {
      var ca = parseInt(((a.querySelector('.jobCost') || {}).value), 10) || 0;
      var cb = parseInt(((b.querySelector('.jobCost') || {}).value), 10) || 0;
      if (ca !== cb) return ca - cb;
      var ta = (((a.querySelector('.jobTitle') || {}).value) || '').trim();
      var tb = (((b.querySelector('.jobTitle') || {}).value) || '').trim();
      return ta.localeCompare(tb, 'en', { sensitivity: 'base' });
    });
    named.concat(blank).forEach(function (el) { box.appendChild(el); });
    if (focus && box.contains(focus) && typeof focus.focus === 'function') {
      try { focus.focus(); } catch (eF) { /* ignore */ }
    }
  }
  function jobById(id) {
    var r = RW || {};
    var list = rwArr(r.jobs).concat(rwArr(r.allJobs)).concat(rwArr(r.pendingJobs));
    for (var i = 0; i < list.length; i++) if (list[i] && (list[i].id === id || list[i].jobId === id || list[i].pendingId === id)) return list[i];
    var el = document.querySelector('[data-id="' + String(id || '').replace(/"/g, '') + '"]');
    if (!el) return null;
    return { id: id, title: (el.querySelector('b') && el.querySelector('b').textContent) || el.getAttribute('data-title') || 'this job', cost: el.getAttribute('data-cost') || '', pendingId: el.getAttribute('data-pending') || '' };
  }
  function requestJobUI(id) {
    if (!id) return;
    var job = jobById(id) || { id: id, title: 'this job' };
    if (job.pending || job.pendingId) { toast('Dad already has that one to look at.', 'good'); return; }
    if (job.doneToday) { toast('Points for that job have already been given today.', 'good'); return; }
    confirmSheet('Job done?', 'Tell Dad you\u2019ve finished <b>' + esc(job.title) + '</b>? He\u2019ll take a look, and you get the points when he says yes. Once a day for each job.', 'Yes, it\u2019s done', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy('Sending to Dad\u2026');
      return call('requestJob', id, S.kid ? KID_ROLE : S.role).then(function (r) {
        done(); RW = null;
        toast('Asked! Dad will take a look' + (r && r.title ? ' \u2014 ' + r.title : '') + '.', 'good');
        if (S.kid) { if (S.screen === 'kidRewards') go('kidRewards', {}, true); else go('kid', {}, true); }
        else go('home', {}, true);
      }, function (e) {
        done();
        if (/unknown action/i.test((e && e.message) || '')) toast('This needs the latest sheet update (v4.8) before Dad can approve jobs.', 'oops');
        else oops(e);
      });
    }).catch(oops);
  }
  function decideJobUI(reqId, yes) {
    if (!reqId) return;
    var job = jobById(reqId) || { title: 'this job' };
    var wrap = sheet('Dad\u2019s PIN', '<p class="hint">Needed each time you ' + (yes ? 'approve' : 'say no to') + ' a job' + (job.title ? ' \u2014 ' + esc(job.title) : '') + '.</p><input id="rwPin" type="password" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="\u2022\u2022\u2022\u2022">',
      [{ label: yes ? 'Yes, approve' : 'No, not this time', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]);
    setTimeout(function () { var i = $('rwPin'); if (i) i.focus(); }, 50);
    wrap.then(function (v) {
      var pin = ($('rwPin') && $('rwPin').value) || '';
      if (v !== 'go') return;
      if (!/^\d{4}$/.test(pin)) { toast('That needs to be the 4-digit PIN.', 'oops'); return; }
      busy(yes ? 'Approving\u2026' : 'Saving\u2026');
      return call(yes ? 'approveJob' : 'rejectJob', reqId, pin, S.role).then(function (r) {
        done(); RW = null;
        toast(r && r.status === 'Approved' ? ('Approved' + (r.points ? ' \u2014 +' + r.points + ' points' : '') + (r.title ? ' for ' + r.title : '') + '.') : 'Okay, not this time. No points this time.', 'good');
        if (S.screen === 'rewards') go('rewards', {}, true); else go('home', {}, true);
      }, function (e) {
        done();
        if (/unknown action/i.test((e && e.message) || '')) toast('This needs the latest sheet update (v4.8).', 'oops');
        else oops(e);
      });
    }).catch(oops);
  }
  function completeJobUI(id) { requestJobUI(id); }
  function collectRewardsForm() {
    var list = [], bad = '';
    document.querySelectorAll('#rwEdit .rwItem, #rwEditOff .rwItem').forEach(function (el) {
      var titleEl = el.querySelector('.rwTitle'), costEl = el.querySelector('.rwCost');
      if (!titleEl || !costEl) return;
      var title = (titleEl.value || '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      var cost = parseInt(costEl.value, 10);
      var on = el.querySelector('.rwOn');
      var id = (titleEl.getAttribute('data-id') || el.getAttribute('data-id') || '');
      if (/[\u00a3$\u20ac]|\b\d+\s*p\b|\bpounds?\b|\bquid\b|\bmoney\b|\bcash\b|\bdollars?\b|\beuros?\b|\bpence\b/i.test(title)) bad = 'Keep money out of reward names.';
      list.push({ id: id, title: title, cost: cost, active: on ? on.checked : true });
    });
    var rules = collectPointRulesForm();
    if (rules.bad && !bad) bad = rules.bad;
    return { list: list, pts: rules.payload, rules: rules, bad: bad };
  }
  function markRewardsSaved() {
    var btn = $('rwSaveBtn');
    if (btn) { btn.textContent = 'Saved \u2713'; btn.classList.add('saved'); }
    toast('Saved \u2713', 'good');
  }
  function withDadPinThen(fn) {
    if (dadUnlocked()) return fn();
    var wrap = sheet('Dad\u2019s PIN', '<p class="hint">Needed to save the rewards.</p><input id="rwPin" type="password" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="\u2022\u2022\u2022\u2022">',
      [{ label: 'Save', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]);
    setTimeout(function () { var i = $('rwPin'); if (i) i.focus(); }, 50);
    return wrap.then(function (v) {
      var pin = ($('rwPin') && $('rwPin').value) || '';
      if (v !== 'go') return;
      if (!/^\d{4}$/.test(pin)) { toast('That needs to be the 4-digit PIN.', 'oops'); return; }
      busy('Checking the PIN\u2026');
      return call('verifyDadPin', pin).then(function (r) {
        done();
        if (r && r.ok && r.token) { storeDadToken(r.token, r.expires); return fn(); }
        toast('That PIN didn\u2019t match \u2014 have another go.', 'oops');
      });
    });
  }
  function saveRewardsUI() {
    var form = collectRewardsForm();
    if (form.bad) { toast(form.bad, 'oops'); return; }
    if (!form.list.length) { toast('Add at least one reward with a name.', 'oops'); return; }
    var jobs = collectJobsForm();
    if (jobs.bad) { toast(jobs.bad, 'oops'); return; }
    if (jobs.incomplete) { toast('Give each new job a name before saving, or the jobs won\u2019t go through to Son.', 'oops'); return; }
    var rules = form.rules || collectPointRulesForm();
    if (rules.bad) { toast(rules.bad, 'oops'); return; }
    if (rules.incomplete) { toast('Give each collection job a name before saving, or it won\u2019t go through to Son.', 'oops'); return; }
    var ptsPayload = form.pts || rules.payload;
    withDadPinThen(function () {
      busy('Saving\u2026');
      var p1 = call('saveRewards', form.list, S.role);
      var p2 = call('savePointRules', ptsPayload, S.role).then(function (r) {
        if (r && r.queued) throw new Error('The points rules couldn\u2019t reach the sheet just now. Check you\u2019ve got signal and tap Save again \u2014 they haven\u2019t been saved.');
        return r;
      }, function (e) {
        var msg = String((e && e.message) || e || '');
        if (/unknown action/i.test(msg)) return { skipped: true };
        throw new Error((msg && !/TypeError|ReferenceError|didn\u2019t work/i.test(msg)) ? ('Points rules didn\u2019t save: ' + msg) : 'Points rules didn\u2019t save. Check you\u2019ve got signal and try again.');
      });
      var wantJobs = !!(!($('jobEdit') === null) || (jobs.list && jobs.list.length));
      var p3 = wantJobs ? call('saveJobs', jobs.list, S.role).then(function (r) {
        if (r && r.queued) throw new Error('Jobs couldn\u2019t reach the sheet just now. Check you\u2019ve got signal and tap Save again \u2014 they haven\u2019t gone through to Son yet.');
        return r;
      }, function (e) {
        var msg = String((e && e.message) || e || '');
        if (/unknown action/i.test(msg)) return { skipped: true };
        throw new Error((msg && !/TypeError|ReferenceError|didn\u2019t work/i.test(msg)) ? ('Jobs didn\u2019t save: ' + msg) : 'Jobs didn\u2019t save. Check you\u2019ve got signal and try again \u2014 they haven\u2019t gone through to Son yet.');
      }) : Promise.resolve(null);
      return Promise.all([p1, p2, p3]).then(function (res) {
        done();
        RW = null;
        forgetAllRewardsCache().catch(noop);
        var saved = res[0] && res[0].rewards;
        if (saved && $('rwEdit')) {
          var titles = $('rwEdit').querySelectorAll('.rwTitle');
          saved.forEach(function (r, i) { if (titles[i]) titles[i].setAttribute('data-id', r.id); });
        }
        var savedJobs = res[2] && res[2].jobs;
        if (savedJobs && $('jobEdit')) {
          var used = {};
          Array.prototype.forEach.call($('jobEdit').querySelectorAll('.rwItem'), function (el) {
            var titleEl = el.querySelector('.jobTitle'), costEl = el.querySelector('.jobCost');
            var id = (titleEl && titleEl.getAttribute('data-id')) || el.getAttribute('data-id') || '';
            var title = ((titleEl && titleEl.value) || '').replace(/\s+/g, ' ').trim();
            var cost = parseInt((costEl && costEl.value) || '', 10);
            var match = null;
            if (id) for (var i = 0; i < savedJobs.length; i++) if (savedJobs[i].id === id) { match = savedJobs[i]; break; }
            if (!match) for (var j = 0; j < savedJobs.length; j++) if (!used[savedJobs[j].id] && savedJobs[j].title === title && savedJobs[j].cost === cost) { match = savedJobs[j]; break; }
            if (!match) return;
            used[match.id] = 1;
            if (titleEl) titleEl.setAttribute('data-id', match.id);
            el.setAttribute('data-id', match.id);
          });
          sortJobEditor();
        }
        var savedCustom = (res[1] && (res[1].collectionJobs || res[1].allCollectionJobs)) || [];
        if (savedCustom.length && $('ptsEdit')) {
          var usedC = {};
          Array.prototype.forEach.call($('ptsEdit').querySelectorAll('.rwItem[data-auto="0"]'), function (el) {
            var title = ((el.querySelector('.ptsTitle') || {}).value || '').replace(/\s+/g, ' ').trim();
            var cost = parseInt((el.querySelector('.ptsCost') || {}).value, 10);
            var id = el.getAttribute('data-id') || '';
            var match = null;
            if (id) for (var i = 0; i < savedCustom.length; i++) if (savedCustom[i].id === id) { match = savedCustom[i]; break; }
            if (!match) for (var j = 0; j < savedCustom.length; j++) if (!usedC[savedCustom[j].id] && savedCustom[j].title === title && savedCustom[j].cost === cost) { match = savedCustom[j]; break; }
            if (!match) return;
            usedC[match.id] = 1;
            el.setAttribute('data-id', match.id);
          });
          sortPointRulesEditor();
        }
        if (res[2] && res[2].skipped) {
          toast('Rewards saved, but the jobs didn\u2019t. They need the latest sheet update before they will show for Son.', 'oops');
          return;
        }
        if (wantJobs && jobs.list.length && !(savedJobs && savedJobs.length)) {
          toast('Rewards saved, but the jobs may not have gone through. Tap Save again.', 'oops');
          return;
        }
        if (res[1] && res[1].skipped) {
          toast('Rewards saved, but the points rules didn\u2019t. They need the latest sheet update before they will stick.', 'oops');
          return;
        }
        var wantCustom = !!(rules.customJobs && rules.customJobs.length);
        var wantLabels = !!(rules.rules && rules.rules.length);
        if ((wantCustom || wantLabels) && !(res[1] && (res[1].pointRules || res[1].collectionJobs))) {
          toast('Point numbers saved, but names, on/off and extra collection jobs need the latest sheet update (v4.9) before they will stick.', 'oops');
          return;
        }
        markRewardsSaved();
        loadRewards(true).then(function (r) {
          if (S.screen === 'rewards') go('rewards', {}, true);
          else if (S.screen === 'home' || S.screen === 'kid') paintWaysToEarn(r);
        }, noop);
      }).catch(oops);
    }).catch(oops);
  }

  function keepAddName() {
    var A = addState();
    if (A.step === 2 && $('addName')) A.name = ($('addName').value || '').trim();
  }
  function addBarcodeBox(A) {
    if (A.barcode) {
      return '<div class="addBc" id="addBcBox"><div><b>\uD83C\uDFF7\uFE0F Barcode</b><div class="addBcCode">' + esc(A.barcode) + '</div></div>' +
        addLookHtml(A) +
        '<div class="row"><button class="btn small" data-act="addScan">Scan again</button><button class="btn small" data-act="addTypeBc">Type it</button><button class="btn small" data-act="addClearBc">Clear</button></div></div>';
    }
    return '<div class="row wrap" style="margin-top:12px"><button class="btn" data-act="addScan">\uD83D\uDCF7 Scan barcode</button><button class="btn" data-act="addTypeBc">\u2328\uFE0F Type it</button></div>';
  }

  /* v7b: look up a scanned/typed barcode in a free product database. Never blocks Add.
     UPCitemdb is tried first but its trial API only allows CORS from upcitemdb.com, so in the
     app it usually falls through to Open Products Facts, then Open Food Facts (both allow *).
     Results are cached on the phone. Prices are stripped and never shown. A stock image, if any,
     is a reference only and is never saved as the item photo. */
  var BC_LOOK_MS = 5000;
  function bcVariants(digits) {
    var d = String(digits || '').replace(/\D/g, ''), out = [], seen = {};
    [d, d.replace(/^0+/, '') || d, ('0000000000000' + d).slice(-13), ('000000000000' + d).slice(-12)].forEach(function (x) {
      if (x && x.length >= 8 && !seen[x]) { seen[x] = 1; out.push(x); }
    });
    return out;
  }
  function bcLookGet(code) {
    try {
      var m = JSON.parse(LS.get('bcLookups') || '{}') || {}, h = m[code];
      if (h && (Date.now() - (h.at || 0) < 30 * 864e5)) return h.r;
    } catch (e) { /* ignore */ }
    return undefined;
  }
  function bcLookSet(code, r) {
    try {
      var m = JSON.parse(LS.get('bcLookups') || '{}') || {};
      m[code] = { at: Date.now(), r: r || null };
      var keys = Object.keys(m);
      if (keys.length > 80) {
        keys.sort(function (a, b) { return (m[a].at || 0) - (m[b].at || 0); })
          .slice(0, keys.length - 80).forEach(function (k) { delete m[k]; });
      }
      LS.set('bcLookups', JSON.stringify(m));
    } catch (e) { /* ignore */ }
  }
  function guessRange(name, brand, cats) {
    var lists = (S.boot && S.boot.lists && S.boot.lists.range) || [];
    var blob = [name, brand, cats].join(' ');
    var hints = [
      [/funko|pop vinyl|pop!\s*animation/i, 'Funko'],
      [/lego/i, 'Lego'],
      [/world of springfield|\bwos\b|playmates/i, 'World of Springfield'],
      [/super\s*7|ultimates/i, 'Super 7'],
      [/jakks/i, 'Jakks Pacific']
    ];
    var i, j, want;
    for (i = 0; i < hints.length; i++) if (hints[i][0].test(blob)) {
      want = hints[i][1].toLowerCase();
      for (j = 0; j < lists.length; j++) if (lists[j].toLowerCase() === want || lists[j].toLowerCase().indexOf(want) === 0) return lists[j];
      return hints[i][1];
    }
    var b = String(brand || '').split(',')[0].trim().toLowerCase();
    if (b) for (j = 0; j < lists.length; j++) if (lists[j].toLowerCase() === b) return lists[j];
    return '';
  }
  function guessBrand(name, brand) {
    var b = String(brand || '').split(',')[0].replace(/\s+/g, ' ').trim();
    if (b) return b.slice(0, 60);
    if (/funko/i.test(name || '')) return 'Funko';
    if (/\blego\b/i.test(name || '')) return 'LEGO';
    return '';
  }
  function cleanLook(o) {
    if (!o || !o.name) return null;
    var name = String(o.name).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return null;
    var image = String(o.image || '');
    if (!/^https:\/\//i.test(image)) image = '';
    return { name: name, brand: guessBrand(name, o.brand), range: o.range || guessRange(name, o.brand, o.cats), image: image, source: o.source || '' };
  }
  function fromUpcItem(j) {
    var it = j && j.items && j.items[0];
    if (!it) return null;
    return cleanLook({ name: it.title, brand: it.brand, cats: it.category, image: (it.images && it.images[0]) || '', source: 'upcitemdb' });
  }
  function fromFacts(j, source) {
    if (!j || j.status !== 1 || !j.product) return null;
    var p = j.product;
    return cleanLook({ name: p.product_name || p.product_name_en || '', brand: p.brands, cats: p.categories, image: p.image_front_small_url || p.image_front_url || p.image_url || '', source: source });
  }
  function fetchJson(url, ms) {
    var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ac) ac.abort(); }, ms || BC_LOOK_MS);
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ac && ac.signal, headers: { 'Accept': 'application/json' } })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('bad'); return r.json(); }, function (e) { clearTimeout(t); throw e; });
  }
  function firstLook(promises) {
    return new Promise(function (resolve) {
      var left = promises.length, done = false;
      if (!left) { resolve(null); return; }
      promises.forEach(function (p) {
        Promise.resolve(p).then(function (r) {
          if (done) return;
          if (r) { done = true; resolve(r); return; }
          if (--left <= 0) resolve(null);
        }, function () { if (!done && --left <= 0) resolve(null); });
      });
    });
  }
  function lookupOne(code) {
    var fields = 'product_name,product_name_en,brands,categories,image_front_small_url,image_front_url,image_url,code';
    var upc = fetchJson('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(code), 2500).then(fromUpcItem, function () { return null; });
    var opf = fetchJson('https://world.openproductsfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + fields, BC_LOOK_MS).then(function (j) { return fromFacts(j, 'openproductsfacts'); }, function () { return null; });
    var off = fetchJson('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + fields, BC_LOOK_MS).then(function (j) { return fromFacts(j, 'openfoodfacts'); }, function () { return null; });
    return firstLook([upc, opf, off]);
  }
  function lookupBarcode(digits) {
    var vars = bcVariants(digits), i, hit;
    for (i = 0; i < vars.length; i++) {
      hit = bcLookGet(vars[i]);
      if (hit !== undefined) return Promise.resolve(hit);
    }
    var start = Date.now();
    var tryVar = function (n) {
      if (n >= vars.length) return Promise.resolve(null);
      if (Date.now() - start > BC_LOOK_MS) return Promise.resolve(null);
      return lookupOne(vars[n]).then(function (r) {
        if (r) { vars.forEach(function (c) { bcLookSet(c, r); }); bcLookSet(digits, r); return r; }
        return tryVar(n + 1);
      }, function () { return tryVar(n + 1); });
    };
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(null); }, BC_LOOK_MS);
      tryVar(0).then(function (r) { clearTimeout(t); resolve(r || null); }, function () { clearTimeout(t); resolve(null); });
    });
  }
  function startBarcodeLookup(digits) {
    var A = addState();
    A.bcLook = 'wait';
    A.bcRef = '';
    lookupBarcode(digits).then(function (r) { applyLookupToAdd(digits, r || null); }, function () { applyLookupToAdd(digits, null); });
  }
  function applyLookupToAdd(digits, r) {
    var A = addState();
    if (String(A.barcode || '') !== String(digits || '')) return;
    A.bcLook = r || null;
    A.bcRef = (r && r.image) || '';
    if (r) {
      if (!A.name) A.name = r.name;
      A.more = A.more || {};
      if (!A.more.maker && r.brand) A.more.maker = r.brand;
      if (!A.range && r.range) A.range = r.range;
    }
    if (S.screen !== 'add') return;
    var nameEl = $('addName');
    if (nameEl && r && !String(nameEl.value || '').trim() && A.name) nameEl.value = A.name;
    var makerEl = $('a_maker');
    if (makerEl && r && r.brand && !String(makerEl.value || '').trim()) makerEl.value = r.brand;
    if (A.step === 3 && r && r.range) {
      document.querySelectorAll('#rangeChoices [data-act=addRange]').forEach(function (bt) {
        bt.classList.toggle('sel', bt.getAttribute('data-v') === A.range);
      });
    }
    paintAddLookup(A);
  }
  function addLookHtml(A) {
    if (!A.barcode) return '';
    if (A.bcLook === 'wait') return '<p class="hint" id="addBcLook">Looking it up\u2026</p>';
    if (A.bcLook && A.bcLook.name) {
      return '<div id="addBcLook" class="addBcFound"><p><b>Found: ' + esc(A.bcLook.name) + '</b> (check it)</p>' +
        (A.bcRef ? '<img class="addBcRef" alt="Reference only, not saved as our photo" src="' + esc(A.bcRef) + '" onerror="this.remove()"><p class="hint">Reference only \u2014 this is not saved as our photo. Take your own so it can earn points.</p>' : '') +
        '</div>';
    }
    if (A.bcLook === null) return '<p class="hint" id="addBcLook">Not found, type it in</p>';
    return '<p class="hint" id="addBcLook"></p>';
  }
  function paintAddLookup(A) {
    A = A || addState();
    var box = $('addBcLook'), html = addLookHtml(A), wrap;
    if (box) {
      wrap = document.createElement('div'); wrap.innerHTML = html;
      box.replaceWith(wrap.firstChild || wrap);
    }
  }

  function applyAddBarcode(digits) {
    var A = addState(), hits = itemsByBarcode(digits).filter(function (it) { return isOwned(it) && !neverShow(it.name) && (!S.kid || kidVisible(it)); });
    A.barcode = digits;
    startBarcodeLookup(digits);
    if (!hits.length) { go('add', {}, true); return; }
    var list = '<div class="list">' + hits.map(function (it) {
      return '<button class="li ownLi" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc(it.range || '') + '</small></div><span>\u203A</span></button>';
    }).join('') + '</div>';
    sheet('Looks like it\u2019s already in the collection', '<p>Barcode <b>' + esc(digits) + '</b> matches something we already have.</p>' + list +
      '<p class="hint">If this is a different copy, you can keep the barcode and carry on adding.</p>',
      [{ label: 'Keep it and carry on', value: 'keep', cls: 'main' }, { label: 'Open the one we have', value: 'open' }, { label: 'Clear the barcode', value: 'clear' }]).then(function (v) {
      if (v === 'clear') A.barcode = '';
      if (v === 'open') { go(S.kid ? 'kidItem' : 'item', { key: hits[0].key }); return; }
      go('add', {}, true);
    });
    setTimeout(watchThumbs, 50);
  }

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
        var why = S.pinWhy || '';
        var after = S.pinAfter || {};
        S.pinWhy = ''; S.pinAfter = null;
        if (why === 'bcAdd' || why === 'bcAssign') {
          // Stay in Son's mode. Do not store a Dad-view token, so it is never sent with later calls.
          if (why === 'bcAdd') startKidAddFromScan(after);
          else if (after.key) saveBarcodeTo(after.key, after.item || after.name, after.digits).then(function () {
            go('kidItem', { key: after.key }, true);
          });
          return;
        }
        storeDadToken(r.token, r.expires);
        if (S.kidExit) { leaveKid(PRIV); return; }
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
    var pinHint = 'Enter the 4-digit PIN to open ' + esc(PRIV) + ' view. Prices stay hidden until then.';
    if (S.pinWhy === 'bcAdd') pinHint = 'Type ' + esc(PRIV) + '\u2019s PIN to add this item. We stay in ' + esc(KID_ROLE) + '\u2019s mode \u2014 no prices.';
    if (S.pinWhy === 'bcAssign') pinHint = 'Type ' + esc(PRIV) + '\u2019s PIN to save this barcode. We stay in ' + esc(KID_ROLE) + '\u2019s mode \u2014 no prices.';
    setMain('<div class="card yel center pinCard' + (err ? ' bad' : '') + '"><h1>\uD83D\uDD12 ' + esc(PRIV) + '\u2019s PIN</h1>' +
      '<p class="hint">' + pinHint + '</p>' +
      '<div class="pinDots" aria-hidden="true">' + dots + '</div>' +
      (S.pinBusy ? '<p class="hint">Checking\u2026</p>' : (err ? '<p class="pinErr">' + esc(err) + '</p>' : '<p class="hint">&nbsp;</p>')) +
      '<div class="pinPad" role="group" aria-label="PIN pad">' + pad + '</div>' +
      '<button class="btn full" data-act="pinCancel" ' + (S.pinBusy ? 'disabled' : '') + '>Not now</button></div>');
  };

SCREENS.who = function () {
    setMain('<div class="card skyL center"><h1>Who\u2019s using it?</h1><p>Tap your name. You can switch any time from the top.</p><div class="stack">' +
      THEME.roles.map(function (r) { return '<button class="btn ' + (r === PRIV ? 'yel' : 'pink') + ' full" style="min-height:72px;font-size:22px" data-act="pickRole" data-role="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') +
      '<button class="btn full" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode - big buttons, no prices</button>' +
      '</div></div>');
  };

  var DAD_INBOX = { r: null, scan: 0 };
  function nextMilestoneInfo(n) {
    n = n || 0;
    var caps = [425, 450, 500], t = 550;
    while (t <= n + 50) { caps.push(t); t += 50; }
    var prev = 0, next = caps[0], i;
    for (i = 0; i < caps.length; i++) {
      if (n < caps[i]) { next = caps[i]; prev = i ? caps[i - 1] : 0; break; }
      if (i === caps.length - 1) { prev = caps[i]; next = caps[i] + 50; }
    }
    var span = Math.max(1, next - prev);
    return { n: n, prev: prev, next: next, need: Math.max(0, next - n), pct: Math.max(0, Math.min(100, Math.round(100 * (n - prev) / span))) };
  }
  function dadOwnedCount() {
    return (S.items || []).filter(function (it) { return isOwned(it) && !it.pending; }).length;
  }
  function dadHqBannerHtml() {
    return '<div class="dadHq">' +
      '<span class="dadHqBg" aria-hidden="true"></span>' +
      '<img class="dadHqPeek" src="assets/simpsons/homer-donut.webp" alt="" aria-hidden="true">' +
      '<div class="dadHqText"><p class="dadHqEyebrow">Alright, Dad</p><h1>Dad HQ</h1>' +
      '<p class="dadHqSub">The plant-manager view of the collection. Donut included.</p></div></div>';
  }
  function dadHeroHtml(vs) {
    var n = (vs && vs.items != null) ? vs.items : dadOwnedCount();
    var mile = nextMilestoneInfo(n);
    var h = '<div class="card yel dadHero"><h2>Collection HQ</h2><p class="funSub">How the donut pile is looking</p>';
    h += '<div class="dadHeroStats">';
    h += '<div class="dadStat"><b>' + n + '</b><small>items owned</small></div>';
    if (isPriv() && vs && typeof vs.total === 'number') {
      h += '<div class="dadStat dadStatVal"><b>' + gbp(vs.total) + '</b><small>collection value</small></div>';
    } else if (S.role === PRIV && !isPriv()) {
      h += '<div class="dadStat dadStatVal"><b>\uD83D\uDD12</b><small>Value needs your PIN</small></div>';
    }
    h += '</div>';
    if (isPriv() && vs) {
      if (vs.valued != null) h += '<p class="hint">' + vs.valued + ' with a value' + (vs.notValued ? ' \u00B7 ' + vs.notValued + ' still to value' : '') + '</p>';
      var ms = vs.monthStart;
      if (ms && ms.date && ms.date !== todayKey() && vs.change != null) {
        h += '<div class="vchg ' + (vs.change >= 0 ? 'up' : 'down') + '">' + (vs.change >= 0 ? '\u25B2 +' : '\u25BC ') + gbp(Math.abs(vs.change)).replace(/^/, vs.change < 0 ? '-' : '') + ' this month <small>(since ' + esc(shortDate(ms.date)) + ')</small></div>';
      }
    }
    h += '<div class="dadMile"><div class="dadMileTop"><b>Next milestone: ' + mile.next + '</b><small>' + (mile.need ? mile.need + ' to go' : 'You just hit it!') + '</small></div>' +
      '<div class="dadMileBar" aria-label="' + mile.pct + ' percent to ' + mile.next + '"><i data-w="' + mile.pct + '%"></i></div>' +
      '<p class="hint">' + mile.n + ' of ' + mile.next + ' things</p></div>';
    if (isPriv()) h += '<button type="button" class="btn small" data-act="go" data-to="value">See the value page</button>';
    return h + '</div>';
  }
  function paintDadHero(vs) {
    var box = $('dadHero'); if (!box) return;
    box.innerHTML = dadHeroHtml(vs);
    requestAnimationFrame(function () {
      var bar = box.querySelector('.dadMileBar > i');
      if (!bar) return;
      var w = bar.getAttribute('data-w') || '0%';
      bar.style.width = '0%';
      requestAnimationFrame(function () { bar.style.width = w; });
    });
  }
  function dadInboxHtml(r, scanN) {
    var photos = 0, asks = 0, jobs = 0;
    if (isPriv() && r) {
      photos = (r.queue && r.queue.length) || r.waiting || 0;
      asks = (r.pendingRequests && r.pendingRequests.length) || 0;
      jobs = (r.pendingJobs && r.pendingJobs.length) || 0;
    }
    var scans = scanN || 0;
    var total = photos + asks + jobs + scans;
    var h = '<div class="card dadInbox' + (total ? ' hasItems' : '') + '"><h2>Waiting on you</h2>';
    h += '<p class="funSub">' + (total ? 'A few things need the boss of the plant.' : 'All clear \u2014 nothing waiting. Nice work.') + '</p>';
    if (!isPriv()) {
      h += '<p class="hint">Enter your PIN to see photos, reward asks and jobs waiting for you.</p>';
    }
    h += '<div class="dadInboxGrid">';
    h += '<button type="button" class="dadBadge" data-act="go" data-to="rewards"><b>' + (isPriv() ? photos : '\uD83D\uDD12') + '</b><small>photos to approve</small></button>';
    h += '<button type="button" class="dadBadge" data-act="go" data-to="rewards"><b>' + (isPriv() ? asks : '\uD83D\uDD12') + '</b><small>reward asks</small></button>';
    h += '<button type="button" class="dadBadge" data-act="go" data-to="rewards"><b>' + (isPriv() ? jobs : '\uD83D\uDD12') + '</b><small>jobs to approve</small></button>';
    h += '<button type="button" class="dadBadge" data-act="go" data-to="scanQueue"><b>' + scans + '</b><small>scan' + (scans === 1 ? '' : 's') + ' in the queue</small></button>';
    h += '</div>';
    if (isPriv() && (photos || asks || jobs)) h += '<button type="button" class="btn main" data-act="go" data-to="rewards">Review approvals</button>';
    if (scans) h += '<button type="button" class="btn' + ((photos || asks || jobs) ? '' : ' main') + '" data-act="go" data-to="scanQueue">Open scan queue</button>';
    return h + '</div>';
  }
  function paintDadInbox(r, scanN) {
    if (r) DAD_INBOX.r = r;
    if (scanN != null && scanN !== '') {
      if (typeof scanN === 'number') DAD_INBOX.scan = scanN;
      else if (scanN && typeof scanN === 'object') DAD_INBOX.scan = (scanN.waiting != null ? scanN.waiting : ((scanN.pending || []).length)) || 0;
    } else if (S.boot && typeof S.boot.scanQueue === 'number' && !DAD_INBOX.scan) {
      DAD_INBOX.scan = S.boot.scanQueue;
    }
    var box = $('dadInbox'); if (!box) return;
    box.innerHTML = dadInboxHtml(DAD_INBOX.r, DAD_INBOX.scan);
  }
  function dadWheelCardHtml() {
    return '<div class="card yel dadWheel"><div class="dadWheelIc" aria-hidden="true">\uD83C\uDFA1</div><h2>Spin the wheel</h2>' +
      '<p class="funSub">Picks something we already own to film next. Prefers things not posted yet.</p>' +
      '<button type="button" class="btn main" data-act="go" data-to="wheel">Have a spin</button></div>';
  }
  function dadToolsHtml(b, t) {
    t = t || {};
    var dz = t.dropZone || { count: -1 };
    var h = '<div class="dadTools">';
    h += '<button type="button" class="dadTool yel" data-act="go" data-to="photos"><span>\uD83D\uDCF8</span><b>Photos to take</b><small>' + ((t.photos && t.photos.count) || 0) + ' still need a photo</small></button>';
    if (isPriv()) {
      h += '<button type="button" class="dadTool skyL" data-act="go" data-to="novalue"><span>\uD83D\uDCB7</span><b>No value yet</b><small>' + ((t.noValue && t.noValue.count) || 0) + ' to price</small></button>';
    } else {
      h += '<div class="dadTool skyL"><span>\uD83D\uDCB7</span><b>No value yet</b><small>Unlock with your PIN to add values</small></div>';
    }
    h += '<a class="dadTool pinkL" href="' + esc((dz.url) || (b && b.folders && b.folders.dropZone) || '#') + '" target="_blank" rel="noopener"><span>\uD83D\uDCE5</span><b>Drop Zone</b><small>' + (dz.count >= 0 ? dz.count + ' files waiting' : 'Open the folder') + '</small></a>';
    h += '<button type="button" class="dadTool" data-act="go" data-to="wanted"><span>\u2B50</span><b>Wanted</b><small>' + ((t.wanted && t.wanted.count) || 0) + ' on the hunt list</small></button>';
    h += '<button type="button" class="dadTool" data-act="go" data-to="swaps"><span>\uD83D\uDD01</span><b>Doubles to swap</b><small>Spare copies, no prices</small></button>';
    h += '<button type="button" class="dadTool pink" data-act="go" data-to="add"><span>\u2795</span><b>Add an item</b><small>Snap it, name it, done</small></button>';
    h += '</div>';
    return h;
  }

  SCREENS.home = function () {
    loadBoot().then(function (b) {
      var t = b.tiles, h = '';
      if (S.role === PRIV) {
        h += dadHqBannerHtml();
        h += '<div class="card ownCard dadOwn"><label class="ownLabel" for="homeSearch">\uD83E\uDD14 Do I own it?</label>' +
          '<div class="ownRow"><input id="homeSearch" class="ownInput" type="search" placeholder="Type a name\u2026" aria-label="Do I own it? Type a name" enterkeyhint="search" autocomplete="off">' +
          '<button class="btn main scanBtn" data-act="scan" aria-label="Scan a barcode">\uD83D\uDCF7<small>Scan</small></button></div>' +
          '<div id="ownOut"></div></div>';
        if (b.missing && (b.missing.tabs.length || b.missing.columns.length)) {
          h += '<div class="warn">\uD83D\uDEA7 The sheet is still being tidied up, so a few bits (like ' + esc(b.missing.columns.concat(b.missing.tabs).join(', ')) + ') will appear once that\u2019s finished. Everything else works.</div>';
        }
        h += '<div id="dadHero"></div>';
        h += '<div id="dadInbox"></div>';
        h += '<div id="homeWeek"></div>';
        h += '<div id="homeRewards"></div>';
        h += '<div id="homeWays"></div>';
        h += '<div id="homeFilm"></div>';
        h += funWorthHtml();
        h += '<div id="homeOnThisDay"></div><div id="homeSetBars"></div>';
        h += dadWheelCardHtml();
        h += dadToolsHtml(b, t);
        h += '<button class="btn pink full" style="margin-top:12px" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode (big buttons, no prices)</button>';
        h += '<div class="row" style="margin-top:6px"><button class="btn small" data-act="refresh">\u21BB Refresh</button><button class="btn small" data-act="go" data-to="stats">\uD83D\uDCCA Stats</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button><button class="btn small" data-act="go" data-to="help">\u2753 Help</button></div>';
      } else {
        h += '<h1>Hiya, ' + esc(S.role) + '! \uD83D\uDC4B</h1>';
        h += '<div class="card ownCard"><label class="ownLabel" for="homeSearch">\uD83E\uDD14 Do I own it?</label>' +
          '<div class="ownRow"><input id="homeSearch" class="ownInput" type="search" placeholder="Type a name\u2026" aria-label="Do I own it? Type a name" enterkeyhint="search" autocomplete="off">' +
          '<button class="btn main scanBtn" data-act="scan" aria-label="Scan a barcode">\uD83D\uDCF7<small>Scan</small></button></div>' +
          '<div id="ownOut"></div></div>';
        var ownedN = S.items.filter(function (it) { return isOwned(it) && !it.pending; }).length;
        h += '<div class="card skyL valueCard"><div class="head">\uD83E\uDDF8 Our collection</div><div class="big">' + ownedN + '</div><div class="hint">items owned</div></div>';
        if (b.missing && (b.missing.tabs.length || b.missing.columns.length)) {
          h += '<div class="warn">\uD83D\uDEA7 The sheet is still being tidied up, so a few bits (like ' + esc(b.missing.columns.concat(b.missing.tabs).join(', ')) + ') will appear once that\u2019s finished. Everything else works.</div>';
        }
        h += '<div id="homeRewards"></div>';
        h += '<div id="homeWays"></div>';
        h += '<div id="homeFilm"></div>';
        h += funWorthHtml();
        h += '<div id="homeOnThisDay"></div><div id="homeSetBars"></div>';
        h += '<div class="tiles">';
        h += '<div class="card yel tile"><div class="head">\uD83C\uDFA1 Spin the wheel</div><div class="hint">Picks something we already own to film next. Prefers things not posted yet.</div><button class="btn main" data-act="go" data-to="wheel">Have a spin</button></div>';
        h += '<div class="card tile"><div class="head">\uD83D\uDD01 Doubles to swap</div><div class="hint">Spare copies, with photos and no prices.</div><button class="btn main" data-act="go" data-to="swaps">See doubles</button></div>';
        h += '<div class="card yel tile"><div class="head">\uD83D\uDCF8 Photos to take</div><div class="big">' + t.photos.count + '</div>';
        if (t.photos.next) {
          h += '<div class="hint">Next up: <b>' + esc(t.photos.next.name) + '</b></div><button class="btn main" data-act="snapFor" data-key="' + esc(t.photos.next.key) + '">\uD83D\uDCF7 Take photo</button>' +
            '<button class="btn small" data-act="go" data-to="photos">See all ' + t.photos.count + '</button>';
        } else h += '<div class="hint">All done - every item has photos. \uD83C\uDF89</div>';
        h += '</div>';
        h += '<div class="card skyL tile"><div class="head">\uD83D\uDCB7 No value yet</div><div class="big">' + t.noValue.count + '</div>';
        h += '<div class="hint">That\u2019s ' + esc(PRIV) + '\u2019s job \uD83D\uDE09</div></div>';
        var dz = t.dropZone || { count: -1 };
        h += '<div class="card pinkL tile"><div class="head">\uD83D\uDCE5 Drop Zone</div><div class="big">' + (dz.count >= 0 ? dz.count : '?') + '</div><div class="hint">files waiting to be sorted into item folders</div>' +
          '<a class="btn main" href="' + esc(dz.url || b.folders.dropZone) + '" target="_blank" rel="noopener">Open Drop Zone \u2197</a></div>';
        h += '<div class="card tile"><div class="head">\u2B50 Wanted</div><div class="big">' + t.wanted.count + '</div><div class="hint">things on the hunt list</div><div id="dealLine"></div><button class="btn main" data-act="go" data-to="wanted">See the wanted list</button></div>';
        if (t.checklist) {
          var p = pct(t.checklist.owned, t.checklist.total);
          h += '<div class="card skyL tile"><div class="head">\u2705 ' + esc(clTitle(t.checklist.tab)) + ' checklist</div><div class="big">' + t.checklist.owned + ' / ' + t.checklist.total + '</div>' +
            '<div class="bar" role="img" aria-label="' + p + ' percent complete"><div style="width:' + p + '%"></div></div>' +
            '<button class="btn main" data-act="go" data-to="checklist" data-tab="' + esc(t.checklist.tab) + '">See what\u2019s missing</button></div>';
        }
        h += '<div class="card pink tile"><div class="head">\u2795 Got something new?</div><div class="hint">Snap it, name it, done. It goes straight into the sheet with its own folder.</div><button class="btn main" data-act="go" data-to="add">Add an item</button></div>';
        h += '</div>';
        h += '<button class="btn pink full" style="margin-top:12px" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode (big buttons, no prices)</button>';
        h += '<div class="row" style="margin-top:6px"><button class="btn small" data-act="refresh">\u21BB Refresh</button><button class="btn small" data-act="go" data-to="stats">\uD83D\uDCCA Stats</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button><button class="btn small" data-act="go" data-to="help">\u2753 Help</button></div>';
      }
      setMain(h);
      try { paintStillToFilm(); } catch (eF) {}
      paintHomeFunAndMiles();
      bindFunSwipe();
      if (S.role === PRIV) {
        paintDadHero(isPriv() ? localValueSummary() : null);
        paintDadInbox(null, (b && typeof b.scanQueue === 'number') ? b.scanQueue : 0);
        if (b && typeof b.scanQueue === 'number') paintScanQueueHome({ waiting: b.scanQueue });
        loadScanQueue().then(paintScanQueueHome).catch(noop);
      }
      if (LS.get('tourPending')) { LS.set('tourPending', ''); setTimeout(startTour, 350); }
      var hs = $('homeSearch');
      hs.addEventListener('keydown', function (e) { if (e.key === 'Enter') { hs.blur(); } });
      bindOwnSearch('homeSearch', 'ownOut');
      refreshDealBadges();
      loadHomeWanted();
      loadRewards(true).then(function (r) {
        paintRewardsHome(r);
        paintWaysToEarn(r);
        if (S.role === PRIV) paintDadInbox(r);
      }).catch(function () { paintWaysToEarn({}); if (S.role === PRIV) paintDadInbox({}); });
      if (isPriv()) {
        call('getValueSummary', S.role).then(function (vs) {
          if (vs && typeof vs.total === 'number' && S.screen === 'home') paintDadHero(vs);
        }).catch(noop);
      }
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
        ['Quantity', it.quantity], ['Where it lives', it.location], ['Date got', it.dateGot], ['Barcode', it.barcode || itemBarcode(itemByKey(it.key))]];
      var money = function (v) { return /^\s*-?\d+(\.\d+)?\s*$/.test(String(v || '')) ? gbp(+v) : v; };
      if (isPriv()) facts.push(['Paid', money(it.paid)], ['Where from', it.whereBought], ['Value', money(it.value)], ['Value source', it.valueSource]);
      facts.push(['Description', it.description && it.description !== it.name ? it.description : ''], ['Notes', it.notes]);
      facts = facts.filter(function (f) { return f[1] && !/^unknown$/i.test(String(f[1]).trim()); });
      var plats = (it.platforms || []).map(function (pl) {
        return '<button class="chip' + (pl.yes ? ' on' : '') + '" data-act="togglePosted" data-p="' + esc(pl.key) + '" aria-pressed="' + (pl.yes ? 'true' : 'false') + '">' + esc(pl.icon + ' ' + pl.label) + (pl.yes ? ' \u2713' : '') + '</button>';
      }).join('');
      var standSrc = standinUrl(it);
      var heroInner = it.folderId ? '\u23F3' : (standSrc ? '<img class="standinImg" alt="" src="' + esc(standSrc) + '">' + filmBadgeHtml() : '<span style="font-size:44px">\uD83D\uDCF7</span>');
      var h = backBtn() + '<h1>' + esc(it.name) + '</h1>' +
        '<div id="hero" class="hero' + (standSrc ? ' isStandin' : '') + '" data-act="heroOpen">' + heroInner + '</div>' +
        '<div id="nudge"></div>' +
        '<div class="stack" style="margin:12px 0"><button class="btn main full" data-act="snapCurrent">\uD83D\uDCF7 Take photo</button>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="pickCurrent">\uD83D\uDDBC\uFE0F From gallery</button><button class="btn" style="flex:1" data-act="videoCurrent">\uD83C\uDFA5 Record video</button></div>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="replaceMain">\uD83D\uDD04 New main photo</button><button class="btn" style="flex:1" data-act="scanAssign">\uD83D\uDCF7 Scan barcode</button></div>' +
        ((it.barcode || itemBarcode(itemByKey(it.key))) ? '<p class="hint">Saved barcode: ' + esc(it.barcode || itemBarcode(itemByKey(it.key))) + '</p>' : '') +
        (it.offlineCopy ? '<div class="nudge">\uD83D\uDCF4 Offline copy - the full details and photos load when you\u2019re back online.</div>' : '') +
        '<div class="row"><button class="btn yel" style="flex:1" data-act="edit">\u270F\uFE0F Edit details</button>' +
        (it.folderId ? '<a class="btn" style="flex:1" href="https://drive.google.com/drive/folders/' + esc(it.folderId) + '" target="_blank" rel="noopener">\uD83D\uDCC1 Folder \u2197</a>' : '') + '</div>' +
        (shareable(it) || isPriv() ? '<div class="row">' + (shareable(it) ? '<button class="btn pink" style="flex:1" data-act="shareFind">\uD83D\uDCE4 Share this find</button>' : '') + (isPriv() ? '<button class="btn" style="flex:1" data-act="priceCheck">\uD83D\uDD0E Price check</button>' : '') + '</div><div id="priceSlot"></div>' : '') +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full" data-act="gotItem">\u2705 Got it!</button>' : '') + '</div>' +
        '<h2>Photos</h2><div id="gallery" class="gallery"><div class="hint">' + (it.folderId ? 'Loading photos\u2026' : (standSrc ? 'Reference picture \u2014 still to film.' : 'No photos yet.')) + '</div></div>' +
        (plats ? '<div class="card skyL"><h3>\uD83D\uDCE3 Posted on</h3><div class="chips">' + plats + '</div><p class="hint">Tap one to tick it off when it\u2019s been posted.</p></div>' : '') +
        '<div class="card"><dl class="facts">' + facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl></div>';
      setMain(h);
      if (!it.folderId) {
        $('nudge').innerHTML = standSrc
          ? '<div class="nudge">This is a reference picture, not our photo. Tap \u201CTake photo\u201D when you film it and I\u2019ll make its folder too.</div>'
          : '<div class="nudge">\uD83D\uDCF7 No photos yet - tap \u201CTake photo\u201D and I\u2019ll make its folder too.</div>';
        return;
      }
      call('getItemPhotos', it.folderId).then(function (ph) {
        if (!$('hero') || !$('gallery')) return;   // moved on to another screen already
        S.gallery = ph;
        if (!ph.length) { $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">No photos yet.</div>'; $('nudge').innerHTML = '<div class="nudge">\uD83D\uDCF7 Missing photo! Snap the front first - no faces in shot.</div>'; return; }
        var first = ph[0];
        $('hero').classList.toggle('hasVideo', !!first.video);
        $('hero').innerHTML = (first.thumb ? '<img alt="' + esc(first.name) + '" src="' + first.thumb + '">' : '<span style="font-size:44px">' + (first.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') +
          (first.video ? playBadgeHtml() + '<span class="zoom">\u25B6 Play video</span>' : '<span class="zoom">\uD83D\uDD0D Tap to zoom</span>');
        $('gallery').innerHTML = ph.map(function (x, i) {
          return galleryThumbHtml(x, i);
        }).join('') + '<p class="hint" style="grid-column:1/-1">' + ph.length + ' photo' + (ph.length === 1 ? '' : 's') + (ph.some(function (x) { return x.video; }) ? ' or video' : '') + ' \u00B7 tap one to see it big, or play a video here</p>';
        if (!ph.some(function (x) { return /- back\b/i.test(x.name); }) && !ph.some(function (x) { return x.video; })) $('nudge').innerHTML = '<div class="nudge">Tip: a photo of the back or box side helps with values later.</div>';
      }).catch(function () { if (!$('hero') || !$('gallery')) return; $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">Couldn\u2019t load the photos - tap Refresh in \u201CI\u2019m stuck\u201D.</div>'; });
    }).catch(oops);
  };
  function driveFileId(x) {
    if (!x) return '';
    if (x.id && /^[\w-]{10,}$/.test(String(x.id))) return String(x.id);
    var m = String(x.url || '').match(/\/d\/([\w-]{10,})/) || String(x.url || '').match(/[?&]id=([\w-]{10,})/);
    return m ? m[1] : '';
  }
  function drivePreviewUrl(x) {
    var id = driveFileId(x);
    return id ? 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/preview' : '';
  }
  function driveOpenUrl(x) {
    if (x && x.url) return x.url;
    var id = driveFileId(x);
    return id ? 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view' : '';
  }
  function playBadgeHtml() {
    return '<span class="playIc" aria-hidden="true"><span class="playTri"></span></span>';
  }
  function galleryThumbHtml(x, i) {
    return '<button class="gthumb' + (x.main ? ' main' : '') + (x.video ? ' hasVideo' : '') + '" data-act="openPhoto" data-i="' + i + '" aria-label="' + esc((x.video ? 'Play video: ' : '') + (x.name || 'Photo')) + '">' +
      (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span>' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') +
      (x.main ? '<b>Main</b>' : '') + (x.video ? playBadgeHtml() : '') + '</button>';
  }
  function openPhoto(i) {
    var x = (S.gallery || [])[i]; if (!x) return;
    var lb = $('lightbox');
    var preview = x.video ? drivePreviewUrl(x) : '';
    var openUrl = driveOpenUrl(x);
    var media;
    if (x.video && preview) {
      media = '<div class="lbImg lbVideoBox"><iframe class="lbVideo" src="' + esc(preview) + '" title="' + esc(x.name || 'Video') + '" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
    } else {
      media = '<div class="lbImg">' + (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span style="font-size:60px">' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') + (x.video ? playBadgeHtml() : '') + '</div>';
    }
    lb.setAttribute('aria-label', x.video ? 'Video' : 'Photo');
    lb.innerHTML = '<div class="lbInner">' + media +
      '<div class="lbName">' + esc(x.name) + (x.main ? ' \u00B7 <b>main photo</b>' : '') + (x.video ? ' \u00B7 video' : '') + '</div>' +
      (x.video ? '<p class="lbHint">Plays here in the app. If it doesn\u2019t start, use Open in Drive.</p>' : '') +
      '<div class="row lbBtns">' + (i > 0 ? '<button class="btn small" data-act="openPhoto" data-i="' + (i - 1) + '">\u2190</button>' : '') +
      (!x.main && !x.video ? '<button class="btn small yel" data-act="makeMain" data-i="' + i + '">\u2B50 Make main photo</button>' : '') +
      (openUrl ? '<a class="btn small" href="' + esc(openUrl) + '" target="_blank" rel="noopener">Open in Drive \u2197</a>' : '') +
      (i < S.gallery.length - 1 ? '<button class="btn small" data-act="openPhoto" data-i="' + (i + 1) + '">\u2192</button>' : '') +
      '<button class="btn small main" data-act="closePhoto">Close</button></div></div>';
    var wasOpen = !lb.hidden;
    lb.hidden = false;
    layerOpen(wasOpen);
    if (!x.video) call('getPhotoLarge', S.current.key, x.id).then(function (r) {
      if (lb.hidden || !r || !r.src) return;
      var img = lb.querySelector('.lbImg img'); if (img) img.src = r.src; else if (lb.querySelector('.lbImg')) lb.querySelector('.lbImg').innerHTML = '<img alt="" src="' + r.src + '">';
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
        pointsNote(r, r.skipped && r.skipped.length ? 'Saved! (The sheet has no column for ' + r.skipped.join(', ') + ' yet, so those were skipped.)' : '\u2705 Saved');
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
          addBarcodeBox(A) +
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
          addBarcodeBox(A) +
          '<div class="warn" style="margin-top:12px"><b>Check:</b> ' + esc(A.name) + ' \u00B7 ' + esc(A.range) + ' \u00B7 ' + (A.condition ? esc(A.condition) : '<i>pick a condition</i>') + ' \u00B7 ' + A.shots.length + ' photo' + (A.shots.length === 1 ? '' : 's') + (A.barcode ? ' \u00B7 barcode ' + esc(A.barcode) : '') + '</div>' +
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
        if (!hits.length) { A.step = 3; layerPush(); go('add', {}, true); return; }
        var body = '<p>Looks like you might already have:</p><ul>' + hits.map(function (x) { return '<li><b>' + esc(x.name) + '</b> <span class="muted">(' + esc(x.range) + ')</span></li>'; }).join('') + '</ul><p>Is this a different one, or a second copy?</p>';
        sheet('Already got it?', body, [{ label: 'It\u2019s a different one - carry on', value: 'go', cls: 'main' }, { label: 'Open the one I\u2019ve got', value: 'open' }, { label: 'Change the name', value: 'stay' }])
          .then(function (v) { if (v === 'go') { A.step = 3; layerPush(); go('add', {}, true); } else if (v === 'open') { go(S.kid ? 'kidItem' : 'item', { key: hits[0].key }); } });
      }).catch(function (e) { done(); A.step = 3; go('add', {}, true); });
      return;
    }
    A.step = Math.min(4, A.step + 1); layerPush(); go('add', {}, true);
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
      if (A.barcode) { var bm = localBarcodes(); bm[r.key] = A.barcode; LS.set('barcodes', JSON.stringify(bm)); }
      var bcStep = A.barcode ? call('saveBarcode', r.key, r.name, A.barcode, S.role).catch(function () { /* kept on the phone; can be saved again from the item */ }) : Promise.resolve();
      return bcStep.then(function () { return A.shots.reduce(function (p, s) {
        return p.then(function () {
          busy('Saving photo ' + (n + failed + 1) + ' of ' + A.shots.length + '\u2026');
          return call('uploadMedia', r.key, r.name, s.mime, s.b64, s.label).then(function () { n++; }, function () { failed++; });
        });
      }, Promise.resolve()); }).then(function () {
        done(); S.add = null; S.boot = null;
        var body = (r.queued ? '<p>\uD83D\uDCF4 No signal, so <b>' + esc(r.name) + '</b> and ' + n + ' photo' + (n === 1 ? ' is' : 's are') + ' saved on the phone. They\u2019ll go into the sheet and Drive as soon as you\u2019re back online.</p>' :
          '<p><b>' + esc(r.name) + '</b> is in the collection' + (r.id ? ' as <b>' + esc(r.id) + '</b>' : '') + ', with its own folder and ' + n + ' photo' + (n === 1 ? '' : 's') + '.</p>') +
          (r.points ? '<p><b>+' + r.points + ' points!</b></p>' : '') +
          (failed ? '<div class="nudge">' + failed + ' photo' + (failed === 1 ? '' : 's') + ' didn\u2019t go through - open the item and tap \u201CAdd photo\u201D to try again.</div>' : '');
        return sheet('\uD83C\uDF89 Added!', body, [{ label: 'Open it', value: 'open', cls: 'main' }, { label: 'Add another', value: 'again' }, { label: 'Home', value: 'home' }]).then(function (x) {
          if (x === 'open') go(S.kid ? 'kidItem' : 'item', { key: r.key }); else if (x === 'again') go('add', {}, true); else go(S.kid ? 'kid' : 'home');
        });
      });
    }).catch(oops);
  }


  var WANT_EGGS = ['\uD83D\uDC15', '\uD83C\uDF69', '\uD83D\uDC1F', '\uD83D\uDC7D', '\uD83C\uDF34', '\uD83D\uDCFA', '\uD83D\uDC7E'];
  var WANT_PEEK_ROT = ['homer-wave.webp', 'bart-wave.webp', 'lisa.webp', 'marge.webp', 'maggie.webp', 'family.webp', 'homer-peek.webp', 'bart-head.webp', 'homer-donut.webp'];
  function wantArt(cat, series, idx) {
    var s = (String(cat || '') + ' ' + String(series || '')).toLowerCase();
    var art = { bg: 'sky.webp', peek: WANT_PEEK_ROT[idx % WANT_PEEK_ROT.length] };
    if (/helper|santa.?s little|snowball/.test(s)) art.peek = 'helper.webp';
    else if (/pez/.test(s)) art.peek = 'homer-donut.webp';
    else if (/funko/.test(s)) art.peek = 'bart-wave.webp';
    else if (/springfield|world of springfield|\bwos\b/.test(s)) { art.bg = 'springfield.webp'; art.peek = 'homer-wave.webp'; }
    else if (/jakks/.test(s)) art.peek = 'family.webp';
    else if (/super\s*7|super7/.test(s)) art.peek = 'burns.webp';
    else if (/lego/.test(s)) art.peek = 'lisa.webp';
    else if (/coalport/.test(s)) art.peek = 'marge.webp';
    else if (/donut|duff|moe/.test(s)) { art.peek = 'homer-donut.webp'; art.bg = 'kwikemart.webp'; }
    else if (/plush/.test(s)) art.peek = 'maggie.webp';
    else if (/kwik/.test(s)) { art.bg = 'kwikemart.webp'; }
    else if (idx % 5 === 3) art.bg = 'kwikemart.webp';
    return art;
  }
  var WAVE_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
  function waveNum(s) {
    var m = String(s || '').match(/(?:wave|series|season)\s+([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)/i);
    if (!m) return 9999;
    var w = m[1].toLowerCase();
    return WAVE_WORDS[w] || parseInt(w, 10) || 9999;
  }
  function isWantedWave(s) {
    return /(?:^|\b)(?:Wave|Series|Season)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/i.test(String(s || '').trim());
  }
  function wantedParts(w) {
    var cat = String((w && w.range) || '').trim();
    var series = String((w && w.series) || '').trim();
    if (series && !isWantedWave(series)) series = '';
    var wr = /^(.*?)\s+((?:Wave|Series|Season)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)(?:\b.*)?)$/i;
    if (!series) {
      var m = cat.match(wr);
      if (m) { cat = m[1].trim(); series = m[2].trim(); }
    }
    if (!series) {
      var m2 = String((w && w.name) || '').match(/\b((?:Wave|Series|Season)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen))\b/i);
      if (m2) series = m2[1];
    }
    if (!cat) cat = 'Other';
    return { cat: cat, series: series };
  }
  function wantedGroupId(p) { return (p.cat + '|' + (p.series || '')).toLowerCase(); }
  function wantedGroupTitle(p) { return p.series ? p.cat + ' \u00b7 ' + p.series : p.cat; }
  function wantedGroups(list) {
    var map = {}, order = [];
    (list || []).forEach(function (w, i) {
      var p = wantedParts(w), id = wantedGroupId(p);
      if (!map[id]) { map[id] = { id: id, title: wantedGroupTitle(p), cat: p.cat, series: p.series, items: [] }; order.push(id); }
      map[id].items.push({ w: w, i: i });
    });
    order.sort(function (a, b) {
      var A = map[a], B = map[b];
      var ac = A.cat === 'Other' ? 1 : 0, bc = B.cat === 'Other' ? 1 : 0;
      if (ac !== bc) return ac - bc;
      var c = A.cat.localeCompare(B.cat, 'en-GB', { sensitivity: 'base' });
      if (c) return c;
      var aw = waveNum(A.series), bw = waveNum(B.series);
      if (aw !== bw) return aw - bw;
      return String(A.series || '').localeCompare(String(B.series || ''), 'en-GB', { sensitivity: 'base' });
    });
    return order.map(function (id) {
      map[id].items.sort(function (a, b) { return String(a.w.name || '').localeCompare(String(b.w.name || ''), 'en-GB', { sensitivity: 'base' }); });
      return map[id];
    });
  }
  function wantCollapsedMap() {
    try { var o = JSON.parse(LS.get('wantCollapsed') || '{}'); return o && typeof o === 'object' ? o : {}; }
    catch (e) { return {}; }
  }
  function wantSetCollapsed(id, on) {
    var o = wantCollapsedMap();
    if (on) o[id] = 1; else delete o[id];
    LS.set('wantCollapsed', JSON.stringify(o));
  }
  function wantedDivider(n) { return ''; }
  function wantBannerHtml(g, gi, closed) {
    var art = wantArt(g.cat, g.series, gi);
    return '<button type="button" class="wantHead wantBanner" data-act="wantToggle" data-gid="' + esc(g.id) + '" aria-expanded="' + (closed ? 'false' : 'true') + '">' +
      '<span class="wantBannerBg" aria-hidden="true" style="background-image:url(\x27assets/simpsons/' + art.bg + '\x27)"></span>' +
      '<img class="wantPeek" src="assets/simpsons/' + art.peek + '" alt="" aria-hidden="true">' +
      '<span class="wantBannerText"><span class="wantChev">' + (closed ? '\u25B8' : '\u25BE') + '</span>' +
      '<span class="wantTitle">' + esc(g.title) + '</span>' +
      '<span class="wantN">(' + g.items.length + ')</span></span></button>';
  }
  function wantedSearchHay(w) {
    return norm([w.name, w.range, w.series, w.conditionWanted].filter(Boolean).join(' '));
  }
  function wantedItemHtml(w, i, kid) {
    var hay = esc(wantedSearchHay(w));
    var info = '<button type="button" class="btn small wantInfoBtn" data-act="wantInfo" data-src="' + (kid ? 'kid' : 'dad') + '" data-i="' + i + '" aria-label="Info about ' + esc(w.name) + '">\u24D8</button>';
    if (kid) {
      return '<div class="khuntCard" data-wq="' + hay + '"><b>' + esc(w.name) + '</b><small>' + esc([w.range, isWantedWave(w.series) ? w.series : '', (!isWantedWave(w.series) && w.series) ? w.series : (w.number || '')].filter(Boolean).join(' \u00b7 ')) + '</small>' +
        '<div class="row wantActions">' + info + '<button class="btn green kbtn" data-act="kidGot" data-i="' + i + '">\uD83C\uDF89 Found it!</button></div></div>';
    }
    return '<div class="li' + (w.deal ? ' deal' : '') + '" data-wq="' + hay + '"><div class="grow">' + (w.deal ? '<span class="pill red">\uD83D\uDD25 Deal</span> ' : '') + esc(w.name) +
      '<small>' + esc([w.range, w.series, w.conditionWanted].filter(Boolean).join(' \u00b7 ')) + '</small>' +
      (w.deal ? '<small>' + esc(['Found' + (w.dealFound ? ' ' + w.dealFound : ''), w.dealCondition ? 'condition: ' + w.dealCondition : ''].filter(Boolean).join(' \u00b7 ')) + '</small>' +
        (w.dealLink ? '<a class="btn small yel" style="margin-top:6px" href="' + esc(w.dealLink) + '" target="_blank" rel="noopener">Open the deal \u2197</a>' : '') : '') +
      '</div><div class="stack" style="gap:6px">' + info +
      (isPriv() ? '<button class="btn small" data-act="findCheapest" data-i="' + i + '">\uD83D\uDCB7 Find cheapest</button>' : '') +
      '<button class="btn green small" data-act="gotWanted" data-i="' + i + '">Got it</button></div></div>';
  }
  function renderWantedGroups(list, kid) {
    var groups = wantedGroups(list);
    if (!groups.length) return kid ? '<div class="nudge">Nothing on the hunt list right now.</div>' : '<div class="nudge">Nothing on the wanted list right now.</div>';
    var col = wantCollapsedMap();
    var h = '<div class="wantBar"><button type="button" class="btn small" data-act="wantCollapseAll">Collapse all</button>' +
      '<button type="button" class="btn small" data-act="wantExpandAll">Expand all</button></div>';
    h += '<div id="wantList" class="' + (kid ? 'khunt' : 'list') + ' wantGrouped">';
    groups.forEach(function (g, gi) {
      var closed = !!col[g.id];
      h += '<div class="wantGroup' + (closed ? ' is-collapsed' : '') + '" data-gid="' + esc(g.id) + '">';
      h += wantBannerHtml(g, gi, closed);
      h += '<div class="wantItems">';
      g.items.forEach(function (it) { h += wantedItemHtml(it.w, it.i, kid); });
      h += '</div></div>';
    });
    return h + '</div>';
  }
  function wantToggle(id, force) {
    document.querySelectorAll('.wantGroup').forEach(function (el) {
      var gid = el.getAttribute('data-gid');
      if (id && gid !== id) return;
      var on = force != null ? !!force : !el.classList.contains('is-collapsed');
      el.classList.toggle('is-collapsed', on);
      wantSetCollapsed(gid, on);
      var btn = el.querySelector('.wantHead');
      if (btn) {
        btn.setAttribute('aria-expanded', on ? 'false' : 'true');
        var ch = btn.querySelector('.wantChev');
        if (ch) ch.textContent = on ? '\u25B8' : '\u25BE';
      }
    });
  }
  function wantCollapseAll(on) {
    var o = {};
    document.querySelectorAll('.wantGroup').forEach(function (el) {
      var gid = el.getAttribute('data-gid');
      if (on) o[gid] = 1;
    });
    LS.set('wantCollapsed', JSON.stringify(o));
    wantToggle(null, on);
  }
  function filterWantedList(qRaw, total) {
    var q = norm(qRaw), shown = 0;
    document.querySelectorAll('#wantList .wantGroup').forEach(function (g) {
      var n = 0;
      g.querySelectorAll('[data-wq]').forEach(function (li) {
        var words = q ? q.split(' ') : [], txt = li.getAttribute('data-wq') || '', hit = words.every(function (w) { return txt.indexOf(w) >= 0; });
        li.hidden = !hit; if (hit) { n++; shown++; }
      });
      g.hidden = q ? n === 0 : false;
      if (q && n) g.classList.remove('is-collapsed');
    });
    if ($('wantCount')) $('wantCount').textContent = q ? shown + ' of ' + total + ' match \u201C' + qRaw + '\u201D.' : total + ' on the hunt list. Got one? Tap \u201CGot it\u201D.';
  }
  function wantedSearchQuery(w) {
    return [w && w.name, w && w.range, w && w.series, w && w.year].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  function ebayWantedUrl(w) {
    return 'https://www.ebay.co.uk/sch/i.html?_nkw=' + encodeURIComponent(wantedSearchQuery(w));
  }
  function wantRefSlug(w) {
    var bit = function (s) {
      return norm(s).replace(/#/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x';
    };
    return bit(w && w.range) + '__' + bit(w && w.series) + '__' + bit(w && w.name);
  }
  function wantRefUrl(w) {
    var id = wantRefSlug(w);
    if (WANT_REF_IDS && WANT_REF_IDS[id]) return './assets/refs/' + id + '.webp';
    return '';
  }
  function findRefPic(w) {
    return Promise.resolve(wantRefUrl(w) || '');
  }
  function wantedInfoSheet(i, list) {
    var w = (list || [])[i]; if (!w) return;
    var ebay = ebayWantedUrl(w);
    var url = wantRefUrl(w);
    var pic = url
      ? '<img alt="" src="' + esc(url) + '">'
      : '<img class="wantRefPlaceholder" alt="No reference picture yet" src="./assets/refs/_placeholder.webp">';
    sheet(w.name, '<div class="wantInfo">' +
      '<div class="wantRef" id="wantRef">' + pic + '</div>' +
      '<p class="wantRefLab">Reference picture</p>' +
      '<p class="hint">This is just to help us recognise it \u2014 it is not one of our photos, and we never save it as one.</p>' +
      '<a class="btn full main" href="' + esc(ebay) + '" target="_blank" rel="noopener">Search on eBay UK \u2197</a>' +
      '</div>',
      [{ label: 'Close', value: false }]);
  }

  /* ---- Wanted + checklists ---- */
  SCREENS.wanted = function () {
    busy('Getting the wanted list\u2026');
    loadHomeWanted().then(function (list) {
      done();
      list = (list || []).filter(function (w) { return !neverShow(w.name) && (isPriv() || !sonHidden(w.name)); });
      S.homeWanted = list.slice();
      list = list.filter(function (w) { return w.deal; }).concat(list.filter(function (w) { return !w.deal; }));
      var deals = list.filter(function (w) { return w.deal; }).length;
      refreshDealBadges();
      var h = '<h1>\u2B50 Wanted</h1>' +
        (deals ? '<div class="card dealsCard"><b>\uD83D\uDD25 ' + deals + ' deal' + (deals === 1 ? '' : 's') + ' found under your max price</b><div class="hint">Shown first below. Check the condition and postage - nothing is ever bought or bid on from here.</div></div>' :
          (isPriv() ? '<p class="hint">\uD83D\uDD14 Deal alerts: none right now. They light up when the Wanted sheet has a deal price at or under the max price.</p>' : '')) +
        '<div class="search"><input id="wantSearch" type="search" placeholder="\uD83D\uDD0D Search the wanted list" aria-label="Search wanted" autocomplete="off"></div>' +
        '<p class="hint" id="wantCount">' + list.length + ' on the hunt list. Got one? Tap \u201CGot it\u201D.</p>' +
        '<div class="row" style="margin-bottom:10px"><button class="btn small" data-act="go" data-to="missing">\uD83E\uDDE9 Missing from sets</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button></div>' +
        renderWantedGroups(list, false) +
        '<p><button class="btn full" data-act="go" data-to="checklists">\u2705 Full-set checklists</button></p>';
      S.wantedList = list;
      setMain(h);
      $('wantSearch').addEventListener('input', function (e) { filterWantedList(e.target.value, list.length); });
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
    var fromList = w.kind === 'checklist';
    confirmSheet('Got it? \uD83C\uDF89', fromList ? 'Mark <b>' + esc(w.name) + '</b> as got on the ' + esc(w.range || 'checklist') + ' list?' : 'Move <b>' + esc(w.name) + '</b> into the collection as Owned? I\u2019ll give it a folder so you can snap it next.', 'Yes, got it!', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy(fromList ? 'Ticking it off\u2026' : 'Moving it into the collection\u2026');
      return call('markGotIt', w.kind, w.ref, w.name, S.role).then(function (r) {
        done(); S.boot = null;
        pointsNote(r, fromList || r.suggestAdd ? '\u2705 Ticked off the list.' : '\u2705 Nice one! It\u2019s in the collection now.');
        if (r.key) {
          return confirmSheet('Snap it now?', 'Take a photo of <b>' + esc(r.name) + '</b> while it\u2019s in your hand?', '\uD83D\uDCF7 Take photo', 'Later').then(function (snap) {
            if (snap) openCamera({ key: r.key, name: r.name }); else go('wanted', {}, true);
          });
        }
        return confirmSheet('Add it to the collection?', 'Want to add <b>' + esc(r.name || w.name) + '</b> to the collection now with a photo?', 'Yes, add it', 'Later').then(function (add) {
          if (add) { S.add = { step: 1, shots: [], name: w.name, range: w.range, condition: '', more: {} }; go('add'); }
          else go('wanted', {}, true);
        });
      });
    }).catch(oops);
  }
  SCREENS.checklists = function () {
    busy('Counting\u2026');
    call('getChecklists').then(function (cls) {
      done();
      var list = sortSetsClosest(cls);
      setMain(backBtn() + '<h1>' + (S.kid ? '\u2705 Our sets' : '\u2705 Full-set checklists') + '</h1><p class="hint">Closest to a finished set first.</p><div class="list">' + list.map(function (c) {
        var p = pct(c.owned, c.total), done = c.owned >= c.total;
        return '<button class="li" style="width:100%;text-align:left;font-family:inherit;color:inherit" data-act="go" data-to="checklist" data-tab="' + esc(c.tab) + '"><div class="grow">' + esc(clTitle(c.tab)) +
          '<small>' + c.owned + ' of ' + c.total + ' (' + p + '%)' + (done ? ' \u2014 complete!' : '') + '</small><div class="bar" style="margin-top:6px"><div style="width:' + p + '%"></div></div></div><span>\u203A</span></button>';
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
      '<button class="btn pink full" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode</button>' +
      '<p class="hint">\uD83D\uDCF4 Works offline: the last collection you opened is kept on this phone. Changes made with no signal sync automatically.' + (NET.queueLen ? ' <b>' + NET.queueLen + ' waiting.</b>' : '') + '</p>' +
      (THEME.needsPin && isPriv() ? '<button class="btn full" data-act="lockPriv">\uD83D\uDD12 Lock ' + esc(PRIV) + ' view</button>' : '') +
      (THEME.generic && isPriv() ? '<a class="btn yel full" href="?settings=1">\u2699\uFE0F Change name, colours, people</a>' : '') +
      (THEME.generic ? '<a class="btn full" href="?reset=1">\uD83D\uDD0C Connect a different collection</a>' : '') +
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
      ['spares', '\uD83D\uDD01', 'Spares & duplicates', 'Owned more than once - swap or sell'],
      ['swaps', '\uD83D\uDD01', 'Doubles to swap', 'Spare copies with photos, no prices'],
      ['wheel', '\uD83C\uDFA1', 'Spin the wheel', 'Pick something we own to film next'],
      ['history', '\uD83D\uDDD3\uFE0F', 'Item history', 'When each thing joined, and where from'],
      ['missing', '\uD83E\uDDE9', 'Missing list', 'Everything still needed for the full sets'],
      ['checklists', '\u2705', 'Checklists', 'How close each full set is'],
      ['photos', '\uD83D\uDCF8', 'Photos to take', 'Items still needing our own photos']
    ];
    if (isPriv()) {
      tiles.push(['scanQueue', '\uD83C\uDFF7\uFE0F', 'Scan queue', 'Barcodes saved for you to add or dismiss']);
      tiles.push(['rewards', '\u2B50', KID_ROLE + '\u2019s rewards', 'Points, photo approvals, activity log']);
      tiles.push(['badgeEdit', '\uD83C\uDFC6', KID_ROLE + '\u2019s badges', 'Add badges, change tiers, mark earned']);
      tiles.push(['value', '\uD83D\uDCB7', 'Value', 'Private: totals, top 10, paid vs value']);
    }
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
    ['\uD83D\uDCF8 Photos', ['Open any item and tap <b>Add photo / video</b>. It saves straight into that item\u2019s own Drive folder. Videos play in the app when you tap them; Open in Drive is still there as a fallback.', 'Tap <b>New main photo</b> to replace the picture that shows in the lists. The old one stays in the folder - nothing is deleted.', 'Tap any photo to see it big, then <b>Make main photo</b> to pick a different main one.', 'No faces in shot, please. Hands are fine.']],
    ['\uD83E\uDD14 Do I own it? + barcode scan', ['Type any name in <b>Do I own it?</b> on Home - it tells you yes, maybe or no as you type, even with spelling mistakes.', 'Tap <b>\uD83D\uDCF7 Scan</b> and point the camera at a box\u2019s barcode. If the barcode is saved on an item it matches straight away.', 'First time for a barcode? The app looks up the number and shows the name, brand and a reference picture if it can find them. In ' + esc(KID_ROLE) + '\u2019s mode, ' + esc(THEME.privateRole) + ' can type his PIN and add it (you stay in ' + esc(KID_ROLE) + '\u2019s mode, and you still earn add points), or save it for Dad later. Open any item and tap <b>Scan barcode</b> to link the number \u2014 you\u2019ll see the lookup before it is saved.']],
    ['\uD83D\uDCF4 No signal', ['The last collection you opened is kept on the phone, with photos you\u2019ve already seen.', 'Adds, edits, ticks and photos made with no signal are kept on the phone and sync on their own when you\u2019re back online.']],
    ['\uD83E\uDDD2 ' + KID_ROLE + '\u2019s mode', ['Big buttons and photos, no prices. Tick off finds on the hunt list and add photos.', 'A <b>letter from Dad</b> opens the first time each day, and you can read it again any time from the Home tile.', 'The <b>\u2B50 My points</b> page awards points for photos (once Dad says yes), ticks and new finds, with levels and real rewards Dad sets. Secret or hidden things never earn points, and there is never any money.', 'The <b>\uD83C\uDFC6 Badges</b> wall unlocks badges from the collection (10 Funkos, first rare find, finds this month, photos added\u2026) with confetti for each new one. No money badges, and secret or Christmas things never count.', 'Getting back to the full app needs ' + esc(THEME.privateRole) + '\u2019s PIN.']],
    ['\uD83D\uDD0D Finding things', ['Use the search box on Home or in Collection. It searches names, characters, lines and IDs.', 'Tap <b>Filters</b> to narrow down by category, line, condition, status, posted or photos.', 'Use the sort menu for newest first, A to Z or by year.']],
    ['\u2B50 Wanted and missing', ['<b>Wanted</b> is your hunt list. Tap <b>Got it</b> when one arrives and it moves into the collection.', '<b>Missing list</b> (under More) shows everything still needed from every full-set checklist in one place.', '<b>Checklists</b> shows how close each set is.']],
    ['\uD83D\uDCE3 Posted on socials', ['Each item page has the platforms as buttons. Tap one to tick it once it\u2019s posted.', 'Under More \u2192 <b>Posted on socials</b> you can see what hasn\u2019t been posted yet - handy for planning.']],
    ['\uD83D\uDD01 Spares, doubles and the film wheel', ['<b>Doubles to swap</b> (Home, or More) lists spare copies with photos and no prices, in both modes.', 'Under More \u2192 <b>Spares & duplicates</b> ' + esc(THEME.privateRole) + ' can still mark a copy for sale. Values only show there, and only for ' + esc(THEME.privateRole) + '.', 'Tap <b>Spin the wheel</b> to pick something we already own to film next. It prefers items not posted yet.']],
    ['\uD83C\uDF89 Milestones, On this day and set progress', ['The app celebrates when the collection hits 425, 450, 500, then every 50 items, and when a full set is completed. Each milestone is shown once.', '<b>On this day</b> on Home shows items that were bought, added or filmed on today\u2019s date in past years. If there are none, the card stays hidden. Bought dates only show for ' + esc(THEME.privateRole) + '.', '<b>Set progress</b> on Home (and Checklists) shows a bar per set, closest to finished first.']],
    ['\uD83D\uDCE4 Share a find', ['Open an item and tap <b>Share this find</b>. It makes a 1080\u00D71350 picture (photo, name and line, @simpsonscollect) ready for Instagram.', 'Tap <b>Share</b> to send it straight to an app, or <b>Save picture</b>. There are never prices on it, and it isn\u2019t offered for secret or Christmas things.']],
    ['\uD83D\uDD0E Price check', ['On any item (' + esc(THEME.privateRole) + '\u2019s view) tap <b>Price check</b> for eBay UK <b>sold</b> listings - newest, highest or lowest first - or a Google search. It only opens the links; nothing is saved.']],
    ['\uD83D\uDDD3\uFE0F Item history', ['Under More \u2192 <b>Item history</b>: a timeline of when things joined, month by month, with where they came from.', 'It reads Purchase Date, then Date got, then Photo date from the sheet. Anything with no date is listed at the bottom so you can fill it in.', 'Prices only show for ' + esc(THEME.privateRole) + '.']],
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
    var step = TOUR[i]; if (!step) { NAV.tourFinished = true; if (NAV.pushed > 0) layerBack(); else closeTour(true); return; }
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
    var wasOpen = !ov.hidden;
    ov.hidden = false;
    layerOpen(wasOpen);
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

  /* ================= v6: share a find, price check, spares & duplicates, badges, item history ================= */
  var XMAS_RE = /christmas|xmas|x-mas|secret|advent|\bsanta\b(?!'?s little helper)|\b(gift|present) for\b/i;
  /* Share cards are never offered for secret, Christmassy or son-hidden items */
  function shareable(it) {
    if (!it || neverShow(it.name) || sonHidden(it.name) || it.hs) return false;
    var slim = itemByKey(it.key); if (slim && (slim.hs || neverShow(slim.name))) return false;
    return !XMAS_RE.test([it.name, it.range, it.series, it.character, it.notes, it.description].join(' '));
  }
  function loadImg(src) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; }); }
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fitLines(g, text, maxW, maxLines, size, minSize, weight) {
    for (var s = size; s >= minSize; s -= 2) {
      g.font = weight + ' ' + s + 'px ' + SHARE_FONT;
      var words = String(text).split(/\s+/), lines = [], cur = '';
      words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } });
      if (cur) lines.push(cur);
      if (lines.length <= maxLines && lines.every(function (l) { return g.measureText(l).width <= maxW; })) return { lines: lines, size: s };
    }
    g.font = weight + ' ' + minSize + 'px ' + SHARE_FONT;
    var all = String(text), out = [];
    while (all && out.length < maxLines) { var n = all.length; while (n > 1 && g.measureText(all.slice(0, n) + (n < all.length ? '\u2026' : '')).width > maxW) n--; out.push(all.slice(0, n) + (n < all.length && out.length === maxLines - 1 ? '\u2026' : '')); all = all.slice(n).trim(); }
    return { lines: out, size: minSize };
  }
  var SHARE_FONT = '"Arial Black", "Helvetica Neue", Roboto, Arial, sans-serif';
  var SHARE_HANDLE = '@simpsonscollect';
  /* 1080x1350 portrait card: photo, name, line, branding. Never any price or value. */
  function makeShareCard(it, photoSrc) {
    var W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'), INK = '#13294B', YEL = '#FFD90F';
    g.fillStyle = '#70C8EA'; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.95)';
    [[120, 120, 70], [200, 100, 90], [300, 130, 60], [800, 90, 70], [890, 70, 90], [990, 110, 60], [60, 760, 50], [1040, 900, 60]].forEach(function (b) { g.beginPath(); g.arc(b[0], b[1], b[2], 0, Math.PI * 2); g.fill(); });
    return Promise.all([photoSrc ? loadImg(photoSrc).catch(function () { return null; }) : null, loadImg('icons/icon-192.png').catch(function () { return null; })]).then(function (imgs) {
      var photo = imgs[0], icon = imgs[1];
      // title
      var tx = icon ? 190 : W / 2;
      if (icon) { g.save(); g.beginPath(); g.arc(110, 95, 62, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 8; g.strokeStyle = INK; g.stroke(); g.clip(); g.drawImage(icon, 48, 33, 124, 124); g.restore(); }
      g.textAlign = icon ? 'left' : 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      var tt = fitLines(g, 'FatherSon Collections', icon ? W - tx - 40 : W - 80, 1, 74, 44, '900');
      g.font = '900 ' + tt.size + 'px ' + SHARE_FONT; g.lineWidth = 14; g.strokeStyle = INK; g.strokeText(tt.lines[0], tx, 98); g.fillStyle = YEL; g.fillText(tt.lines[0], tx, 98);
      // photo frame
      var fx = 60, fy = 185, fw = W - 120, fh = 820;
      g.save(); g.shadowColor = 'rgba(19,41,75,.35)'; g.shadowOffsetY = 12; g.shadowBlur = 0; rrect(g, fx, fy, fw, fh, 44); g.fillStyle = '#fff'; g.fill(); g.restore();
      rrect(g, fx, fy, fw, fh, 44); g.lineWidth = 10; g.strokeStyle = INK; g.stroke();
      g.save(); rrect(g, fx + 22, fy + 22, fw - 44, fh - 44, 28); g.clip();
      if (photo) {
        var iw = photo.naturalWidth, ih = photo.naturalHeight, bw = fw - 44, bh = fh - 44, sc = Math.max(bw / iw, bh / ih);
        g.drawImage(photo, fx + 22 + (bw - iw * sc) / 2, fy + 22 + (bh - ih * sc) / 2, iw * sc, ih * sc);
      } else { g.fillStyle = '#E6F4F8'; g.fillRect(fx, fy, fw, fh); g.font = '200px sans-serif'; g.textAlign = 'center'; g.fillText('\uD83D\uDCF7', W / 2, fy + fh / 2); }
      g.restore();
      // name panel
      var py = 1035, ph = 220;
      rrect(g, 50, py, W - 100, ph, 36); g.fillStyle = YEL; g.fill(); g.lineWidth = 10; g.strokeStyle = INK; g.stroke();
      var line = [it.range, it.series && !/^unknown$/i.test(it.series) && it.series !== it.range ? it.series : ''].filter(Boolean).join(' \u00B7 ');
      var nm = fitLines(g, it.name, W - 170, 2, 60, 34, '900');
      g.textAlign = 'center'; g.fillStyle = INK; g.font = '900 ' + nm.size + 'px ' + SHARE_FONT;
      var lh = nm.size * 1.12, total = nm.lines.length * lh + (line ? 50 : 0), y0 = py + ph / 2 - total / 2 + lh / 2;
      nm.lines.forEach(function (l, i) { g.fillText(l, W / 2, y0 + i * lh); });
      if (line) { var ln = fitLines(g, line, W - 170, 1, 36, 24, '700'); g.font = '700 ' + ln.size + 'px ' + SHARE_FONT; g.fillStyle = '#2d4a73'; g.fillText(ln.lines[0], W / 2, y0 + nm.lines.length * lh + 14); }
      // handle
      g.font = '900 46px ' + SHARE_FONT; g.lineWidth = 10; g.strokeStyle = INK; g.strokeText(SHARE_HANDLE, W / 2, 1305); g.fillStyle = '#fff'; g.fillText(SHARE_HANDLE, W / 2, 1305);
      return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.9); });
    });
  }
  function shareFind() {
    var it = S.current; if (!it || !shareable(it)) return;
    busy('Making your share picture\u2026');
    var main = (S.gallery || []).filter(function (x) { return !x.video && x.thumb; })[0];
    var photoP = main ? call('getPhotoLarge', it.key, main.id).then(function (r) { return (r && r.src) || main.thumb; }, function () { return main.thumb; })
      : Promise.resolve(it.folderId ? S.thumbs[it.folderId] || null : null);
    photoP.then(function (src) { return makeShareCard(it, src); }).then(function (blob) {
      done();
      if (!blob) throw new Error('Couldn\u2019t make the picture on this phone.');
      var fname = String(it.name || 'find').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) + '-fathersoncollections.jpg';
      var file = null; try { file = new File([blob], fname, { type: 'image/jpeg' }); } catch (e) { file = null; }
      var canFiles = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
      var url = URL.createObjectURL(blob);
      S.shareUrl = url;
      var btns = [];
      if (canFiles) btns.push({ label: '\uD83D\uDCE4 Share', value: 'share', cls: 'main' });
      btns.push({ label: '\u2B07\uFE0F Save picture', value: 'save', cls: canFiles ? '' : 'main' }, { label: 'Close', value: 'close' });
      return sheet('\uD83D\uDCE4 Share this find', '<img class="sharePrev" alt="Share picture preview" src="' + url + '"><p class="hint center">1080\u00D71350 \u00B7 ready for Instagram. No prices on it, ever.</p>', btns).then(function (v) {
        if (v === 'share') return navigator.share({ files: [file], title: it.name, text: it.name + ' \u2013 ' + SHARE_HANDLE }).catch(function (e) { if (e && e.name !== 'AbortError') saveBlob(url, fname); });
        if (v === 'save') saveBlob(url, fname);
      });
    }).catch(oops);
  }
  function saveBlob(url, name) { var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 500); toast('\u2B07\uFE0F Saved to your downloads', 'good'); }

  /* Price check: just links (no scraping) */
  function priceQuery(it) {
    var q = String(it.name || '').replace(/\((?:x?\d+|copy|spare|duplicate|second|2nd)[^)]*\)/ig, '').replace(/[\u2018\u2019]/g, '\'').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/simpsons/i.test(q)) q = 'Simpsons ' + q;
    return q;
  }
  function ebaySoldUrl(q, sop) { return 'https://www.ebay.co.uk/sch/i.html?_nkw=' + encodeURIComponent(q).replace(/%20/g, '+') + '&LH_Sold=1&LH_Complete=1' + (sop ? '&_sop=' + sop : ''); }
  function priceBoxHtml(it) {
    var q = priceQuery(it), a = function (href, label, cls) { return '<a class="btn small ' + (cls || '') + '" href="' + esc(href) + '" target="_blank" rel="noopener">' + label + '</a>'; };
    return '<div class="card skyL" id="priceBox"><h3>\uD83D\uDD0E Price check</h3><p class="hint">Opens eBay UK <b>sold</b> listings for \u201C' + esc(q) + '\u201D. Nothing is saved.</p><div class="row wrap">' +
      a(ebaySoldUrl(q, 13), 'eBay sold \u00B7 newest', 'yel') + a(ebaySoldUrl(q, 16), 'eBay sold \u00B7 highest \u00A3') + a(ebaySoldUrl(q, 15), 'eBay sold \u00B7 lowest \u00A3') +
      a('https://www.google.com/search?q=' + encodeURIComponent(q + ' sold price UK'), 'Google') + '</div></div>';
  }

  /* ---------------- Spares & duplicates ---------------- */
  var LOOSE_STOP = /\b(the|and|of|a|an|loose|boxed|carded|sealed|mib|moc|new|vintage|figure|figurine|toy|simpsons)\b/g;
  function looseKey(name) {
    return String(name || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9#]+/g, ' ').replace(LOOSE_STOP, ' ').replace(/\s+/g, ' ').trim();
  }
  SCREENS.spares = function () {
    busy('Looking for doubles\u2026');
    Promise.all([call('getDuplicates', S.role), loadBoot().catch(function () { return null; })]).then(function (res) {
      done();
      var d = res[0], priv = isPriv();
      var ok = function (it) { return !neverShow(it.name) && (priv || !sonHidden(it.name)); };
      var groups = d.groups.map(function (g) { return { name: g.name, copies: g.copies, items: g.items.filter(ok) }; }).filter(function (g) { return g.items.length && !neverShow(g.name); });
      S.spares = d;
      var inGroup = {}; groups.forEach(function (g) { g.items.forEach(function (it) { inGroup[it.key] = 1; }); });
      var loose = {};
      (S.items || []).filter(function (it) { return isOwned(it) && ok(it) && !inGroup[it.key]; }).forEach(function (it) { var k = looseKey(it.name); if (k.length >= 4) (loose[k] = loose[k] || []).push(it); });
      var maybe = Object.keys(loose).map(function (k) { return loose[k]; }).filter(function (l) { return l.length > 1; });
      var spareCopies = groups.reduce(function (s, g) { return s + g.copies - 1; }, 0);
      var valOf = function (g) { var vs = g.items.map(function (it) { return it.v; }).filter(function (v) { return v != null; }); return vs.length ? Math.max.apply(null, vs) : null; };
      var spareVal = priv ? groups.reduce(function (s, g) { var v = valOf(g); return s + (v != null ? v * (g.copies - 1) : 0); }, 0) : 0;
      var h = backBtn() + '<h1>\uD83D\uDD01 Spares & duplicates</h1><p class="hint">Things we own more than once - handy to swap or sell. Tap <b>Mark for sale</b> on the copy to let go (it stays in the sheet).</p>' +
        '<div class="card yel center"><b style="font-size:22px">' + groups.length + '</b> thing' + (groups.length === 1 ? '' : 's') + ' owned more than once \u00B7 <b>' + spareCopies + '</b> spare cop' + (spareCopies === 1 ? 'y' : 'ies') +
        (priv && spareVal ? '<br>\uD83D\uDD12 Spares worth about <b>' + gbp(spareVal) + '</b>' : '') + '</div>';
      if (!groups.length) h += '<div class="nudge">No doubles found - every name is different. \uD83C\uDF89</div>';
      h += groups.map(function (g) {
        var why = g.items.length === 1 ? 'Quantity ' + g.copies + ' on one row' : g.items.length + ' rows with the same name' + (g.copies > g.items.length ? ' (plus quantity)' : '');
        var v = priv ? valOf(g) : null;
        return '<div class="card"><h3>' + esc(g.name) + ' <span class="pill amber">\u00D7' + g.copies + '</span></h3><p class="hint">' + esc(why) + (v != null ? ' \u00B7 \uD83D\uDD12 about ' + gbp(v) + ' each' : '') + '</p><div class="list">' + g.items.map(function (it) {
          return '<div class="li">' + thumbHtml(it) + '<div class="grow" data-act="item" data-key="' + esc(it.key) + '">' + esc(it.id || 'No ID') + '<small>' + esc([it.condition, it.packaging, it.status].filter(Boolean).join(' \u00B7 ')) + (priv && it.v != null ? ' \u00B7 ' + gbp(it.v) : '') + '</small></div>' +
            (/for sale/i.test(it.status) ? '<span class="pill green">For sale</span>' : '<button class="btn small yel" data-act="markSale" data-key="' + esc(it.key) + '" data-name="' + esc(it.name) + '">Mark for sale</button>') + '</div>';
        }).join('') + '</div></div>';
      }).join('');
      if (maybe.length) h += '<h2>\uD83E\uDD14 Might be doubles</h2><p class="hint">Names that nearly match (ignoring brackets, years and words like loose/boxed). Check them - they may be different versions.</p>' + maybe.slice(0, 40).map(function (l) {
        return '<div class="card"><div class="list">' + l.map(function (it) { return '<button class="li" data-act="item" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc([it.id, it.condition, it.packaging].filter(Boolean).join(' \u00B7 ')) + (priv && it.v != null ? ' \u00B7 ' + gbp(it.v) : '') + '</small></div><span>\u203A</span></button>'; }).join('') + '</div></div>';
      }).join('');
      var fs = d.forSale.filter(ok);
      if (fs.length) h += '<h2>Marked for sale (' + fs.length + ')</h2><div class="grid">' + fs.map(cardHtml).join('') + '</div>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };

  /* ---------------- dates from the sheet's free-text columns ---------------- */
  var MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MON_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function parseLoose(s) {
    s = String(s || '').trim();
    if (!s || /^(unknown|n\/?a|none|-|no photos|tbc|\?)/i.test(s)) return null;
    var m, mk = function (y, mo, d, p) { if (y < 100) y += 2000; if (mo < 0 || mo > 11 || y < 1950 || y > 2100) return null; return { t: Date.UTC(y, mo, d || 1), y: y, m: mo, d: d || 0, p: p }; };
    if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/))) return mk(+m[1], +m[2] - 1, +(m[3] || 0), m[3] ? 'd' : 'm');
    if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/)) && MON[m[2].slice(0, 3).toLowerCase()] != null) return mk(+m[3], MON[m[2].slice(0, 3).toLowerCase()], +m[1], 'd');
    if ((m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\b/)) && MON[m[1].slice(0, 3).toLowerCase()] != null) return mk(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2], 'd');
    if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/))) return mk(+m[3], +m[2] - 1, +m[1], 'd');
    if ((m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/)) && MON[m[1].slice(0, 3).toLowerCase()] != null) return mk(+m[2], MON[m[1].slice(0, 3).toLowerCase()], 0, 'm');
    if ((m = s.match(/\b(19[5-9]\d|20\d\d)\b/))) return mk(+m[1], 0, 0, 'y');
    return null;
  }
  var HIST = { data: null, at: 0, role: '' };
  function loadHistory() {
    var who = (S.kid ? 'k' : '') + S.role + (isPriv() ? 'p' : '');
    if (HIST.data && HIST.role === who && Date.now() - HIST.at < 300000) return Promise.resolve(HIST.data);
    return call('getHistory', S.role).then(function (rows) {
      var m = {}; (rows || []).forEach(function (r) { m[r.key] = r; });
      HIST.data = m; HIST.at = Date.now(); HIST.role = who; return m;
    }, function (e) { if (/unknown action/i.test((e && e.message) || '')) return null; throw e; });
  }
  /* bought (Dad only) > got > photo date (when it was added) */
  function whenOf(h) {
    if (!h) return null;
    var tries = [[h.pd, 'Bought'], [h.dg, 'Got'], [h.ph, 'Added']];
    for (var i = 0; i < tries.length; i++) { var d = parseLoose(tries[i][0]); if (d) { d.src = tries[i][1]; d.raw = tries[i][0]; return d; } }
    return null;
  }
  function dateLabel(d) {
    if (d.p === 'd') return d.d + ' ' + MON_NAMES[d.m].slice(0, 3);
    if (d.p === 'm') return MON_NAMES[d.m].slice(0, 3);
    return 'Sometime';
  }

  /* ---------------- v7q: milestones, on this day, set bars, swaps, week card, spin the wheel ---------------- */
  function funOwned() {
    return (S.kid ? (typeof kidItems === 'function' ? kidItems() : (S.items || []).filter(function (it) { return isOwned(it) && kidVisible(it); })) : (S.items || []).filter(function (it) { return isOwned(it) && !neverShow(it.name); }));
  }
  function milestoneMarks(n) {
    var out = [425, 450, 500], x = 550;
    while (x <= n + 50) { out.push(x); x += 50; }
    return out.filter(function (t) { return t <= n; });
  }
  function loadMileBook() {
    try { return JSON.parse(LS.get('milestones') || 'null') || { init: false, counts: [], sets: {} }; }
    catch (e) { return { init: false, counts: [], sets: {} }; }
  }
  function saveMileBook(b) { try { LS.set('milestones', JSON.stringify(b)); } catch (e) { /* ignore */ } }
  function checkMilestones() {
    Promise.resolve(loadChecklists()).then(function (cls) {
      var n = (S.items || []).filter(function (it) { return isOwned(it) && !neverShow(it.name); }).length;
      var reached = milestoneMarks(n);
      var doneSets = (cls || []).filter(function (c) { return c && c.total > 0 && c.owned >= c.total; }).map(function (c) { return { id: c.tab, title: clTitle(c.tab || c.title || '') }; });
      var book = loadMileBook();
      if (!book.init) {
        book.init = true;
        book.counts = reached.slice();
        book.sets = {};
        doneSets.forEach(function (s) { book.sets[s.id] = 1; });
        saveMileBook(book);
        return;
      }
      var newCounts = reached.filter(function (t) { return book.counts.indexOf(t) < 0; });
      var newSets = doneSets.filter(function (s) { return !book.sets[s.id]; });
      if (!newCounts.length && !newSets.length) return;
      newCounts.forEach(function (t) { book.counts.push(t); });
      newSets.forEach(function (s) { book.sets[s.id] = 1; });
      saveMileBook(book);
      celebrateMilestones(newCounts, newSets, n);
    }).catch(noop);
  }
  function celebrateMilestones(counts, sets, n) {
    confetti();
    var bits = [];
    counts.forEach(function (t) { bits.push('We just hit <b>' + t + '</b> things in the collection!'); });
    sets.forEach(function (s) { bits.push('The <b>' + esc(s.title) + '</b> set is complete!'); });
    sheet('\uD83C\uDF89 Milestone!', '<p>' + bits.join('</p><p>') + '</p><p class="hint">' + (n ? n + ' things and counting.' : '') + '</p>', [{ label: 'Yay!', value: 'ok', cls: 'main' }]);
  }
  var CLS_CACHE = { data: null, at: 0 };
  function loadChecklists() {
    if (CLS_CACHE.data && Date.now() - CLS_CACHE.at < 300000) return Promise.resolve(CLS_CACHE.data);
    return call('getChecklists').then(function (cls) {
      CLS_CACHE.data = cls || []; CLS_CACHE.at = Date.now(); return CLS_CACHE.data;
    }, function () { return CLS_CACHE.data || []; });
  }
  function sortSetsClosest(cls) {
    return (cls || []).slice().filter(function (c) { return c && c.total > 0; }).sort(function (a, b) {
      var ac = a.owned >= a.total, bc = b.owned >= b.total;
      if (ac !== bc) return ac ? 1 : -1;
      var ar = a.total - a.owned, br = b.total - b.owned;
      if (ar !== br) return ar - br;
      return pct(b.owned, b.total) - pct(a.owned, a.total) || String(a.title || a.tab).localeCompare(String(b.title || b.tab));
    });
  }
  function setBarsHtml(cls, limit) {
    var list = sortSetsClosest(cls);
    if (!list.length) return '';
    var show = limit ? list.slice(0, limit) : list;
    var rows = show.map(function (c) {
      var p = pct(c.owned, c.total), done = c.owned >= c.total;
      return '<button type="button" class="setBarRow' + (done ? ' done' : '') + '" data-act="go" data-to="checklist" data-tab="' + esc(c.tab) + '">' +
        '<span class="setBarName"><b>' + esc(clTitle(c.tab || c.title || '')) + '</b><small>' + c.owned + '/' + c.total + (done ? ' \u2014 complete!' : '') + '</small></span>' +
        '<span class="bar setBar" role="img" aria-label="' + p + ' percent"><div style="width:' + p + '%"></div></span></button>';
    }).join('');
    return '<div class="funCard setCard"><h2>Set progress</h2><p class="funSub">Closest to a finished set first</p>' + rows +
      (list.length > show.length ? '<button type="button" class="btn small" data-act="go" data-to="checklists">See all sets</button>' : '') + '</div>';
  }
  function onThisDayItems(hist) {
    var today = londonDay(), parts = today.split('-'), mo = +parts[1], day = +parts[2], yr = +parts[0];
    var out = [], seen = {};
    function add(it, when, kind, year) {
      if (!it || (S.kid && !kidVisible(it))) return;
      if (neverShow(it.name)) return;
      var k = (it.key || it.name) + '|' + kind + '|' + year;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ it: it, kind: kind, year: year, ago: yr - year, when: when });
    }
    var items = S.items || [];
    var byKey = {};
    items.forEach(function (it) { byKey[it.key] = it; });
    function consider(it, raw, kind, allow) {
      if (!allow || !raw) return;
      var d = parseLoose(raw);
      if (!d || d.p !== 'd' || d.m !== mo - 1 || d.d !== day || d.y >= yr) return;
      add(it, d, kind, d.y);
    }
    if (hist) {
      Object.keys(hist).forEach(function (key) {
        var h = hist[key], it = byKey[key];
        if (!it) return;
        consider(it, h.dg, 'Got', true);
        consider(it, h.ph, 'Filmed', true);
        consider(it, h.pd, 'Bought', isPriv() && !S.kid);
      });
    }
    items.forEach(function (it) {
      consider(it, it.dg || it.dateGot, 'Got', true);
      consider(it, it.ph || it.photoDate, 'Filmed', true);
      consider(it, it.pd || it.purchaseDate, 'Bought', isPriv() && !S.kid);
    });
    out.sort(function (a, b) { return b.year - a.year || String(a.it.name).localeCompare(String(b.it.name)); });
    return out;
  }
  function onThisDayHtml(rows) {
    if (!rows || !rows.length) return '';
    var body = rows.slice(0, 8).map(function (r) {
      var ago = r.ago === 1 ? '1 year ago' : r.ago + ' years ago';
      return '<button type="button" class="onDayRow" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(r.it.key) + '">' +
        thumbHtml(r.it) + '<span class="grow"><b>' + esc(r.it.name) + '</b><small>' + esc(r.kind) + ' \u00B7 ' + ago + ' (' + r.year + ')</small></span><span>\u203A</span></button>';
    }).join('');
    return '<div class="funCard onDayCard"><h2>On this day</h2><p class="funSub">From years gone by</p><div class="onDayList">' + body + '</div></div>';
  }
  function weekSummaryHtml(r) {
    if (!r) return '';
    var from = rwAddDaysLocal(londonDay(), -6);
    function inWeek(iso, day) {
      var d = String(day || (iso || '').slice(0, 10));
      return d >= from;
    }
    var log = rwArr(r.log || r.recent);
    var pts = 0, acts = { photo: 0, add: 0, found: 0, update: 0, job: 0, streak: 0 };
    log.forEach(function (x) {
      if (!inWeek(x.when, x.day)) return;
      pts += Number(x.points) || 0;
      if (acts[x.action] != null) acts[x.action]++;
    });
    var asks = rwArr(r.requests || r.pendingRequests).filter(function (q) { return inWeek(q.when); }).length;
    var waiting = r.waiting || (r.queue ? r.queue.length : 0) || 0;
    var lines = [
      ['\uD83D\uDCF8 Photos approved', acts.photo],
      ['\u2795 New items', acts.add],
      ['\u2B50 Ticked off', acts.found],
      ['\uD83E\uDDF9 Jobs done', acts.job],
      ['\u2B50 Points earned', pts]
    ];
    return '<div class="funCard weekCard"><h2>Last 7 days</h2><p class="funSub">The week\u2019s haul \u2014 ' + esc(KID_ROLE) + '\u2019s points, photos and jobs</p><div class="weekGrid">' +
      lines.map(function (l, i) { return '<div class="weekCell wc' + i + '"><b>' + l[1] + '</b><small>' + l[0] + '</small></div>'; }).join('') +
      '</div><p class="hint">' + (asks ? asks + ' reward ask' + (asks === 1 ? '' : 's') + ' in the last week. ' : '') +
      (waiting ? waiting + ' photo' + (waiting === 1 ? '' : 's') + ' waiting for you.' : 'No photos waiting.') + '</p>' +
      '<button type="button" class="btn main" data-act="go" data-to="rewards">Open rewards</button></div>';
  }
  function rwAddDaysLocal(day, k) {
    var p = String(day || '').split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + k));
    return d.toISOString().slice(0, 10);
  }
  function paintHomeFun() {
    var dayEl = $('homeOnThisDay') || $('kidOnThisDay');
    var setEl = $('homeSetBars') || $('kidSetBars');
    var weekEl = $('homeWeek');
    if (dayEl) {
      var paintDay = function (hist) {
        try { dayEl.innerHTML = onThisDayHtml(onThisDayItems(hist)); if (typeof watchThumbs === 'function') watchThumbs(); } catch (e) { dayEl.innerHTML = ''; }
      };
      loadHistory().then(paintDay, function () { paintDay(null); });
    }
    if (setEl) loadChecklists().then(function (cls) { try { setEl.innerHTML = setBarsHtml(cls, 6); } catch (e) { setEl.innerHTML = ''; } }, noop);
    if (weekEl && isPriv() && !S.kid) loadRewards(true).then(function (r) { try { weekEl.innerHTML = weekSummaryHtml(r); } catch (e) { weekEl.innerHTML = ''; } }, noop);
  }
  function wheelPool() {
    var all = funOwned();
    var prefer = all.filter(function (it) { return !it.posted; });
    return prefer.length ? prefer : all;
  }
  SCREENS.wheel = function () {
    loadBoot().then(function () {
      var pool = wheelPool();
      var h = backBtn() + '<h1>\uD83C\uDFA1 Spin the wheel</h1>' +
        '<p class="hint">' + (pool.length ? 'Picks something we already own to film next. Prefers things not posted yet.' : 'Add some items first, then have a spin.') + '</p>' +
        '<div class="wheelWrap"><div class="wheelPointer" aria-hidden="true"></div><div class="wheel" id="funWheel" aria-hidden="true"></div></div>' +
        '<p class="center"><button type="button" class="btn main" data-act="wheelSpin" id="wheelBtn"' + (pool.length ? '' : ' disabled') + '>Spin</button></p>' +
        '<div id="wheelOut"></div>';
      setMain(h);
      paintWheelFace(pool);
    }).catch(oops);
  }
  function paintWheelFace(pool) {
    var el = $('funWheel'); if (!el) return;
    var n = Math.max(6, Math.min(12, (pool || []).length || 6));
    var cols = ['#FED90F', '#70CCF5', '#F49AC2', '#7BD389', '#FFB347', '#C77DFF', '#E4572E', '#D8F1FC'];
    var stops = [];
    for (var i = 0; i < n; i++) stops.push(cols[i % cols.length] + ' ' + (i * 360 / n) + 'deg ' + ((i + 1) * 360 / n) + 'deg');
    el.style.background = 'conic-gradient(' + stops.join(',') + ')';
    el.style.transform = 'rotate(0deg)';
    el.setAttribute('data-slices', String(n));
  }
  function spinTheWheel() {
    var pool = wheelPool();
    if (!pool.length) { toast('Nothing to film yet \u2014 add an item first.', 'oops'); return; }
    var pick = pool[Math.floor(Math.random() * pool.length)];
    var el = $('funWheel'), btn = $('wheelBtn'), out = $('wheelOut');
    var slices = el ? (+el.getAttribute('data-slices') || 8) : 8;
    var slice = Math.floor(Math.random() * slices);
    var dest = 360 * (6 + Math.floor(Math.random() * 3)) + (360 - (slice * 360 / slices) - 360 / slices / 2);
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = '<p class="hint">Spinning\u2026</p>';
    var reduce = false;
    try { reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduce = false; }
    var finish = function () {
      if (btn) btn.disabled = false;
      if (out) {
        out.innerHTML = '<div class="funCard wheelResult" id="wheelResult">' + thumbHtml(pick) +
          '<h2>' + esc(pick.name) + '</h2>' +
          '<p class="hint">' + esc([pick.range, pick.series].filter(Boolean).join(' \u00B7 ') || 'Our pick to film next') +
          (pick.posted ? '' : ' \u00B7 not posted yet') + '</p>' +
          '<button type="button" class="btn main" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(pick.key) + '">Open this item</button>' +
          '<button type="button" class="btn" data-act="wheelSpin">Spin again</button></div>';
        if (typeof watchThumbs === 'function') watchThumbs();
        try { out.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e2) {}
      }
    };
    if (!el || reduce) { finish(); return; }
    el.style.transition = 'none';
    el.style.transform = 'rotate(0deg)';
    // force reflow
    void el.offsetWidth;
    el.style.transition = 'transform 3.2s cubic-bezier(0.12, 0.7, 0.2, 1)';
    el.style.transform = 'rotate(' + dest + 'deg)';
    setTimeout(finish, 3300);
  }
  SCREENS.swaps = function () {
    busy('Looking for doubles\u2026');
    Promise.all([call('getDuplicates', S.kid ? KID_ROLE : S.role), loadBoot().catch(function () { return null; })]).then(function (res) {
      done();
      var d = res[0] || { groups: [], forSale: [] };
      var ok = function (it) { return !neverShow(it.name) && (!S.kid || kidVisible(it)); };
      var groups = (d.groups || []).map(function (g) { return { name: g.name, copies: g.copies, items: (g.items || []).filter(ok) }; }).filter(function (g) { return g.items.length && !neverShow(g.name); });
      var h = backBtn() + '<h1>\uD83D\uDD01 Doubles to swap</h1><p class="hint">Things we own more than once \u2014 handy if we want to swap. Tap a photo to open it.' + (S.kid ? '' : ' (For sale / values stay on Spares.)') + '</p>';
      if (!groups.length) h += '<div class="nudge">No doubles found just now.</div>';
      h += groups.map(function (g) {
        return '<div class="card"><h3>' + esc(g.name) + ' <span class="pill">\u00D7' + g.copies + '</span></h3><div class="swapGrid">' +
          g.items.map(function (it) {
            return '<button type="button" class="swapTile" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(it.key) + '">' +
              thumbHtml(it) + '<b>' + esc(it.id || it.name) + '</b><small>' + esc([it.condition, it.status].filter(Boolean).join(' \u00B7 ')) + '</small></button>';
          }).join('') + '</div></div>';
      }).join('');
      setMain(h);
      watchThumbs();
    }).catch(oops);
  }
  function paintHomeFunAndMiles() {
    paintHomeFun();
    checkMilestones();
  }


  /* ---------------- Item history (timeline) ---------------- */
  SCREENS.history = function () {
    busy('Building the timeline\u2026');
    Promise.all([loadBoot(), loadHistory()]).then(function (r) {
      done();
      var hist = r[1], priv = isPriv();
      if (!hist) { setMain(backBtn() + '<h1>\uD83D\uDDD3\uFE0F Item history</h1><div class="nudge">This needs the latest Apps Script (v4.3). Ask ' + esc(PRIV) + ' to paste it in - then this page fills itself from the sheet.</div>'); return; }
      var items = (S.items || []).filter(function (it) { return !neverShow(it.name) && (priv || !sonHidden(it.name)) && (!S.kid || kidVisible(it)); });
      var dated = [], undated = [];
      items.forEach(function (it) { var h = hist[it.key], d = whenOf(h); if (d) dated.push({ it: it, h: h, d: d }); else undated.push(it); });
      dated.sort(function (a, b) { return b.d.t - a.d.t || (b.d.p === 'd') - (a.d.p === 'd'); });
      var f = S.histFilter || '';
      var shownList = f ? dated.filter(function (x) { return x.d.src === f; }) : dated;
      var groups = [], cur = null;
      shownList.slice(0, S.histShown || 150).forEach(function (x) {
        var k = x.d.p === 'y' ? x.d.y + '' : x.d.y + '-' + x.d.m;
        if (!cur || cur.k !== k) { cur = { k: k, title: x.d.p === 'y' ? x.d.y + ' (month not known)' : MON_NAMES[x.d.m] + ' ' + x.d.y, rows: [], spent: 0 }; groups.push(cur); }
        cur.rows.push(x); if (priv && x.h && x.h.p != null) cur.spent += x.h.p;
      });
      var chip = function (v, l) { return '<button class="chip' + (f === v ? ' on' : '') + '" data-act="histFilter" data-v="' + v + '">' + l + '</button>'; };
      var h = backBtn() + '<h1>\uD83D\uDDD3\uFE0F Item history</h1><p class="hint">When things joined the collection, newest first. Uses Purchase Date' + (priv ? '' : ' (Dad only)') + ', then Date got, then Photo date from the sheet.</p>' +
        '<div class="chips">' + chip('', 'All (' + dated.length + ')') + (priv ? chip('Bought', 'Bought') : '') + chip('Got', 'Got') + chip('Added', 'Added (photo date)') + '</div>' +
        '<div class="timeline">' + groups.map(function (g) {
          return '<div class="tlMonth"><h2>' + esc(g.title) + ' <span class="pill">' + g.rows.length + '</span>' + (priv && g.spent ? ' <span class="pill amber">\uD83D\uDD12 ' + gbp(g.spent) + '</span>' : '') + '</h2>' + g.rows.map(function (x) {
            var meta = [dateLabel(x.d) + ' \u00B7 ' + x.d.src, x.h && x.h.w ? x.h.w : ''].filter(Boolean).join(' \u00B7 ');
            return '<button class="li tlRow" data-act="item" data-key="' + esc(x.it.key) + '"><span class="tlDot"></span>' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) +
              '<small>' + esc([x.it.range].filter(Boolean).join('')) + '</small><small class="tlMeta">' + esc(meta) + (priv && x.h && x.h.p != null ? ' \u00B7 <b>' + gbp(x.h.p) + '</b>' : '') + '</small></div></button>';
          }).join('') + '</div>';
        }).join('') + '</div>' +
        (shownList.length > (S.histShown || 150) ? '<p class="center"><button class="btn" data-act="histMore">Show more (' + (shownList.length - (S.histShown || 150)) + ' left)</button></p>' : '') +
        '<details class="card"' + (undated.length && !dated.length ? ' open' : '') + '><summary>\u2753 No date yet: <b>' + undated.length + '</b> item' + (undated.length === 1 ? '' : 's') + '</summary><p class="hint">These have no usable Purchase Date, Date got or Photo date. Add one in the sheet (e.g. \u201C12 Oct 2026\u201D or \u201COct 2026\u201D) and they\u2019ll slot in.</p><div class="list">' +
        undated.slice(0, 300).map(function (it) { return '<button class="li" data-act="item" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc([it.id, it.range].filter(Boolean).join(' \u00B7 ')) + '</small></div><span>\u203A</span></button>'; }).join('') + '</div></details>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };

  /* ---------------- Badges for Son's mode (from the collection; no money; secret/Christmas never count) ---------------- */
  var RARE_RE = /limited|exclusive|\bchase\b|\brare\b|signed|autograph|convention|sdcc|\bglow\b|glow in the dark|metallic|flocked|numbered|\b1 of\b|prototype|special edition/i;
  var CAT_ICONS = [[/funko|pop/i, '\uD83E\uDDF8'], [/pez/i, '\uD83C\uDF6C'], [/badge|pin/i, '\uD83D\uDCCC'], [/plush|soft/i, '\uD83E\uDDF8'], [/lego|mega|build/i, '\uD83E\uDDF1'], [/coalport|figurine|ornament/i, '\uD83C\uDFFA'], [/springfield|playmates|figure/i, '\uD83E\uDDB8'], [/game|puzzle/i, '\uD83C\uDFB2'], [/book|comic/i, '\uD83D\uDCDA'], [/sign|wall|poster/i, '\uD83D\uDDBC\uFE0F'], [/talk|electronic/i, '\uD83D\uDD0A'], [/key/i, '\uD83D\uDD11'], [/tin|mug|cup/i, '\u2615'], [/fast food|burger|kfc|meal/i, '\uD83C\uDF54']];
  var CAT_TIERS = [[5, 'Starter'], [10, 'Fan'], [25, 'Super Fan'], [50, 'Mega Fan'], [100, 'Legend']];
  var CHARS = [['Homer', 'Homer Hero', '\uD83C\uDF69'], ['Bart', 'Bart Buddy', '\uD83D\uDEF9'], ['Lisa', 'Lisa Legend', '\uD83C\uDFB7'], ['Marge', 'Marge Master', '\uD83D\uDC99'], ['Maggie', 'Maggie Mate', '\uD83C\uDF7C'], ['Krusty', 'Krusty Crew', '\uD83E\uDD21'], ['Burns', 'Excellent!', '\uD83D\uDC74'], ['Flanders', 'Okily Dokily', '\uD83D\uDC4B'], ['Milhouse', 'Milhouse Mate', '\uD83D\uDC53'], ['Ralph', 'I\u2019m Helping!', '\uD83D\uDE00']];
  function catIcon(r) { for (var i = 0; i < CAT_ICONS.length; i++) if (CAT_ICONS[i][0].test(r)) return CAT_ICONS[i][1]; return '\u2B50'; }
  function kidCount(k) { return +LS.get(k) || 0; }
  function bumpKid(k, n) { LS.set(k, String(kidCount(k) + (n || 1))); }
  var BADGE_TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'elite', 'champion', 'unreal'];
  var BADGE_TIER_NAME = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', elite: 'Elite', champion: 'Champion', unreal: 'Unreal' };
  var BADGE_CATALOG = [
    { id: 'drop-in', tier: 'bronze', emoji: '\uD83C\uDF91', name: 'First Drop-In', goal: 'Open Son\u2019s mode for the first time.', rule: { type: 'starter' } },
    { id: 'wee-welcome', tier: 'bronze', emoji: '\uD83D\uDC4B', name: 'Wee Welcome', goal: 'Say hi on the home screen.', rule: { type: 'starter' } },
    { id: 'snap-happy', tier: 'bronze', emoji: '\uD83D\uDCF8', name: 'Snap Happy', goal: 'Add 1 photo in Son\u2019s mode.', rule: { type: 'photos', n: 1 } },
    { id: 'first-find', tier: 'bronze', emoji: '\uD83D\uDD0D', name: 'First Find!', goal: 'Tick 1 item off the hunt list.', rule: { type: 'found', n: 1 } },
    { id: 'ten-pointer', tier: 'bronze', emoji: '\u2B50', name: 'Ten Pointer', goal: 'Earn 10 points.', rule: { type: 'points', n: 10 } },
    { id: 'back-again', tier: 'bronze', emoji: '\uD83D\uDC5F', name: 'Back Again', goal: 'Visit on 2 different days.', rule: { type: 'visits', n: 2 } },
    { id: 'new-shelf', tier: 'bronze', emoji: '\uD83D\uDCE6', name: 'New On The Shelf', goal: 'Add 1 new item to the collection.', rule: { type: 'items', n: 1 } },
    { id: 'joke-machine', tier: 'bronze', emoji: '\uD83D\uDE02', name: 'Joke Machine', goal: 'Tap the joke card 3 times.', rule: { type: 'jokes', n: 3 } },
    { id: 'worth-swipe', tier: 'bronze', emoji: '\uD83C\uDF69', name: 'Worth a Swipe', goal: 'Swipe or tap the worth card.', rule: { type: 'swipes', n: 1 } },
    { id: 'dad-note', tier: 'bronze', emoji: '\uD83D\uDCDD', name: 'Note From Dad', goal: 'Open a note or the letter from Dad.', rule: { type: 'reads', n: 1 } },
    { id: 'got-it-search', tier: 'bronze', emoji: '\uD83D\uDD0E', name: 'Have We Got It?', goal: 'Search for something on the home screen.', rule: { type: 'searches', n: 1 } },
    { id: 'box-scanner', tier: 'bronze', emoji: '\uD83D\uDCF7', name: 'Box Scanner', goal: 'Scan a box.', rule: { type: 'scans', n: 1 } },
    { id: 'camera-kid', tier: 'silver', emoji: '\uD83D\uDCF7', name: 'Camera Kid', goal: 'Add 5 photos in Son\u2019s mode.', rule: { type: 'photos', n: 5 } },
    { id: 'super-sleuth', tier: 'silver', emoji: '\uD83D\uDD75\uFE0F', name: 'Super Sleuth', goal: 'Tick 5 items off the hunt list.', rule: { type: 'found', n: 5 } },
    { id: 'fifty-pointer', tier: 'silver', emoji: '\uD83C\uDF1F', name: 'Fifty Pointer', goal: 'Earn 50 points.', rule: { type: 'points', n: 50 } },
    { id: 'week-visitor', tier: 'silver', emoji: '\uD83D\uDCC5', name: 'Week Visitor', goal: 'Visit on 5 different days.', rule: { type: 'visits', n: 5 } },
    { id: 'five-finds', tier: 'silver', emoji: '\uD83C\uDF81', name: 'Five New Finds', goal: 'Add 5 new items to the collection.', rule: { type: 'items', n: 5 } },
    { id: 'hunt-pair', tier: 'silver', emoji: '\uD83D\uDD2D', name: 'Hunt Pair', goal: 'Tick 2 items off the hunt list.', rule: { type: 'found', n: 2 } },
    { id: 'point-stash', tier: 'silver', emoji: '\uD83C\uDFC5', name: 'Point Stash', goal: 'Earn 25 points.', rule: { type: 'points', n: 25 } },
    { id: 'picture-day', tier: 'silver', emoji: '\uD83D\uDDBC\uFE0F', name: 'Picture Day', goal: 'Add 3 photos in Son\u2019s mode.', rule: { type: 'photos', n: 3 } },
    { id: 'joke-book', tier: 'silver', emoji: '\uD83D\uDCD6', name: 'Joke Book', goal: 'Tap the joke card 10 times.', rule: { type: 'jokes', n: 10 } },
    { id: 'fresh-cats', tier: 'silver', emoji: '\uD83D\uDDC2\uFE0F', name: 'Fresh Categories', goal: 'Add items in 2 new categories.', rule: { type: 'cats', n: 2 } },
    { id: 'camera-ace', tier: 'gold', emoji: '\uD83C\uDFAF', name: 'Camera Ace', goal: 'Add 10 photos in Son\u2019s mode.', rule: { type: 'photos', n: 10 } },
    { id: 'master-hunter', tier: 'gold', emoji: '\uD83C\uDFAF', name: 'Master Hunter', goal: 'Tick 10 items off the hunt list.', rule: { type: 'found', n: 10 } },
    { id: 'century-club', tier: 'gold', emoji: '\uD83C\uDFC6', name: 'Century Club', goal: 'Earn 100 points.', rule: { type: 'points', n: 100 } },
    { id: 'fortnight-fun', tier: 'gold', emoji: '\uD83C\uDFC3', name: 'Fortnight of Fun', goal: 'Visit on 10 different days.', rule: { type: 'visits', n: 10 } },
    { id: 'ten-treasures', tier: 'gold', emoji: '\uD83D\uDC8E', name: 'Ten Treasures', goal: 'Add 10 new items to the collection.', rule: { type: 'items', n: 10 } },
    { id: 'category-captain', tier: 'gold', emoji: '\uD83E\uDDED', name: 'Category Captain', goal: 'Add items in 3 new categories.', rule: { type: 'cats', n: 3 } },
    { id: 'seven-day', tier: 'gold', emoji: '\u2B50', name: 'Seven Day Hero', goal: 'Visit on 7 different days.', rule: { type: 'visits', n: 7 } },
    { id: 'shelf-star', tier: 'gold', emoji: '\uD83C\uDF1F', name: 'Shelf Star', goal: 'Add 15 new items to the collection.', rule: { type: 'items', n: 15 } },
    { id: 'photo-pro', tier: 'platinum', emoji: '\uD83D\uDCF8', name: 'Photo Pro', goal: 'Add 20 photos in Son\u2019s mode.', rule: { type: 'photos', n: 20 } },
    { id: 'hunt-legend', tier: 'platinum', emoji: '\uD83C\uDFC6', name: 'Hunt Legend', goal: 'Tick 20 items off the hunt list.', rule: { type: 'found', n: 20 } },
    { id: 'club-250', tier: 'platinum', emoji: '\uD83D\uDC8E', name: '250 Club', goal: 'Earn 250 points.', rule: { type: 'points', n: 250 } },
    { id: 'monthly-regular', tier: 'platinum', emoji: '\uD83D\uDCC5', name: 'Monthly Regular', goal: 'Visit on 20 different days.', rule: { type: 'visits', n: 20 } },
    { id: 'haul-hero', tier: 'platinum', emoji: '\uD83D\uDCE6', name: 'Haul Hero', goal: 'Add 25 new items to the collection.', rule: { type: 'items', n: 25 } },
    { id: 'range-master', tier: 'platinum', emoji: '\uD83C\uDFAF', name: 'Range Master', goal: 'Add items in 5 new categories.', rule: { type: 'cats', n: 5 } },
    { id: 'diamond-lens', tier: 'diamond', emoji: '\uD83D\uDC8E', name: 'Diamond Lens', goal: 'Add 40 photos in Son\u2019s mode.', rule: { type: 'photos', n: 40 } },
    { id: 'diamond-hunter', tier: 'diamond', emoji: '\uD83D\uDD0D', name: 'Diamond Hunter', goal: 'Tick 35 items off the hunt list.', rule: { type: 'found', n: 35 } },
    { id: 'diamond-points', tier: 'diamond', emoji: '\u2B50', name: 'Diamond Points', goal: 'Earn 500 points.', rule: { type: 'points', n: 500 } },
    { id: 'everyday-explorer', tier: 'diamond', emoji: '\uD83E\uDDED', name: 'Everyday Explorer', goal: 'Visit on 30 different days.', rule: { type: 'visits', n: 30 } },
    { id: 'mega-haul', tier: 'diamond', emoji: '\uD83C\uDFDB\uFE0F', name: 'Mega Haul', goal: 'Add 50 new items to the collection.', rule: { type: 'items', n: 50 } },
    { id: 'elite-camera', tier: 'elite', emoji: '\uD83D\uDCF7', name: 'Elite Camera', goal: 'Add 75 photos in Son\u2019s mode.', rule: { type: 'photos', n: 75 } },
    { id: 'elite-hunter', tier: 'elite', emoji: '\uD83C\uDFAF', name: 'Elite Hunter', goal: 'Tick 50 items off the hunt list.', rule: { type: 'found', n: 50 } },
    { id: 'elite-points', tier: 'elite', emoji: '\uD83C\uDF1F', name: 'Elite Points', goal: 'Earn 800 points.', rule: { type: 'points', n: 800 } },
    { id: 'elite-shelf', tier: 'elite', emoji: '\uD83D\uDCDC', name: 'Elite Shelf', goal: 'Add 75 new items to the collection.', rule: { type: 'items', n: 75 } },
    { id: 'champ-shelf', tier: 'champion', emoji: '\uD83C\uDFC6', name: 'Champion of the Shelf', goal: 'Add 100 new items to the collection.', rule: { type: 'items', n: 100 } },
    { id: 'champ-hunter', tier: 'champion', emoji: '\uD83D\uDD25', name: 'Champion Hunter', goal: 'Tick 80 items off the hunt list.', rule: { type: 'found', n: 80 } },
    { id: 'champ-points', tier: 'champion', emoji: '\uD83D\uDC51', name: 'Champion Points', goal: 'Earn 1,200 points.', rule: { type: 'points', n: 1200 } },
    { id: 'unreal-collector', tier: 'unreal', emoji: '\uD83D\uDE80', name: 'Unreal Collector', goal: 'Add 200 new items to the collection.', rule: { type: 'items', n: 200 } },
    { id: 'unreal-legend', tier: 'unreal', emoji: '\u2728', name: 'Unreal Legend', goal: 'Earn 2,000 points.', rule: { type: 'points', n: 2000 } }
  ];
  var BADGE_STARTERS = ['drop-in', 'wee-welcome'];

  function badgeBook() {
    try {
      var o = JSON.parse(LS.get('badgeBook') || 'null');
      if (o && o.v === 1) return o;
    } catch (e) {}
    return { v: 1, resetAt: '', baseline: null, earned: {}, override: {}, custom: [], visits: [] };
  }
  function saveBadgeBook(b) { LS.set('badgeBook', JSON.stringify(b)); }
  function badgeCatCount() {
    var o = {};
    kidItems().forEach(function (it) {
      var r = String(it.range || '').trim();
      if (r && !/^(unknown|other)$/i.test(r)) o[r] = 1;
    });
    return Object.keys(o).length;
  }
  function currentBadgeStats(rewards) {
    return {
      items: kidItems().length,
      photos: kidCount('kidPhotos'),
      found: kidCount('kidFound'),
      points: rewards && rewards.balance != null ? +rewards.balance : 0,
      jokes: kidCount('kidJokes'),
      swipes: kidCount('kidWorthSwipes'),
      scans: kidCount('kidScans'),
      searches: kidCount('kidSearches'),
      reads: kidCount('kidDadReads'),
      cats: badgeCatCount()
    };
  }
  function ensureBadgeBaseline(stats) {
    var b = badgeBook();
    if (!b.baseline) {
      b.resetAt = londonDay();
      b.baseline = stats;
      b.earned = b.earned || {};
      BADGE_STARTERS.forEach(function (id) { b.earned[id] = 1; });
      b.visits = b.visits || [];
      var d = londonDay();
      if (b.visits.indexOf(d) < 0) b.visits.push(d);
      saveBadgeBook(b);
      var seen = badgesSeen() || [];
      BADGE_STARTERS.forEach(function (id) { if (seen.indexOf(id) < 0) seen.push(id); });
      LS.set('kidBadgesSeen', JSON.stringify(seen));
    }
    return b;
  }
  function recordBadgeVisit() {
    var b = badgeBook();
    b.visits = b.visits || [];
    var d = londonDay();
    if (b.visits.indexOf(d) < 0) { b.visits.push(d); saveBadgeBook(b); }
  }
  function allBadgeDefs() {
    return BADGE_CATALOG.concat(badgeBook().custom || []);
  }
  function computeBadges(hist, rewards) {
    var stats = currentBadgeStats(rewards);
    var book = ensureBadgeBaseline(stats);
    var base = book.baseline || {};
    return allBadgeDefs().map(function (def) {
      var typ = (def.rule && def.rule.type) || 'manual';
      var need = typ === 'starter' ? 1 : Math.max(1, (def.rule && def.rule.n) || 1);
      var have = 0;
      if (typ === 'starter') have = 1;
      else if (typ === 'visits') have = (book.visits || []).length;
      else if (typ === 'manual') have = (book.earned && book.earned[def.id]) ? need : 0;
      else have = Math.max(0, (stats[typ] || 0) - (base[typ] || 0));
      have = Math.min(have, need);
      var got = have >= need;
      if (book.override && book.override[def.id] === 0) got = false;
      else if (book.override && book.override[def.id] === 1) got = true;
      if (got) have = need;
      return { id: def.id, icon: def.emoji, name: def.name, desc: def.goal, tier: def.tier || 'bronze', have: have, need: need, got: got, custom: !!def.custom, rule: typ };
    });
  }
  function badgesSeen() { try { return JSON.parse(LS.get('kidBadgesSeen') || 'null'); } catch (e) { return null; } }
  function ptsVal(r, key, fallback) {
    var n = parseInt(((r && r.points) || {})[key], 10);
    return (n >= 0 && n <= 100000) ? n : fallback;
  }
  function ptsLabel(n) { return n === 1 ? '1 pt' : n + ' pts'; }
  function earnJobs(r) {
    return builtInPointRules(r).filter(function (x) { return x.active !== false; }).map(function (x) {
      return { kind: x.key, auto: true, icon: x.emoji || jobEmoji(x.title), title: x.title, pts: x.pts, cost: x.pts, desc: x.desc };
    });
  }
  function collectionJobsHtml(r, kid) {
    if (kid == null) kid = !!S.kid;
    var items = earnJobs(r).concat(customCollectionJobs(r, false).map(function (j) {
      return { auto: false, id: j.id, icon: jobIcon(j), title: jobTitleDisplay(j), rawTitle: j.title, pts: j.pts, cost: j.pts, desc: j.desc || '', pending: j.pending, pendingId: j.pendingId, doneToday: j.doneToday, emoji: j.emoji };
    }));
    items = sortJobsList(items);
    if (!items.length) return '<p class="hint">No collection jobs on the list just now.</p>';
    var h = '<div class="earnJobs">';
    items.forEach(function (j) {
      if (j.auto) {
        h += '<button type="button" class="earnJob" data-act="earnGo" data-kind="' + esc(j.kind) + '">' +
          '<span class="eIc">' + (j.icon || jobEmoji(j.title)) + '</span>' +
          '<span class="eTxt"><b>' + esc(j.title) + '</b><small>' + esc(j.desc) + '</small></span>' +
          '<span class="ePts">' + ptsLabel(j.pts) + '</span></button>';
        return;
      }
      var pending = !!(j.pending || j.pendingId);
      var sub = j.doneToday ? (kid ? 'Done today \u2014 well done!' : 'Done today') :
        (pending ? 'Waiting for Dad' : (j.desc || (kid ? 'Tap when you\u2019ve done it' : 'Son taps, you approve with your PIN')));
      var tappable = !!(kid && !j.doneToday && !pending);
      var tag = tappable ? 'button' : 'div';
      var cls = 'earnJob jobRow' + (pending ? ' waiting' : '') + (j.doneToday ? ' done' : '');
      var act = tappable ? ' data-act="jobAsk" data-id="' + esc(j.id) + '"' : (' data-id="' + esc(j.pendingId || j.id || '') + '" data-title="' + esc(j.rawTitle || j.title) + '" data-cost="' + esc(j.cost) + '"');
      h += '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' class="' + cls + '"' + act + '>' +
        '<span class="eIc">' + (j.icon || jobIcon(j)) + '</span>' +
        '<span class="eTxt"><b>' + esc(j.title) + '</b><small>' + esc(sub) + '</small></span>' +
        '<span class="ePts">+' + j.cost + '</span>';
      if (!kid && pending && isPriv()) {
        h += '<span class="jobActs"><button type="button" class="btn green small" data-act="jobYes" data-id="' + esc(j.pendingId || j.id) + '">Approve</button>' +
          '<button type="button" class="btn small" data-act="jobNo" data-id="' + esc(j.pendingId || j.id) + '">No</button></span>';
      }
      h += '</' + tag + '>';
    });
    return h + '</div>';
  }
  function earnCardHtml(r, kid) { return waysToEarnHtml(r, kid); }
  function paintEarnPoints(r) { paintWaysToEarn(r); }
  function emojiMatches(s) {
    var t = String(s || '');
    try { return t.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || []; }
    catch (e) { return t.match(/[\uD800-\uDBFF][\uDC00-\uDFFF](?:\uFE0F\u20E3?|\uFE0F|\u20E3)?/g) || []; }
  }
  function stripEmojis(s) {
    var out = String(s || ''), list = emojiMatches(out), i;
    for (i = 0; i < list.length; i++) out = out.split(list[i]).join(' ');
    return out.replace(/\s+/g, ' ').trim();
  }
  function trailingEmojiCluster(s) {
    var t = String(s || '').trim(), list = emojiMatches(t), trail = '', i;
    if (!list.length) return '';
    for (i = list.length - 1; i >= 0; i--) {
      if (t.length >= list[i].length && t.slice(t.length - list[i].length) === list[i]) {
        trail = list[i] + trail;
        t = t.slice(0, t.length - list[i].length).trim();
      } else break;
    }
    return trail || list[0];
  }
  function jobEmoji(t) {
    var s = stripEmojis(t).toLowerCase();
    if (/clothes|put away|laundry|washing|\bsocks\b|\bshirt/.test(s)) return '\uD83D\uDC55';
    if (/plank|sit\s*-?\s*ups?|push\s*-?\s*ups?|press\s*-?\s*ups?|exercise|workout/.test(s)) return '\uD83D\uDCAA';
    if (/dishwasher|dishes|\bdish\b/.test(s)) return '\uD83C\uDF7D\uFE0F';
    if (/room|\bbed\b|bedroom/.test(s)) return '\uD83D\uDECF\uFE0F';
    if (/homework|\bread\b|\bbook|\bschool/.test(s)) return '\uD83D\uDCDA';
    if (/\bdog\b|\bwalk/.test(s)) return '\uD83D\uDC15';
    if (/\bcat\b|\bfeed(?:s|ing)?\b/.test(s)) return '\uD83D\uDC31';
    if (/rubbish|trash|\bbin\b/.test(s)) return '\uD83D\uDDD1\uFE0F';
    if (/teeth|toothbrush|brush your teeth/.test(s)) return '\uD83E\uDEA5';
    if (/\btidy\b|hoover|vacuum|\bsweep/.test(s)) return '\uD83E\uDDF9';
    if (/\bcar\b|\bdrive\b/.test(s)) return '\uD83D\uDE97';
    if (/garden|lawn|grass|\bplant/.test(s)) return '\uD83C\uDF31';
    return '\u2B50';
  }
  function jobIcon(j) {
    var saved = String((j && (j.icon || j.emoji)) || '').trim();
    if (saved) return saved;
    var fromName = trailingEmojiCluster(j && j.title);
    if (fromName) return fromName;
    return jobEmoji(j && j.title);
  }
  function jobTitleDisplay(j) {
    var title = String((j && j.title) || '');
    var cleaned = stripEmojis(title);
    return cleaned || title;
  }
  function jobsForHome(r) {
    return rwArr(r && r.jobs).filter(function (j) { return !j || j.kind !== 'collection'; });
  }
  function homeJobRowsHtml(r, kid) {
    var jobs = sortJobsList(jobsForHome(r || {}));
    if (!jobs.length) return '<p class="hint">No jobs on the list just now.</p>';
    var h = '<div class="jobRows">';
    jobs.forEach(function (j) {
      var pending = !!(j.pending || j.pendingId);
      var sub = j.doneToday ? (kid ? 'Done today \u2014 well done!' : 'Done today') :
        (pending ? 'Waiting for Dad' : (kid ? 'Tap when you\u2019ve done it' : 'Waiting for Son to tick this'));
      var cls = 'jobRow' + (pending ? ' waiting' : '') + (j.doneToday ? ' done' : '');
      var tappable = !!(kid && !j.doneToday && !pending);
      var tag = tappable ? 'button' : 'div';
      var act = tappable ? ' data-act="jobAsk" data-id="' + esc(j.id) + '"' : (' data-id="' + esc(j.pendingId || j.id || '') + '" data-title="' + esc(j.title || '') + '" data-cost="' + esc(j.cost || '') + '"');
      h += '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' class="' + cls + '"' + act + '>' +
        '<span class="eIc">' + jobIcon(j) + '</span>' +
        '<span class="eTxt"><b>' + esc(jobTitleDisplay(j)) + '</b><small>' + sub + '</small></span>' +
        '<span class="ePts">+' + j.cost + '</span>';
      if (!kid && pending && isPriv()) {
        h += '<span class="jobActs"><button type="button" class="btn green small" data-act="jobYes" data-id="' + esc(j.pendingId || j.id) + '">Approve</button>' +
          '<button type="button" class="btn small" data-act="jobNo" data-id="' + esc(j.pendingId || j.id) + '">No</button></span>';
      }
      h += '</' + tag + '>';
    });
    return h + '</div>';
  }
  function waysToEarnHtml(r, kid) {
    if (kid == null) kid = !!S.kid;
    var h = '<div class="waysCard"><h2>Ways to earn points</h2>';
    h += '<h3>\uD83E\uDDF9 Jobs at home</h3>';
    if (kid) h += '<p class="waysSub">Tap a job when it\u2019s done. Dad approves, then you get the points.</p>';
    else h += '<p class="waysSub">Son ticks these. Approve or say no with your PIN.</p>';
    h += homeJobRowsHtml(r, kid);
    if (!kid && isPriv()) h += '<button type="button" class="btn small waysOpen" data-act="go" data-to="rewards">Open jobs</button>';
    h += '<h3>\uD83D\uDCF8 Collection jobs</h3>';
    if (kid) h += '<p class="waysSub">Automatic ones happen as you go. Your own ones: tap when it\u2019s done, and Dad approves.</p>';
    else h += '<p class="waysSub">Automatic ones happen when he does them. Your own ones work like jobs at home \u2014 he taps, you approve.</p>';
    h += collectionJobsHtml(r, kid);
    return h + '</div>';
  }
  function jobsCardHtml(r, kid) { return waysToEarnHtml(r, kid); }
  function stillToFilmItems() {
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    return (S.items || []).filter(function (it) {
      if (it.folderId || !isOwned(it) || neverShow(it.name)) return false;
      if (S.kid) return kidVisible(it);
      return !sonHidden(it.name);
    }).sort(function (a, b) { return idn(b) - idn(a) || (b.row || 0) - (a.row || 0); });
  }
  function stillToFilmCardHtml() {
    var list = stillToFilmItems();
    if (!list.length) return '';
    var kid = !!S.kid, act = kid ? 'filmAsk' : 'item', cap = 8, shown = list.slice(0, cap);
    var h = '<div class="filmCard">' +
      '<h2>D\u2019oh! Still to film</h2>' +
      '<p class="waysSub">' + (kid
        ? 'Things you can film. Tap one when you\u2019ve taken photos, then Dad takes a look and you get the points when he says yes.'
        : 'Owned items with no photo folder yet. Tap one to open it and add a photo.') + '</p>' +
      '<div class="filmRows">';
    shown.forEach(function (it) {
      h += '<button type="button" class="filmRow" data-act="' + act + '" data-key="' + esc(it.key) + '">' +
        thumbHtml(it) +
        '<span class="filmTxt"><b>' + esc(it.name) + '</b><small>' + esc(it.range || 'No photo yet') + '</small></span>' +
        '</button>';
    });
    h += '</div>';
    if (list.length > cap) {
      if (kid) h += '<button type="button" class="btn small waysOpen" data-act="go" data-to="kidStuff">See all ' + list.length + '</button>';
      else h += '<button type="button" class="btn small waysOpen" data-act="filmSeeAll">See all ' + list.length + '</button>';
    }
    return h + '</div>';
  }
  function paintStillToFilm() {
    var el = $('kidFilm') || $('homeFilm');
    if (!el) return;
    el.innerHTML = stillToFilmCardHtml();
    if (el.innerHTML) watchThumbs();
  }
  function filmAskUI(key) {
    var it = itemByKey(key);
    if (!it || (S.kid && !kidVisible(it))) return;
    var pts = 0;
    try { pts = (RW && RW.points && RW.points.photo) || (S.rewards && S.rewards.points && S.rewards.points.photo) || 0; } catch (eP) { pts = 0; }
    var ptsBit = pts > 0 ? ' You get ' + pts + ' points when he says yes.' : ' You get the points when he says yes.';
    confirmSheet('I filmed it?', 'Tell Dad you\u2019ve filmed or taken photos of <b>' + esc(it.name) + '</b>?' + ptsBit + ' Add the photos next.',
      'I filmed it / took photos', 'Not yet').then(function (ok) {
        if (!ok) return;
        S.current = it;
        openCamera({ key: it.key, name: it.name });
      }).catch(oops);
  }
  function paintWaysToEarn(r) {
    var el = $('kidWays') || $('homeWays');
    if (!el) return;
    el.innerHTML = waysToEarnHtml(r || RW || {}, !!S.kid);
    paintStillToFilm();
  }
  function paintJobs(r) { paintWaysToEarn(r); }
  function runEarnJob(kind) {
    if (kind === 'photo' || kind === 'update') go(S.kid ? 'kidStuff' : 'collection');
    else if (kind === 'add') { S.add = null; go('add'); }
    else if (kind === 'found') go(S.kid ? 'kidHunt' : 'wanted');
    else if (kind === 'streak') toast(S.kid ? 'Help today with a photo, a find or a new item to keep your streak going!' : 'A bonus is added when he helps on 3 days in a row.', 'good');
    else go(S.kid ? 'kidRewards' : 'rewards');
  }
  function missionAction(b) {
    var left = Math.max(1, (b.need || 1) - (b.have || 0));
    var typ = b.rule || '';
    if (typ === 'photos') return left === 1 ? 'Add 1 more photo' : 'Add ' + left + ' more photos';
    if (typ === 'found') return left === 1 ? 'Find 1 item from Hunt' : 'Find ' + left + ' items from Hunt';
    if (typ === 'points') return left === 1 ? 'Earn 1 more point' : 'Earn ' + left + ' more points';
    if (typ === 'visits') return left === 1 ? 'Come back tomorrow' : 'Visit on ' + left + ' more days';
    if (typ === 'items') return left === 1 ? 'Add 1 new item' : 'Add ' + left + ' new items';
    if (typ === 'cats') return left === 1 ? 'Add an item in 1 more category' : 'Add items in ' + left + ' more categories';
    if (typ === 'jokes') return left === 1 ? 'Tap the joke 1 more time' : 'Tap the joke ' + left + ' more times';
    if (typ === 'swipes') return 'Swipe or tap the worth card';
    if (typ === 'reads') return 'Open a note or the letter from Dad';
    if (typ === 'searches') return 'Search for something on the home screen';
    if (typ === 'scans') return 'Scan a box';
    return b.desc || 'Have a go at this badge';
  }
  function nearestMissions(B, n) {
    n = n || 4;
    var open = (B || []).filter(function (b) { return !b.got && b.rule && b.rule !== 'starter' && b.rule !== 'manual'; });
    open.sort(function (a, b) {
      var pa = a.need ? a.have / a.need : 0, pb = b.need ? b.have / b.need : 0;
      if (pb !== pa) return pb - pa;
      var ra = a.need - a.have, rb = b.need - b.have;
      if (ra !== rb) return ra - rb;
      var ta = BADGE_TIER_ORDER.indexOf(a.tier), tb = BADGE_TIER_ORDER.indexOf(b.tier);
      if (ta !== tb) return ta - tb;
      return 0;
    });
    return open.slice(0, n);
  }
  function missionCardHtml(B) {
    var rows = nearestMissions(B, 4);
    if (!rows.length) {
      return '<div class="missionCard"><h2>My missions</h2><p class="missionSub">You\u2019ve smashed every quest for now \u2014 check your badge wall!</p>' +
        '<button type="button" class="missionRow tier-gold" data-act="go" data-to="kidBadges"><span class="mIc">\uD83C\uDFC6</span><span class="mTxt"><b>See my badges</b><small>All current missions complete</small></span></button></div>';
    }
    var h = '<div class="missionCard"><h2>My missions</h2><p class="missionSub">Your next badge quests \u2014 tap one to get started</p>';
    rows.forEach(function (b) {
      var pct = b.need ? Math.round(100 * b.have / b.need) : 0;
      h += '<button type="button" class="missionRow tier-' + esc(b.tier || 'bronze') + '" data-act="mission" data-kind="' + esc(b.rule || '') + '">' +
        '<span class="mIc">' + (b.icon || '\uD83C\uDFC6') + '</span>' +
        '<span class="mTxt"><b>' + esc(b.name) + '</b><small>' + esc(missionAction(b)) + '</small>' +
        '<span class="mBar"><i style="width:' + pct + '%"></i></span></span>' +
        '<span class="mCount"><span class="tPip ' + esc(b.tier || 'bronze') + '"></span> ' + b.have + ' / ' + b.need + '</span>' +
        '</button>';
    });
    return h + '</div>';
  }
  function paintMissions(B) {
    var el = $('kidMissions'); if (!el) return;
    el.innerHTML = missionCardHtml(B || S.badges || []);
  }
  function runMission(kind) {
    if (kind === 'photos') go('kidStuff');
    else if (kind === 'found') go('kidHunt');
    else if (kind === 'points') go('kidRewards');
    else if (kind === 'items' || kind === 'cats') { S.add = null; go('add'); }
    else if (kind === 'scans') openScanner({});
    else if (kind === 'reads') showDadLetter(true);
    else if (kind === 'visits') toast('Come back tomorrow and this one will tick along!', 'good');
    else if (kind === 'jokes') {
      var j = $('kidJoke');
      if (j) { try { j.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} j.classList.add('missionPulse'); setTimeout(function () { j.classList.remove('missionPulse'); }, 1600); }
    } else if (kind === 'swipes') {
      var w = $('funWorth');
      if (w) { try { w.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} w.classList.add('missionPulse'); setTimeout(function () { w.classList.remove('missionPulse'); }, 1600); }
    } else if (kind === 'searches') {
      var s = $('kidSearch');
      if (s) { try { s.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} s.focus(); s.classList.add('missionPulse'); setTimeout(function () { s.classList.remove('missionPulse'); }, 1600); }
    } else go('kidBadges');
  }
  function checkNewBadges() {
    return Promise.all([
      loadHistory().catch(function () { return null; }),
      loadRewards().catch(function () { return null; })
    ]).then(function (res) {
      var B = computeBadges(res[0], res[1]), got = B.filter(function (b) { return b.got; }), seen = badgesSeen(), first = !seen;
      seen = seen || [];
      var fresh = got.filter(function (b) { return seen.indexOf(b.id) < 0; });
      S.badges = B;
      if (!fresh.length || S.screen.indexOf('kid') !== 0) return B;
      LS.set('kidBadgesSeen', JSON.stringify(seen.concat(fresh.map(function (b) { return b.id; }))));
      var top = fresh[fresh.length - 1];
      confetti();
      sheet(first ? '\uD83C\uDF89 You\u2019ve got badges!' : '\uD83C\uDF89 New badge!', '<div class="badgeBig">' + top.icon + '</div><p class="center"><b style="font-size:22px">' + esc(first ? got.length + ' badges already!' : top.name) + '</b><br>' + esc(first ? 'Look at all the stuff you\u2019ve collected!' : top.desc) +
        (!first && fresh.length > 1 ? '<br><small>\u2026and ' + (fresh.length - 1) + ' more!</small>' : '') + '</p>', [{ label: '\uD83C\uDFC6 See my badges', value: 'wall', cls: 'main' }, { label: 'Yay!', value: 'ok' }]).then(function (v) { if (v === 'wall') go('kidBadges'); });
      return B;
    });
  }
  function badgeTile(b) {
    return '<div class="badge tier-' + esc(b.tier || 'bronze') + (b.got ? ' got' : '') + '"><span class="bTier">' + esc(BADGE_TIER_NAME[b.tier] || b.tier) + '</span><span class="bIc">' + b.icon + '</span><b>' + esc(b.name) + '</b><small>' + esc(b.desc) + '</small>' +
      (b.got ? '<em>\u2705 Got it!</em>' : '<span class="bBar"><i style="width:' + Math.round(100 * b.have / b.need) + '%"></i></span><em>' + b.have + ' / ' + b.need + '</em>') + '</div>';
  }
  SCREENS.kidBadges = function () {
    busy('Polishing your badges\u2026');
    recordBadgeVisit();
    loadBoot().then(checkNewBadges).then(function (B) {
      done();
      var gotN = B.filter(function (b) { return b.got; }).length;
      var h = '<h1>\uD83C\uDFC6 My badges</h1><div class="card yel center badgeSum"><b style="font-size:26px">' + gotN + ' / ' + B.length + '</b> badges<br><small>' + (B.length - gotN) + ' still to get \u2014 keep collecting, snapping and hunting!</small></div>';
      BADGE_TIER_ORDER.forEach(function (tier) {
        var rows = B.filter(function (b) { return b.tier === tier; });
        if (!rows.length) return;
        var g = rows.filter(function (b) { return b.got; }).length;
        h += '<h2 class="badgeTier"><span class="tPip ' + tier + '"></span>' + esc(BADGE_TIER_NAME[tier]) + ' <span class="wantN">(' + g + '/' + rows.length + ')</span></h2>';
        h += '<div class="badgeWall">' + rows.map(badgeTile).join('') + '</div>';
      });
      setMain(h);
    }).catch(oops);
  };
  function badgeTierOptions(cur) {
    return BADGE_TIER_ORDER.map(function (t) {
      return '<option value="' + t + '"' + (t === cur ? ' selected' : '') + '>' + BADGE_TIER_NAME[t] + '</option>';
    }).join('');
  }
  function badgeEditorRow(def, earned) {
    var custom = !!def.custom;
    return '<div class="rwItem bdgRow" data-id="' + esc(def.id) + '" data-custom="' + (custom ? '1' : '0') + '">' +
      (custom ? '<p class="rwEditHead">Custom badge</p>' : '<p class="rwEditHead">' + esc(BADGE_TIER_NAME[def.tier] || def.tier) + '</p>') +
      '<label class="field">Emoji <input type="text" class="bdgEmoji" maxlength="8" value="' + esc(def.emoji || '') + '"></label>' +
      '<label class="field">Name <input type="text" class="bdgName" maxlength="40" value="' + esc(def.name || '') + '"></label>' +
      '<label class="field">Tier <select class="bdgTier">' + badgeTierOptions(def.tier || 'bronze') + '</select></label>' +
      '<label class="field">Goal <input type="text" class="bdgGoal" maxlength="120" value="' + esc(def.goal || '') + '"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="bdgOn"' + (earned ? ' checked' : '') + '> Earned</label>' +
      (custom ? '<p><button type="button" class="btn small" data-act="bdgRemove" data-id="' + esc(def.id) + '">Remove</button></p>' : '') +
      '</div>';
  }
  SCREENS.badgeEdit = function () {
    if (!isPriv()) { go('home', {}, true); return; }
    busy('Loading badges\u2026');
    Promise.all([loadBoot().catch(function () { return null; }), loadRewards().catch(function () { return null; })]).then(function (res) {
      done();
      var B = computeBadges(res[0], res[1]);
      var got = {};
      B.forEach(function (b) { got[b.id] = b.got; });
      var rows = allBadgeDefs().map(function (d) { return badgeEditorRow(d, !!got[d.id]); }).join('');
      setMain(backBtn() + '<h1>\uD83C\uDFC6 ' + esc(KID_ROLE) + '\u2019s badges</h1>' +
        '<p class="hint">There are 50 ready-made badges, with two easy Bronze ones already earned. Add more any time. Changes save on this phone.</p>' +
        '<div class="rwList bdgEdit" id="bdgEdit">' + rows + '</div>' +
        '<p><button type="button" class="rwAdd" data-act="bdgAdd">+ Add badge</button></p>' +
        '<p class="center"><button class="btn main" data-act="bdgSave" id="bdgSaveBtn">Save</button></p>');
    }).catch(oops);
  };
  function addBadgeRow() {
    var box = $('bdgEdit'); if (!box) return;
    var id = 'custom-' + Date.now();
    var el = document.createElement('div');
    el.innerHTML = badgeEditorRow({ id: id, custom: true, emoji: '\uD83C\uDFC6', name: '', tier: 'bronze', goal: '', rule: { type: 'manual' } }, false);
    box.appendChild(el.firstChild);
    var btn = $('bdgSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }
  function saveBadgesUI() {
    var book = badgeBook();
    if (!book.baseline) book = ensureBadgeBaseline(currentBadgeStats(null));
    book.override = book.override || {};
    book.earned = book.earned || {};
    var custom = [], bad = '';
    document.querySelectorAll('#bdgEdit .bdgRow').forEach(function (el) {
      var id = el.getAttribute('data-id') || '';
      var name = ((el.querySelector('.bdgName') || {}).value || '').replace(/\s+/g, ' ').trim();
      var emoji = ((el.querySelector('.bdgEmoji') || {}).value || '').trim() || '\uD83C\uDFC6';
      var tier = ((el.querySelector('.bdgTier') || {}).value || 'bronze');
      if (BADGE_TIER_ORDER.indexOf(tier) < 0) tier = 'bronze';
      var goal = ((el.querySelector('.bdgGoal') || {}).value || '').replace(/\s+/g, ' ').trim();
      var on = !!(el.querySelector('.bdgOn') && el.querySelector('.bdgOn').checked);
      var isCustom = el.getAttribute('data-custom') === '1';
      if (isCustom && !name) { bad = 'Give each new badge a name.'; return; }
      if (isCustom) custom.push({ id: id, custom: true, emoji: emoji, name: name, tier: tier, goal: goal || 'Dad added this one.', rule: { type: 'manual' } });
      else {
        var def = null;
        BADGE_CATALOG.forEach(function (d) { if (d.id === id) def = d; });
        if (def) { def._tmp = 1; }
        book.override[id] = on ? 1 : 0;
        if (on) book.earned[id] = 1; else delete book.earned[id];
      }
      if (isCustom) {
        book.override[id] = on ? 1 : 0;
        if (on) book.earned[id] = 1; else delete book.earned[id];
      }
    });
    if (bad) { toast(bad, 'oops'); return; }
    book.custom = custom;
    saveBadgeBook(book);
    var seen = badgesSeen() || [];
    Object.keys(book.earned).forEach(function (id) { if (book.earned[id] && seen.indexOf(id) < 0) seen.push(id); });
    LS.set('kidBadgesSeen', JSON.stringify(seen));
    var btn = $('bdgSaveBtn');
    if (btn) { btn.textContent = 'Saved \u2713'; btn.classList.add('saved'); }
    toast('Saved \u2713', 'good');
  }

  function confetti() {
    try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (e) { /* ignore */ }
    var c = document.createElement('canvas'), dpr = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
    c.className = 'confetti'; c.width = W * dpr; c.height = H * dpr; document.body.appendChild(c);
    var g = c.getContext('2d'); g.scale(dpr, dpr);
    var cols = ['#FFD90F', '#F4A0B5', '#7BD389', '#70C8EA', '#FFB347', '#E4572E', '#ffffff'], P = [];
    for (var i = 0; i < 170; i++) P.push({ x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 4, r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length] });
    var t0 = performance.now();
    (function frame(t) {
      var el = t - t0; g.clearRect(0, 0, W, H);
      P.forEach(function (p) { p.vy += 0.45; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va; g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.globalAlpha = Math.max(0, 1 - el / 3200); g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore(); });
      if (el < 3200) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

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
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest('#jobEdit') && el.classList && (el.classList.contains('jobCost') || el.classList.contains('jobTitle') || el.classList.contains('jobIcon'))) sortJobEditor();
    if (el.closest('#ptsEdit') && el.classList && (el.classList.contains('ptsCost') || el.classList.contains('ptsTitle') || el.classList.contains('ptsEmoji'))) sortPointRulesEditor();
  });
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (tab) { if (tab.getAttribute('data-tab') === 'scan') { openScanner({}); return; } S.history = []; var to = tab.getAttribute('data-tab'); if (to === 'add') layerPush(); go(to, {}, true); return; }
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.getAttribute('data-act'), key = el.getAttribute('data-key');
    switch (a) {
      case 'back': layerBack(); break;
      case 'go': if (el.getAttribute('data-to') === 'guide') { go('guide', { i: 0 }); break; } go(el.getAttribute('data-to'), { tab: el.getAttribute('data-tab') }); break;
      case 'wheelSpin': spinTheWheel(); break;
      case 'refresh': S.boot = null; thumbsRefresh(); go(S.screen, S.params, true); break;
      case 'thumbRetry': retryThumb(el.getAttribute('data-fid2')); break;
      case 'shareFind': shareFind(); break;
      case 'priceCheck': if ($('priceSlot') && S.current) $('priceSlot').innerHTML = $('priceSlot').innerHTML ? '' : priceBoxHtml(S.current); break;
      case 'histFilter': S.histFilter = el.getAttribute('data-v'); S.histShown = 150; go('history', {}, true); break;
      case 'histMore': S.histShown = (S.histShown || 150) + 150; go('history', {}, true); break;
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
      case 'pinCancel': var pinWhy = S.pinWhy, pinRet = S.pinReturn; S.pendingRole = ''; S.pinDigits = ''; S.pinError = ''; S.pinWhy = ''; S.pinAfter = null; S.pinReturn = null; if (pinWhy) { go((pinRet && pinRet.screen) || (S.kid ? 'kid' : 'home'), (pinRet && pinRet.params) || {}, true); break; } if (S.kidExit) { S.kidExit = false; go('kid', {}, true); break; } go('who', {}, true); break;
      case 'lockPriv': lockDadView(); break;
      case 'item': $('sheet').hidden = true; if (key && key.indexOf('pending:') === 0) { toast('That one is waiting to sync - it\u2019ll open once you\u2019re back online.'); break; } go('item', { key: key }); break;
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
          return call('markGotIt', 'item', S.current.key, S.current.name, S.role).then(function (r) { done(); S.boot = null; pointsNote(r, '\u2705 It\u2019s officially ours!'); go('item', S.params, true); });
        }).catch(oops); break;
      case 'addSnap': openCamera({ mode: 'add' }); break;
      case 'addPick': openCamera({ mode: 'add' }, true); break;
      case 'addClearShots': addState().shots = []; go('add', {}, true); break;
      case 'addNext': addNext(); break;
      case 'addBack': layerBack(); break;
      case 'addRange': addState().range = el.getAttribute('data-v'); addState().step = 4; layerPush(); go('add', {}, true); break;
      case 'addCond': addState().condition = el.getAttribute('data-v'); document.querySelectorAll('[data-act=addCond]').forEach(function (b) { b.classList.toggle('sel', b === el); });
        var sv = document.querySelector('[data-act=addSave]'); if (sv) sv.disabled = false;
        var chk = document.querySelector('.warn i'); if (chk) chk.outerHTML = esc(addState().condition); break;
      case 'addSave': addSave(); break;
      case 'gotWanted': gotWanted(+el.getAttribute('data-i')); break;
      case 'gotCl': gotCl(+el.getAttribute('data-row')); break;
      case 'clMode': go('checklist', { tab: S.params.tab, all: el.getAttribute('data-all') }, true); break;
      case 'toggleFilters': S.filtersOpen = !($('filterBox') && !$('filterBox').hidden); go('collection', {}, true); break;
      case 'openPhoto': openPhoto(+el.getAttribute('data-i')); break;
      case 'closePhoto': layerBack(); break;
      case 'heroOpen': if (S.gallery && S.gallery.length) openPhoto(0); break;
      case 'makeMain':
        var ph = S.gallery[+el.getAttribute('data-i')]; busy('Making it the main photo\u2026');
        call('setMainPhoto', S.current.key, S.current.name, ph.id).then(function () { done(); $('lightbox').hidden = true; layerDrop(); if (S.current.folderId) forgetThumb(S.current.folderId); toast('\u2B50 That\u2019s the main photo now', 'good'); go('item', S.params, true); }).catch(oops); break;
      case 'replaceMain': openCamera({ key: S.current.key, name: S.current.name, makeMain: true }); break;
      case 'togglePosted': togglePosted(el.getAttribute('data-p')); break;
      case 'postedMode': S.postedMode = el.getAttribute('data-v'); S.shownPosted = 60; go('posted', {}, true); break;
      case 'morePosted': S.shownPosted = (S.shownPosted || 60) + 60; go('posted', {}, true); break;
      case 'markSale': markSale(key, el.getAttribute('data-name')); break;
      case 'gotMissing': gotMissing(+el.getAttribute('data-i')); break;
      case 'doExport': doExport(el.getAttribute('data-k')); break;
      case 'startTour': LS.set('tourPending', '1'); go('home', {}, true); break;
      case 'tourNext': startTour(+el.getAttribute('data-i')); break;
      case 'tourSkip': if (NAV.pushed > 0) layerBack(); else closeTour(); toast('No problem - the tour is under More \u2192 Help.'); break;
      case 'scan': bumpKid('kidScans'); openScanner({}); break;
      case 'scanAssign': openScanner({ assign: { key: S.current.key, name: S.current.name } }); break;
      case 'scanClose': if (NAV.pushed > 0) layerBack(); else stopScanner(); break;
      case 'scanType': typeCode(); break;
      case 'scanPhoto': $('scanInput').value = ''; $('scanInput').click(); break;
      case 'bcAssign':
        var bi = itemByKey(key); if (!bi) break; $('sheet').hidden = true;
        saveBarcodeTo(bi.key, bi.name, S.lastCode); break;
      case 'bcAddNew':
        $('sheet').hidden = true;
        S.add = { step: 1, shots: [], name: (S.lastLook && S.lastLook.name) || '', range: (S.lastLook && S.lastLook.range) || '', condition: '', more: { maker: (S.lastLook && S.lastLook.brand) || '' }, barcode: S.lastCode, bcLook: S.lastLook || null, bcRef: (S.lastLook && S.lastLook.image) || '' };
        go('add'); break;
      case 'scanQAdd': scanQAdd(el.getAttribute('data-id')); break;
      case 'scanQDismiss': scanQDismiss(el.getAttribute('data-id')); break;
      case 'syncNow': syncQueue(); break;
      case 'letterOpen': showDadLetter(true); break;
      case 'letterGo': if (NAV.pushed > 0) layerBack(); else hideDadLetter(); break;
      case 'notesOpen': go('kidNotes'); break;
      case 'wantToggle': wantToggle(el.getAttribute('data-gid')); break;
      case 'wantCollapseAll': wantCollapseAll(true); break;
      case 'wantExpandAll': wantCollapseAll(false); break;
      case 'wantInfo': wantedInfoSheet(+el.getAttribute('data-i'), el.getAttribute('data-src') === 'kid' ? S.kidWanted : S.wantedList); break;
      case 'funPrev': cycleFunWorth(-1); break;
      case 'funNext': cycleFunWorth(1); break;
      case 'jokeNext': showNextJoke(); break;
      case 'noteOpen': showDadNote(el.getAttribute('data-i')); break;
      case 'noteGo': if (NOTE_UI.fromPointer && Date.now() - NOTE_UI.fromPointer < 500) break; onNoteGo(); break;
      case 'noteSkip': thanksDadNote(); break;
      case 'rwSeeAll':
        (function () {
          var card = el.closest && el.closest('.rwHomeCard');
          if (!card) return;
          var on = card.classList.toggle('rwShowAll');
          el.textContent = on ? 'Show less' : 'See all';
          el.setAttribute('aria-expanded', on ? 'true' : 'false');
        })();
        break;
      case 'rwAsk': askReward(el.getAttribute('data-id')); break;
      case 'rwYes': decideRewardUI(el.getAttribute('data-id'), true); break;
      case 'rwNo': decideRewardUI(el.getAttribute('data-id'), false); break;
      case 'rwPhotoYes': decidePhotoUI(el.getAttribute('data-id'), true, !!(el.closest('.rwItem') && el.closest('.rwItem').querySelector('.qMain') && el.closest('.rwItem').querySelector('.qMain').checked)); break;
      case 'rwPhotoNo': decidePhotoUI(el.getAttribute('data-id'), false, false); break;
      case 'rwSave': saveRewardsUI(); break;
      case 'rwAdd': addRewardRow(); break;
      case 'jobAdd': addJobRow(); break;
      case 'ptsAdd': addPointRuleRow(); break;
      case 'jobAsk': requestJobUI(el.getAttribute('data-id')); break;
      case 'jobYes': decideJobUI(el.getAttribute('data-id'), true); break;
      case 'jobNo': decideJobUI(el.getAttribute('data-id'), false); break;
      case 'jobDone': requestJobUI(el.getAttribute('data-id')); break;
      case 'bdgAdd': addBadgeRow(); break;
      case 'bdgSave': saveBadgesUI(); break;
      case 'bdgRemove': (function () { var row = el.closest && el.closest('.bdgRow'); if (row && row.parentNode) row.parentNode.removeChild(row); var btn = $('bdgSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); } })(); break;
      case 'addScan': keepAddName(); openScanner({ add: true }); break;
      case 'addTypeBc': keepAddName(); SCAN.opts = { add: true }; typeCode(); break;
      case 'addClearBc': var A0 = addState(); A0.barcode = ''; A0.bcLook = undefined; A0.bcRef = ''; go('add', {}, true); break;
      case 'kidEnter': enterKid(); break;
      case 'kidExit': exitKid(); break;
      case 'kidItem': $('sheet').hidden = true; go('kidItem', { key: key }); break;
      case 'filmAsk': filmAskUI(key); break;
      case 'filmSeeAll':
        S.filters = S.filters || {};
        S.filters.photos = 'no';
        S.filters.sort = 'newest';
        S.shown = 60;
        go('collection');
        break;
      case 'kidMore': S.kidShown = (S.kidShown || 40) + 40; if (S.redrawKid) S.redrawKid(); break;
      case 'kidSnap': if (S.current) openCamera({ key: S.current.key, name: S.current.name }); break;
      case 'kidGot': kidGot(+el.getAttribute('data-i')); break;
      case 'kidNew': S.add = null; go('add'); break;
      case 'mission': runMission(el.getAttribute('data-kind') || ''); break;
      case 'earnGo': runEarnJob(el.getAttribute('data-kind') || ''); break;
      case 'kidGotItem':
        confirmSheet('We got it? \uD83C\uDF89', 'Mark <b>' + esc(S.current.name) + '</b> as ours?', 'Yes!', 'Not yet').then(function (ok) {
          if (!ok) return; busy('Saving\u2026');
          return call('markGotIt', 'item', S.current.key, S.current.name, KID_ROLE).then(function (r) { done(); bumpKid('kidFound'); S.current.status = 'Owned'; S.boot = null; pointsNote(r, '\uD83C\uDF89 It\u2019s ours!'); go('kidItem', S.params, true); });
        }).catch(oops); break;
    }
  });
  $('stuckBtn').addEventListener('click', function () {
    if (!S.kid) return showHelp();
    sheet('How it works', '<ul><li>\uD83E\uDDF8 <b>Our stuff</b>: tap anything to see it big or add a photo. Videos play right here in the app.</li><li>\uD83C\uDFA1 <b>Spin the wheel</b>: picks something we already own to film next (it prefers things not posted yet).</li><li>\uD83D\uDD01 <b>Doubles to swap</b>: things we have more than one of, with photos and no prices.</li><li>\u2705 <b>Set progress</b> and <b>On this day</b> show on Home when there is something to see.</li><li>\u2B50 <b>Hunt</b>: things we\u2019re looking for. Found one? Tap \u201CFound it!\u201D</li><li>\uD83D\uDCF7 <b>Scan</b>: point at a box\u2019s barcode to see if we\u2019ve got it. If it is new, you\u2019ll see the name if we can find it, then Dad can add it (his PIN, we stay in your mode) or save it for later.</li><li>\u2709\uFE0F <b>Letter from Dad</b>: how it all started. It pops up every now and then, and you can open it again any time.</li><li>\uD83D\uDCDD <b>Notes from Dad</b>: a little note every few visits, and all of them under Notes from Dad.</li><li>\uD83D\uDE04 <b>A daft joke</b>: a new one when you open this mode. Tap it for another.</li><li>\uD83C\uDF66 <b>What\u2019s our collection worth?</b>: swipe or tap to try ice creams, Dons tickets, tractors and lots more.</li><li>\u2B50 <b>My points</b>: earn points and ask Dad for rewards.</li><li>\uD83E\uDDF9 <b>Jobs</b>: tap a job (like clean your room) when it\u2019s done. Dad takes a look, and you get the points when he says yes.</li><li>No faces in photos - hands are fine.</li></ul>',
      [{ label: '\u21BB Refresh', value: 'refresh' }, { label: 'Got it!', value: 'ok', cls: 'main' }]).then(function (v) { if (v === 'refresh') { S.boot = null; thumbsRefresh(); go(S.screen || 'kid', S.params, true); } });
  });
  $('homeBtn').addEventListener('click', function () { if (S.kid) { S.history = []; go('kid', {}, true); return; } if (S.role) { S.history = []; go(S.screen === 'home' ? 'settings' : 'home', {}, true); } });
  $('camInput').addEventListener('change', onFiles);
  $('pickInput').addEventListener('change', onFiles);
  if ($('vidInput')) $('vidInput').addEventListener('change', onFiles);
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) { /* tap outside: ignore so nothing is chosen by accident */ } });

  /* ---------------- start ---------------- */
  loadSavedThumbs();
  IDB.qAll().then(function (q) { NET.queueLen = q.length; renderNetBar(); if (q.length && navigator.onLine !== false) syncQueue(); }, noop);
  if (S.kid) { S.role = KID_ROLE; S.kidGreeting = true; pickFunUnitRandom(); pickJokeOnOpen(); go('kid', {}, true); }
  else if (!LS.get('seenGuide')) go('guide', { i: 0 }, true);
  else if (!S.role) go('who', {}, true);
  else if (S.role === PRIV && THEME.needsPin && !dadUnlocked()) askDadPin(S.role);
  else go('home', {}, true);
})();
