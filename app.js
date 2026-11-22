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
      qDel: function (id) { return tx('queue', 'readwrite', function (s) { return s.delete(id); }); }
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
  var READ_FNS = { getBootstrap: 1, getWanted: 1, getChecklists: 1, getChecklist: 1, getItem: 1, getStats: 1, getAllMissing: 1, getPostedBoard: 1, getDuplicates: 1, getPhotoTodo: 1, getNoValue: 1, getValueSummary: 1, getItemPhotos: 1, getHistory: 1, getRewards: 1, getQueuePhoto: 1 };
  var WRITE_FNS = { saveItem: 1, addItem: 1, markGotIt: 1, setPosted: 1, uploadMedia: 1, saveBarcode: 1, setMainPhoto: 1, requestReward: 1, decideReward: 1, saveRewards: 1, savePointRules: 1, decidePhoto: 1 };
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
  /* Son's mode also leaves out anything Christmassy or gift-related, to be safe */
  function kidSafe(it) {
    if (!it || neverShow(it.name) || sonHidden(it.name)) return false;
    var t = [it.name, it.range, it.series].join(' ');
    return !/christmas|xmas|x-mas|secret|gift|present|santa/i.test(t);
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
    var items = (S.items || []).filter(function (it) { return !neverShow(it.name) && (!S.kid || kidSafe(it)); });
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
    inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(run, 120); });
    if (inp.value) run();
  }

  /* ================= v4: barcodes ================= */
  function bcDigits(c) { return String(c == null ? '' : c).replace(/[^0-9]/g, ''); }
  function bcKey(c) { return bcDigits(c).replace(/^0+/, ''); }   // UPC-A and EAN-13 with a leading 0 are the same code
  function localBarcodes() { try { return JSON.parse(LS.get('barcodes') || '{}') || {}; } catch (e) { return {}; } }
  function itemBarcode(it) { return (it && (it.bc || localBarcodes()[it.key])) || ''; }
  function itemsByBarcode(code) {
    var k = bcKey(code); if (!k) return [];
    return (S.items || []).filter(function (it) { var b = itemBarcode(it); return b && bcKey(b) === k && !neverShow(it.name) && (!S.kid || kidSafe(it)); });
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
    if (opts.assign) {
      var a = opts.assign;
      return confirmSheet('Save this barcode?', 'Save <b>' + esc(digits) + '</b> onto <b>' + esc(a.name) + '</b>? Next time you scan this box it\u2019ll match straight away.', 'Yes, save it', 'Cancel').then(function (ok) {
        if (ok) saveBarcodeTo(a.key, a.name, digits).then(function () { if (S.screen === 'item') go('item', S.params, true); });
      });
    }
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
    if (S.kid) {
      sheet('\uD83E\uDD37 Not in our collection yet', '<p>Barcode <b>' + esc(digits) + '</b> isn\u2019t saved on anything we\u2019ve got. If you think we have it, show ' + esc(PRIV) + '!</p>', [{ label: '\uD83D\uDCF7 Scan another', value: 'again', cls: 'main' }, { label: 'OK', value: false }]).then(function (v) { if (v === 'again') openScanner({}); });
      return;
    }
    sheet('\uD83E\uDD37 No match for that barcode yet', '<p>Barcode <b>' + esc(digits) + '</b> isn\u2019t saved on any item yet. Most of the collection doesn\u2019t have barcodes saved, so <b>search by name</b> - if you\u2019ve got it, tap it to save the barcode and next time it\u2019ll match straight away.</p>' +
      '<div class="search"><input id="bcName" type="search" placeholder="\uD83D\uDD0D What is it? e.g. Bartman 503" autocomplete="off" style="font-size:20px"></div><div id="bcNameOut"></div>' +
      '<div class="stack" style="margin-top:10px"><a class="btn full" href="https://www.google.co.uk/search?q=' + encodeURIComponent(digits) + '" target="_blank" rel="noopener">\uD83D\uDD0E Look the barcode up on Google \u2197</a>' +
      '<button class="btn yel full" data-act="bcAddNew">\u2795 It\u2019s new - add it with this barcode</button></div>',
      [{ label: '\uD83D\uDCF7 Scan another', value: 'again' }, { label: 'Close', value: false, cls: 'main' }]).then(function (v) { if (v === 'again') openScanner({}); });
    var inp = $('bcName'), t = null;
    inp.addEventListener('input', function () {
      clearTimeout(t); t = setTimeout(function () {
        var res = fuzzyFind(inp.value, (S.items || []).filter(function (it) { return !neverShow(it.name); }), 6);
        $('bcNameOut').innerHTML = !inp.value.trim() ? '' : (res.length ? '<p class="hint">Tap the one it is to save the barcode on it:</p><div class="list">' + res.map(function (x) {
          return '<button class="li ownLi" data-act="bcAssign" data-key="' + esc(x.it.key) + '">' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) + '<small>' + esc([x.it.range, x.it.status].filter(Boolean).join(' \u00B7 ')) + '</small></div><span class="pill green">This one</span></button>';
        }).join('') + '</div>' : '<div class="nudge">\u274C Nothing in the collection matches that name.</div>');
        watchThumbs();
      }, 150);
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
      if (k) seen[k] = 1;
    });
    missingToWanted(missing).forEach(function (w) {
      var k = norm(w.name);
      if (k && seen[k]) return;
      if (k) seen[k] = 1;
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
  var MORE_SCREENS = ['more', 'stats', 'posted', 'spares', 'history', 'export', 'help', 'settings', 'value', 'photos', 'novalue'];
  function go(screen, params, noHistory) {
    closeTour(); if ($('lightbox')) $('lightbox').hidden = true;
    if (S.kid) { if (screen === 'item') screen = 'kidItem'; else if (KID_SCREENS.indexOf(screen) < 0) { screen = 'kid'; params = {}; } }
    if (!noHistory && S.screen && S.screen !== screen) { S.history.push([S.screen, S.params]); layerPush(); }
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
      S.boot = b; S.items = b.items;
      prefetchThumbs(S.kid ? b.items.filter(function (it) { return isOwned(it) && kidSafe(it); }) : b.items);
      return IDB.qAll().then(function (q) { NET.queueLen = q.length; q.forEach(applyQueued); }, noop).then(function () { done(); renderNetBar(); return b; });
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
  function thumbHtml(it) {
    if (!it.folderId) return '<div class="thumb" data-nothumb>' + noPhotoHtml(false) + '</div>';
    return '<div class="thumb" data-fid="' + esc(it.folderId) + '">' + thumbInner(it.folderId) + '</div>';
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
    item: ['This is one item.', 'Tap \u201CAdd photo / video\u201D to use the camera - it saves straight into the item\u2019s own Drive folder.', 'Tap a photo to see it big, or make it the main photo.', 'Tap \u201CEdit details\u201D to fix the name, category, condition and so on.', 'Tap a platform under \u201CPosted on\u201D once it\u2019s been posted.'],
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
      if (v === 'refresh') { S.boot = null; thumbsRefresh(); go(S.screen || 'home', S.params, true); }
      if (v === 'guide') go('guide', { i: 0 });
      if (v === 'tour') { LS.set('tourPending', '1'); go('home', {}, true); }
      if (v === 'help') go('help');
      if (v === 'who') go('who');
    });
  }

  /* ---------------- screens ---------------- */
  var SCREENS = {};

  /* ================= v4: Son's mode (big tiles, photos, no money, nothing Christmassy) ================= */
  var KID_ROLE = THEME.roles.filter(function (r) { return r !== PRIV; })[0] || 'Son';
  var KID_SCREENS = ['kid', 'kidStuff', 'kidItem', 'kidHunt', 'kidBadges', 'kidRewards', 'kidNotes', 'pin', 'add'];
  function enterKid() {
    LS.set('kidPrevRole', S.role || '');
    clearDadToken();                    // money needs the PIN again after Son's mode
    S.kid = true; LS.set('kidMode', '1');
    S.role = KID_ROLE; LS.set('role', KID_ROLE);
    S.boot = null; S.items = []; S.homeWanted = null; S.history = []; S.add = null;
    S.kidGreeting = true;
    pickFunUnitRandom();
    pickJokeOnOpen();
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
    return (S.items || []).filter(function (it) { return isOwned(it) && kidSafe(it); }).sort(function (a, b) { return idn(b) - idn(a); });   // newest finds first
  }
  function kidTile(it) {
    return '<button class="ktile" data-act="kidItem" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<span class="kname">' + esc(it.name) + '</span></button>';
  }
  SCREENS.kid = function () {
    loadBoot().then(function () {
      var mine = kidItems();
      var h = '<div class="kidHead"><div class="mascot small">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteK') + '</div><h1>Hiya wee man \uD83D\uDC4B</h1></div>' +
        jokeHtml() +
        funWorthHtml() +
        '<div class="kfeatures">' +
        '<button type="button" class="kfeature pinkL" data-act="go" data-to="kidBadges"><span>\uD83C\uDFC6</span><span class="kfeatTxt"><b>My badges</b><small id="kidBadgeN">see what you\u2019ve earned</small></span></button>' +
        '<button type="button" class="kfeature yel" data-act="go" data-to="kidRewards"><span>\u2B50</span><span class="kfeatTxt"><b>My points</b><small id="kidPtsN">earn rewards!</small></span></button>' +
        '</div>' +
        '<div class="ownCard card"><label class="ownLabel" for="kidSearch">\uD83D\uDD0D Have we got it?</label><input id="kidSearch" class="ownInput" type="search" placeholder="Type a name\u2026" autocomplete="off"><div id="kidOwnOut"></div></div>' +
        '<div class="kgrid">' +
        '<button class="kbig yel" data-act="go" data-to="kidStuff"><span>\uD83E\uDDF8</span><b>Our stuff</b><small>' + mine.length + ' things</small></button>' +
        '<button class="kbig pink" data-act="go" data-to="kidHunt"><span>\u2B50</span><b>On the hunt</b><small id="kidHuntN">find these!</small></button>' +
        '<button class="kbig skyL" data-act="scan"><span>\uD83D\uDCF7</span><b>Scan a box</b><small>have we got it?</small></button>' +
        '<button class="kbig green" data-act="kidNew"><span>\u2795</span><b>New find!</b><small>snap it and save it</small></button>' +
        '<button class="kbig paper" data-act="letterOpen"><span>\u2709\uFE0F</span><b>Letter from Dad</b><small>How it all started</small></button>' +
        '<button class="kbig paper" data-act="notesOpen"><span>\uD83D\uDCDD</span><b>Notes from Dad</b><small>little messages</small></button>' +
        '</div>' +
        '<div class="center" style="margin-top:18px"><button class="btn small" data-act="kidExit">\uD83D\uDD13 Grown-ups: full app</button></div>';
      setMain(h);
      bindOwnSearch('kidSearch', 'kidOwnOut');
      checkNewBadges().then(function (B) { var n = B.filter(function (b) { return b.got; }).length; if ($('kidBadgeN')) $('kidBadgeN').textContent = n + ' badge' + (n === 1 ? '' : 's') + ' so far!'; }).catch(noop);
      loadHomeWanted().then(function (w) { var n = w.filter(function (x) { return kidSafe(x); }).length; if ($('kidHuntN')) $('kidHuntN').textContent = n + ' to find!'; });
      loadRewards().then(function (r) { if ($('kidPtsN') && r) $('kidPtsN').textContent = r.balance + ' points \u00B7 ' + r.level.name; }).catch(noop);
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
        var list = q ? fuzzyFind(q, all, 60).map(function (x) { return x.it; }) : all.filter(function (it) { return it.folderId; }).concat(all.filter(function (it) { return !it.folderId; }));
        var shown = list.slice(0, S.kidShown || 40);
        $('kidGrid').innerHTML = '<p class="hint">' + list.length + ' thing' + (list.length === 1 ? '' : 's') + (q ? ' found' : ' - tap one to see it or add a photo') + '</p><div class="kstuff">' + shown.map(kidTile).join('') + '</div>' +
          (list.length > shown.length ? '<p class="center"><button class="btn" data-act="kidMore">Show more</button></p>' : '');
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
      if (!it || !kidSafe(it)) { go('kidStuff', {}, true); return; }
      S.current = it;
      var t = it.folderId ? S.thumbs[it.folderId] : null;
      var hero = t ? '<img alt="" src="' + t + '">' : (it.folderId ? thumbInner(it.folderId) : noPhotoHtml(false));
      var h = backBtn() + '<div class="card center kidItem"><div class="khero" id="kHero"' + (it.folderId ? ' data-fid="' + esc(it.folderId) + '"' : '') + '>' + hero + '</div>' +
        '<h1>' + esc(it.name) + '</h1><div class="chips" style="justify-content:center">' + [it.range, it.character, it.year].filter(function (x) { return x && !/^unknown$/i.test(x); }).map(function (x) { return '<span class="chip on">' + esc(x) + '</span>'; }).join('') + '</div>' +
        '<div class="stack" style="margin-top:14px"><button class="btn main full kbtn" data-act="kidSnap">\uD83D\uDCF7 Add a photo</button>' +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full kbtn" data-act="kidGotItem">\uD83C\uDF89 We got it!</button>' : '<div class="pill green" style="font-size:18px;padding:6px 14px">\u2705 We\u2019ve got this!</div>') +
        '</div></div>';
      setMain(h);
      if (it.folderId) { watchThumbs(); if (!t) call('getItemPhotos', it.folderId).then(function (ph) { var f = (ph || []).filter(function (x) { return x.thumb; })[0]; if (f && $('kHero') && typeof S.thumbs[it.folderId] !== 'string') { shrinkThumb(f.thumb).then(function (s) { if (s && $('kHero')) { S.thumbs[it.folderId] = s; paintThumb(it.folderId); } }); } }).catch(noop); }
    }).catch(oops);
  };
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
    var el = $('kidJoke'); if (!el) return;
    var j = JOKES[i];
    var q = el.querySelector('.jokeQ'), a = el.querySelector('.jokeA');
    if (q) q.textContent = j.q;
    if (a) a.textContent = j.a;
  }

  var FUN_UNITS = [
    { id: "donkey", emoji: "🫏", art: "a", one: "donkey", many: "donkeys", gbp: 350 },
    { id: "dog", emoji: "🐶", art: "a", one: "dog", many: "dogs", gbp: 225 },
    { id: "icecream", emoji: "🍦", art: "an", one: "ice cream", many: "ice creams", gbp: 2.5 },
    { id: "cow", emoji: "🐄", art: "a", one: "Highland cow", many: "Highland cows", gbp: 1000 },
    { id: "cards", emoji: "⚽", art: "a", one: "Match Attax-style pack", many: "Match Attax-style packs", gbp: 1.5 },
    { id: "tractor", emoji: "🚜", art: "a", one: "Massey Ferguson tractor", many: "Massey Ferguson tractors", gbp: 20000 },
    { id: "dons_ticket", emoji: "🎫", art: "an", one: "Aberdeen FC match ticket", many: "Aberdeen FC match tickets", gbp: 32 },
    { id: "dons_home_top", emoji: "👕", art: "an", one: "Aberdeen FC home top", many: "Aberdeen FC home tops", gbp: 65 },
    { id: "dons_scarf", emoji: "🧣", art: "a", one: "Dons scarf", many: "Dons scarves", gbp: 20 },
    { id: "pittodrie_pie", emoji: "🥧", art: "a", one: "Pittodrie pie", many: "Pittodrie pies", gbp: 3.5 },
    { id: "dons_season", emoji: "🎟️", art: "a", one: "Dons season ticket", many: "Dons season tickets", gbp: 380 },
    { id: "match_attax_tin", emoji: "🗃️", art: "a", one: "Match Attax tin", many: "Match Attax tins", gbp: 10 },
    { id: "football", emoji: "⚽", art: "a", one: "football", many: "footballs", gbp: 15 },
    { id: "ronaldo_shirt", emoji: "👕", art: "a", one: "Ronaldo-style shirt", many: "Ronaldo-style shirts", gbp: 80 },
    { id: "messi_shirt", emoji: "👕", art: "a", one: "Messi-style shirt", many: "Messi-style shirts", gbp: 80 },
    { id: "haaland_shirt", emoji: "👕", art: "a", one: "Haaland-style shirt", many: "Haaland-style shirts", gbp: 80 },
    { id: "football_boots", emoji: "👟", art: "a", one: "pair of football boots", many: "pairs of football boots", gbp: 55 },
    { id: "gk_gloves", emoji: "🧤", art: "a", one: "pair of goalkeeper gloves", many: "pairs of goalkeeper gloves", gbp: 22 },
    { id: "prem_ticket", emoji: "🎟️", art: "a", one: "Premier League ticket", many: "Premier League tickets", gbp: 55 },
    { id: "sticker_pack", emoji: "📦", art: "a", one: "football sticker pack", many: "football sticker packs", gbp: 1.2 },
    { id: "mf_toy", emoji: "🚜", art: "a", one: "Massey Ferguson toy tractor", many: "Massey Ferguson toy tractors", gbp: 28 },
    { id: "pedal_tractor", emoji: "🚜", art: "a", one: "pedal tractor", many: "pedal tractors", gbp: 130 },
    { id: "farm_set", emoji: "🌾", art: "a", one: "farm playset", many: "farm playsets", gbp: 40 },
    { id: "matchbox", emoji: "🚗", art: "a", one: "boxed Matchbox car", many: "boxed Matchbox cars", gbp: 3 },
    { id: "hotwheels", emoji: "🏎️", art: "a", one: "boxed Hot Wheels car", many: "boxed Hot Wheels cars", gbp: 3 },
    { id: "hw_track", emoji: "🏁", art: "a", one: "Hot Wheels track set", many: "Hot Wheels track sets", gbp: 25 },
    { id: "rc_car", emoji: "🚙", art: "a", one: "remote-control car", many: "remote-control cars", gbp: 30 },
    { id: "lego_small", emoji: "🧱", art: "a", one: "small Lego set", many: "small Lego sets", gbp: 12 },
    { id: "lego_mid", emoji: "🧱", art: "a", one: "mid-size Lego set", many: "mid-size Lego sets", gbp: 35 },
    { id: "lego_big", emoji: "🧱", art: "a", one: "big Lego set", many: "big Lego sets", gbp: 90 },
    { id: "lego_simpsons", emoji: "🧱", art: "a", one: "Lego Simpsons set", many: "Lego Simpsons sets", gbp: 160 },
    { id: "krusty_burger", emoji: "🍔", art: "a", one: "Krusty Burger", many: "Krusty Burgers", gbp: 6 },
    { id: "squishee", emoji: "🥤", art: "a", one: "Squishee", many: "Squishees", gbp: 3.5 },
    { id: "pink_donut", emoji: "🍩", art: "a", one: "pink donut", many: "pink donuts", gbp: 1.5 },
    { id: "buzz_cola", emoji: "🥤", art: "a", one: "Buzz Cola", many: "Buzz Colas", gbp: 1.2 },
    { id: "lard_lad", emoji: "🍩", art: "a", one: "giant Lard Lad donut", many: "giant Lard Lad donuts", gbp: 15 },
    { id: "simpsons_monopoly", emoji: "🎲", art: "a", one: "Simpsons Monopoly", many: "Simpsons Monopoly games", gbp: 25 },
    { id: "bart_board", emoji: "🛹", art: "a", one: "Bart-style skateboard", many: "Bart-style skateboards", gbp: 28 },
    { id: "krusty_doll", emoji: "🤡", art: "a", one: "Krusty doll", many: "Krusty dolls", gbp: 15 },
    { id: "irnbru", emoji: "🧡", art: "an", one: "Irn-Bru can", many: "Irn-Bru cans", gbp: 1.2 },
    { id: "irnbru_6", emoji: "🧃", art: "an", one: "Irn-Bru 6-pack", many: "Irn-Bru 6-packs", gbp: 5 },
    { id: "tablet", emoji: "🍬", art: "a", one: "bag of tablet", many: "bags of tablet", gbp: 3.5 },
    { id: "teacake", emoji: "🧁", art: "a", one: "Tunnock's teacake", many: "Tunnock's teacakes", gbp: 0.7 },
    { id: "teacake_box", emoji: "🧁", art: "a", one: "box of Tunnock's teacakes", many: "boxes of Tunnock's teacakes", gbp: 3.5 },
    { id: "haggis", emoji: "🥘", art: "a", one: "haggis supper", many: "haggis suppers", gbp: 6 },
    { id: "bagpipes", emoji: "🎶", art: "a", one: "set of bagpipes", many: "sets of bagpipes", gbp: 500 },
    { id: "highland_pony", emoji: "🐴", art: "a", one: "Highland pony", many: "Highland ponies", gbp: 1500 },
    { id: "shortbread", emoji: "🍪", art: "a", one: "shortbread tin", many: "shortbread tins", gbp: 6 },
    { id: "caramel_wafer", emoji: "🍫", art: "a", one: "Tunnock's caramel wafer", many: "Tunnock's caramel wafers", gbp: 0.55 },
    { id: "scotch_pie", emoji: "🥧", art: "a", one: "Scotch pie", many: "Scotch pies", gbp: 2 },
    { id: "mars_fried", emoji: "🍫", art: "a", one: "deep-fried Mars bar", many: "deep-fried Mars bars", gbp: 3.5 },
    { id: "nessie", emoji: "🦕", art: "a", one: "Nessie soft toy", many: "Nessie soft toys", gbp: 12 },
    { id: "rowie", emoji: "🥐", art: "an", one: "Aberdeen rowie", many: "Aberdeen rowies", gbp: 0.8 },
    { id: "castle_ticket", emoji: "🏰", art: "an", one: "Edinburgh Castle ticket", many: "Edinburgh Castle tickets", gbp: 22 },
    { id: "kilt_hire", emoji: "🧶", art: "a", one: "hired kilt", many: "hired kilts", gbp: 45 },
    { id: "puppy", emoji: "🐶", art: "a", one: "puppy", many: "puppies", gbp: 400 },
    { id: "kitten", emoji: "🐱", art: "a", one: "kitten", many: "kittens", gbp: 150 },
    { id: "labrador", emoji: "🦮", art: "a", one: "golden Labrador", many: "golden Labradors", gbp: 900 },
    { id: "goldfish", emoji: "🐠", art: "a", one: "goldfish", many: "goldfish", gbp: 3 },
    { id: "hamster", emoji: "🐹", art: "a", one: "hamster", many: "hamsters", gbp: 20 },
    { id: "rabbit", emoji: "🐰", art: "a", one: "rabbit", many: "rabbits", gbp: 40 },
    { id: "budgie", emoji: "🦜", art: "a", one: "budgie", many: "budgies", gbp: 30 },
    { id: "pizza", emoji: "🍕", art: "a", one: "pizza", many: "pizzas", gbp: 12 },
    { id: "cinema", emoji: "🎬", art: "a", one: "cinema trip", many: "cinema trips", gbp: 12 },
    { id: "choc_bar", emoji: "🍫", art: "a", one: "chocolate bar", many: "chocolate bars", gbp: 1.2 },
    { id: "crisps", emoji: "🥨", art: "a", one: "packet of crisps", many: "packets of crisps", gbp: 1 },
    { id: "sundae", emoji: "🍨", art: "an", one: "ice cream sundae", many: "ice cream sundaes", gbp: 5 },
    { id: "milkshake", emoji: "🥛", art: "a", one: "milkshake", many: "milkshakes", gbp: 4 },
    { id: "birthday_cake", emoji: "🎂", art: "a", one: "birthday cake", many: "birthday cakes", gbp: 22 },
    { id: "fish_chips", emoji: "🍟", art: "a", one: "fish and chips", many: "fish and chips", gbp: 11 },
    { id: "happy_meal", emoji: "🍟", art: "a", one: "Happy Meal", many: "Happy Meals", gbp: 4.2 },
    { id: "slushie", emoji: "🧊", art: "a", one: "slushie", many: "slushies", gbp: 2.5 },
    { id: "trampoline", emoji: "🤸", art: "a", one: "trampoline", many: "trampolines", gbp: 160 },
    { id: "bike", emoji: "🚲", art: "a", one: "bike", many: "bikes", gbp: 180 },
    { id: "drone", emoji: "🚁", art: "a", one: "drone", many: "drones", gbp: 80 },
    { id: "console", emoji: "🎮", art: "a", one: "games console", many: "games consoles", gbp: 280 },
    { id: "rubber_duck", emoji: "🦆", art: "a", one: "rubber duck", many: "rubber ducks", gbp: 2 },
    { id: "balloon_ride", emoji: "🎈", art: "a", one: "hot-air balloon ride", many: "hot-air balloon rides", gbp: 160 },
    { id: "toy_sub", emoji: "🚤", art: "a", one: "toy submarine", many: "toy submarines", gbp: 18 },
    { id: "submarine", emoji: "🚢", art: "a", one: "submarine", many: "submarines", gbp: 3000000 },
    { id: "yoyo", emoji: "🪀", art: "a", one: "yo-yo", many: "yo-yos", gbp: 5 },
    { id: "teddy", emoji: "🧸", art: "a", one: "teddy bear", many: "teddy bears", gbp: 12 },
    { id: "scooter", emoji: "🛴", art: "a", one: "scooter", many: "scooters", gbp: 50 },
    { id: "skateboard", emoji: "🛹", art: "a", one: "skateboard", many: "skateboards", gbp: 40 },
    { id: "board_game", emoji: "🎲", art: "a", one: "board game", many: "board games", gbp: 20 },
    { id: "puzzle", emoji: "🧩", art: "a", one: "1,000-piece puzzle", many: "1,000-piece puzzles", gbp: 15 },
    { id: "video_game", emoji: "👾", art: "a", one: "video game", many: "video games", gbp: 45 },
    { id: "action_figure", emoji: "🦸", art: "an", one: "action figure", many: "action figures", gbp: 15 },
    { id: "kite", emoji: "🪁", art: "a", one: "kite", many: "kites", gbp: 8 },
    { id: "bubbles", emoji: "🫧", art: "a", one: "bubble machine", many: "bubble machines", gbp: 12 },
    { id: "theme_park", emoji: "🎢", art: "a", one: "theme park ticket", many: "theme park tickets", gbp: 42 },
    { id: "zoo", emoji: "🦁", art: "a", one: "zoo trip", many: "zoo trips", gbp: 22 },
    { id: "soft_play", emoji: "🛝", art: "a", one: "soft play session", many: "soft play sessions", gbp: 8 },
    { id: "bowling", emoji: "🎳", art: "a", one: "game of bowling", many: "games of bowling", gbp: 8 },
    { id: "book", emoji: "📖", art: "a", one: "story book", many: "story books", gbp: 8 },
    { id: "space_hopper", emoji: "🟠", art: "a", one: "space hopper", many: "space hoppers", gbp: 15 },
    { id: "tent", emoji: "⛺", art: "a", one: "tent", many: "tents", gbp: 60 },
    { id: "go_kart", emoji: "🏎️", art: "a", one: "go-kart session", many: "go-kart sessions", gbp: 25 },
    { id: "pony_ride", emoji: "🐎", art: "a", one: "pony ride", many: "pony rides", gbp: 8 },
    { id: "train_set", emoji: "🚂", art: "a", one: "train set", many: "train sets", gbp: 45 },
    { id: "dons_away_top", emoji: "👕", art: "an", one: "Aberdeen FC away top", many: "Aberdeen FC away tops", gbp: 65 },
    { id: "dons_third_top", emoji: "👕", art: "an", one: "Aberdeen FC third top", many: "Aberdeen FC third tops", gbp: 65 },
    { id: "dons_beanie", emoji: "🧢", art: "a", one: "Dons beanie", many: "Dons beanies", gbp: 18 },
    { id: "dons_bobble", emoji: "🧢", art: "a", one: "Dons bobble hat", many: "Dons bobble hats", gbp: 20 },
    { id: "dons_flag", emoji: "🚩", art: "a", one: "Dons flag", many: "Dons flags", gbp: 12 },
    { id: "dons_pennant", emoji: "🎏", art: "a", one: "Pittodrie pennant", many: "Pittodrie pennants", gbp: 8 },
    { id: "dons_programme", emoji: "📰", art: "a", one: "Dons match programme", many: "Dons match programmes", gbp: 4 },
    { id: "dons_album", emoji: "📔", art: "a", one: "Dons sticker album", many: "Dons sticker albums", gbp: 6 },
    { id: "shin_pads", emoji: "🦵", art: "a", one: "pair of shin pads", many: "pairs of shin pads", gbp: 12 },
    { id: "footie_bottle", emoji: "🍾", art: "a", one: "football water bottle", many: "football water bottles", gbp: 8 },
    { id: "dons_bag", emoji: "🎒", art: "a", one: "Dons backpack", many: "Dons backpacks", gbp: 25 },
    { id: "dons_mug", emoji: "☕", art: "a", one: "Dons mug", many: "Dons mugs", gbp: 10 },
    { id: "dons_keyring", emoji: "🔑", art: "a", one: "Dons keyring", many: "Dons keyrings", gbp: 5 },
    { id: "dons_badge", emoji: "📛", art: "a", one: "Dons pin badge", many: "Dons pin badges", gbp: 3 },
    { id: "dons_wrist", emoji: "❤️", art: "a", one: "Dons wristband", many: "Dons wristbands", gbp: 2 },
    { id: "foam_finger", emoji: "👆", art: "a", one: "foam finger", many: "foam fingers", gbp: 8 },
    { id: "dons_mascot", emoji: "🧸", art: "a", one: "Dons mascot soft toy", many: "Dons mascot soft toys", gbp: 18 },
    { id: "training_bib", emoji: "🦺", art: "a", one: "training bib", many: "training bibs", gbp: 6 },
    { id: "footie_socks", emoji: "🧦", art: "a", one: "pair of football socks", many: "pairs of football socks", gbp: 8 },
    { id: "garden_goal", emoji: "🥅", art: "a", one: "garden goal", many: "garden goals", gbp: 40 },
    { id: "subbuteo", emoji: "⚽", art: "a", one: "Subbuteo-style set", many: "Subbuteo-style sets", gbp: 30 },
    { id: "table_footie", emoji: "⚽", art: "a", one: "table football game", many: "table football games", gbp: 45 },
    { id: "fifa_game", emoji: "🎮", art: "a", one: "football video game", many: "football video games", gbp: 50 },
    { id: "motd_mag", emoji: "📰", art: "a", one: "Match of the Day magazine", many: "Match of the Day magazines", gbp: 3.5 },
    { id: "panini_pack", emoji: "📦", art: "a", one: "Panini-style sticker pack", many: "Panini-style sticker packs", gbp: 1.2 },
    { id: "pittodrie_tour", emoji: "🏟️", art: "a", one: "Pittodrie stadium tour", many: "Pittodrie stadium tours", gbp: 18 },
    { id: "boot_bag", emoji: "👜", art: "a", one: "boot bag", many: "boot bags", gbp: 15 },
    { id: "footie_pump", emoji: "🎈", art: "a", one: "football pump", many: "football pumps", gbp: 7 },
    { id: "cones_pack", emoji: "🚧", art: "a", one: "pack of training cones", many: "packs of training cones", gbp: 10 },
    { id: "captain_band", emoji: "🛡️", art: "a", one: "captain's armband", many: "captain's armbands", gbp: 5 },
    { id: "corner_flag", emoji: "🚩", art: "a", one: "corner flag", many: "corner flags", gbp: 12 },
    { id: "rebounder", emoji: "🥅", art: "a", one: "kick-back rebounder", many: "kick-back rebounders", gbp: 35 },
    { id: "dons_jacket", emoji: "🧥", art: "a", one: "Dons rain jacket", many: "Dons rain jackets", gbp: 45 },
    { id: "dons_pyjamas", emoji: "🛏️", art: "a", one: "pair of Dons pyjamas", many: "pairs of Dons pyjamas", gbp: 22 },
    { id: "scotland_top", emoji: "👕", art: "a", one: "Scotland football top", many: "Scotland football tops", gbp: 70 },
    { id: "scotland_ticket", emoji: "🎫", art: "a", one: "Scotland match ticket", many: "Scotland match tickets", gbp: 40 },
    { id: "world_cup_album", emoji: "📔", art: "a", one: "World Cup sticker album", many: "World Cup sticker albums", gbp: 8 },
    { id: "footie_trophy", emoji: "🏆", art: "a", one: "football trophy", many: "football trophies", gbp: 15 },
    { id: "dons_calendar", emoji: "📅", art: "an", one: "Aberdeen FC calendar", many: "Aberdeen FC calendars", gbp: 12 },
    { id: "pitch_side", emoji: "🎟️", art: "a", one: "pitch-side photo", many: "pitch-side photos", gbp: 15 },
    { id: "keepy_uppy", emoji: "⚽", art: "a", one: "keepy-uppy trainer ball", many: "keepy-uppy trainer balls", gbp: 10 },
    { id: "indoor_ball", emoji: "🏐", art: "an", one: "indoor football", many: "indoor footballs", gbp: 12 },
    { id: "mini_goals", emoji: "🥅", art: "a", one: "pair of mini goals", many: "pairs of mini goals", gbp: 25 },
    { id: "footie_cards", emoji: "🃏", art: "a", one: "pack of football trivia cards", many: "packs of football trivia cards", gbp: 8 },
    { id: "dons_sticker", emoji: "🌟", art: "a", one: "Dons window sticker", many: "Dons window stickers", gbp: 3 },
    { id: "jd_tractor", emoji: "🚜", art: "a", one: "John Deere tractor", many: "John Deere tractors", gbp: 22000 },
    { id: "nh_tractor", emoji: "🚜", art: "a", one: "New Holland tractor", many: "New Holland tractors", gbp: 21000 },
    { id: "case_tractor", emoji: "🚜", art: "a", one: "Case IH tractor", many: "Case IH tractors", gbp: 21000 },
    { id: "fendt_tractor", emoji: "🚜", art: "a", one: "Fendt tractor", many: "Fendt tractors", gbp: 25000 },
    { id: "combine", emoji: "🌾", art: "a", one: "combine harvester", many: "combine harvesters", gbp: 80000 },
    { id: "farm_trailer", emoji: "🚛", art: "a", one: "farm trailer", many: "farm trailers", gbp: 3500 },
    { id: "hay_bale", emoji: "🌾", art: "a", one: "hay bale", many: "hay bales", gbp: 40 },
    { id: "silage_bale", emoji: "🟢", art: "a", one: "silage bale", many: "silage bales", gbp: 35 },
    { id: "sheep", emoji: "🐑", art: "a", one: "sheep", many: "sheep", gbp: 120 },
    { id: "lamb", emoji: "🐑", art: "a", one: "lamb", many: "lambs", gbp: 80 },
    { id: "pig", emoji: "🐷", art: "a", one: "pig", many: "pigs", gbp: 150 },
    { id: "piglet", emoji: "🐷", art: "a", one: "piglet", many: "piglets", gbp: 60 },
    { id: "chicken", emoji: "🐔", art: "a", one: "chicken", many: "chickens", gbp: 12 },
    { id: "cockerel", emoji: "🐓", art: "a", one: "cockerel", many: "cockerels", gbp: 15 },
    { id: "duck_farm", emoji: "🦆", art: "a", one: "farm duck", many: "farm ducks", gbp: 18 },
    { id: "goat", emoji: "🐐", art: "a", one: "goat", many: "goats", gbp: 100 },
    { id: "calf", emoji: "🐮", art: "a", one: "calf", many: "calves", gbp: 250 },
    { id: "farm_quad", emoji: "🏍️", art: "a", one: "farm quad bike", many: "farm quad bikes", gbp: 2800 },
    { id: "wellies", emoji: "👢", art: "a", one: "pair of wellies", many: "pairs of wellies", gbp: 20 },
    { id: "flat_cap", emoji: "🧢", art: "a", one: "flat cap", many: "flat caps", gbp: 15 },
    { id: "toy_barn", emoji: "🏚️", art: "a", one: "toy barn", many: "toy barns", gbp: 35 },
    { id: "toy_combine", emoji: "🌾", art: "a", one: "toy combine harvester", many: "toy combine harvesters", gbp: 30 },
    { id: "chicken_coop", emoji: "🏠", art: "a", one: "chicken coop", many: "chicken coops", gbp: 150 },
    { id: "sheepdog", emoji: "🐕", art: "a", one: "sheepdog", many: "sheepdogs", gbp: 700 },
    { id: "scarecrow", emoji: "🎃", art: "a", one: "scarecrow", many: "scarecrows", gbp: 20 },
    { id: "wheelbarrow", emoji: "🛒", art: "a", one: "wheelbarrow", many: "wheelbarrows", gbp: 45 },
    { id: "tractor_keyring", emoji: "🔑", art: "a", one: "tractor keyring", many: "tractor keyrings", gbp: 5 },
    { id: "highland_show", emoji: "🎫", art: "a", one: "Royal Highland Show ticket", many: "Royal Highland Show tickets", gbp: 38 },
    { id: "agri_show", emoji: "🎟️", art: "an", one: "agricultural show ticket", many: "agricultural show tickets", gbp: 15 },
    { id: "potato_sack", emoji: "🥔", art: "a", one: "sack of tatties", many: "sacks of tatties", gbp: 8 },
    { id: "neeps", emoji: "🥕", art: "a", one: "bag of neeps", many: "bags of neeps", gbp: 2.5 },
    { id: "straw_bale", emoji: "🌾", art: "a", one: "straw bale", many: "straw bales", gbp: 8 },
    { id: "toy_jd", emoji: "🚜", art: "a", one: "John Deere toy tractor", many: "John Deere toy tractors", gbp: 28 },
    { id: "toy_nh", emoji: "🚜", art: "a", one: "New Holland toy tractor", many: "New Holland toy tractors", gbp: 28 },
    { id: "farm_fence", emoji: "🪵", art: "a", one: "pack of toy farm fences", many: "packs of toy farm fences", gbp: 10 },
    { id: "feed_bucket", emoji: "🪣", art: "a", one: "feed bucket", many: "feed buckets", gbp: 8 },
    { id: "milk_churn", emoji: "🥛", art: "a", one: "milk churn", many: "milk churns", gbp: 25 },
    { id: "pony_stable", emoji: "🏠", art: "a", one: "toy stable", many: "toy stables", gbp: 40 },
    { id: "farm_open", emoji: "🎟️", art: "an", one: "open farm day ticket", many: "open farm day tickets", gbp: 12 },
    { id: "hayride", emoji: "🚜", art: "a", one: "hayride", many: "hayrides", gbp: 8 },
    { id: "corn_maze", emoji: "🌽", art: "a", one: "corn maze ticket", many: "corn maze tickets", gbp: 10 },
    { id: "tractor_calendar", emoji: "📅", art: "a", one: "tractor calendar", many: "tractor calendars", gbp: 10 },
    { id: "farm_hoodie", emoji: "🧥", art: "a", one: "farm hoodie", many: "farm hoodies", gbp: 30 },
    { id: "cat", emoji: "🐱", art: "a", one: "cat", many: "cats", gbp: 50 },
    { id: "border_collie", emoji: "🐕", art: "a", one: "Border Collie", many: "Border Collies", gbp: 800 },
    { id: "guinea_pig", emoji: "🐹", art: "a", one: "guinea pig", many: "guinea pigs", gbp: 25 },
    { id: "gerbil", emoji: "🐹", art: "a", one: "gerbil", many: "gerbils", gbp: 15 },
    { id: "tortoise", emoji: "🐢", art: "a", one: "tortoise", many: "tortoises", gbp: 80 },
    { id: "gecko", emoji: "🦎", art: "a", one: "gecko", many: "geckos", gbp: 40 },
    { id: "frog", emoji: "🐸", art: "a", one: "frog", many: "frogs", gbp: 15 },
    { id: "owl_soft", emoji: "🦉", art: "an", one: "owl soft toy", many: "owl soft toys", gbp: 14 },
    { id: "hedgehog_soft", emoji: "🦔", art: "a", one: "hedgehog soft toy", many: "hedgehog soft toys", gbp: 12 },
    { id: "fox_soft", emoji: "🦊", art: "a", one: "fox soft toy", many: "fox soft toys", gbp: 14 },
    { id: "red_squirrel", emoji: "🐿️", art: "a", one: "red squirrel soft toy", many: "red squirrel soft toys", gbp: 12 },
    { id: "otter_soft", emoji: "🦦", art: "an", one: "otter soft toy", many: "otter soft toys", gbp: 14 },
    { id: "seal_soft", emoji: "🦭", art: "a", one: "seal soft toy", many: "seal soft toys", gbp: 14 },
    { id: "puffin_soft", emoji: "🐦", art: "a", one: "puffin soft toy", many: "puffin soft toys", gbp: 12 },
    { id: "penguin_soft", emoji: "🐧", art: "a", one: "penguin soft toy", many: "penguin soft toys", gbp: 14 },
    { id: "elephant_soft", emoji: "🐘", art: "an", one: "elephant soft toy", many: "elephant soft toys", gbp: 16 },
    { id: "giraffe_soft", emoji: "🦒", art: "a", one: "giraffe soft toy", many: "giraffe soft toys", gbp: 16 },
    { id: "panda_soft", emoji: "🐼", art: "a", one: "panda soft toy", many: "panda soft toys", gbp: 16 },
    { id: "koala_soft", emoji: "🐨", art: "a", one: "koala soft toy", many: "koala soft toys", gbp: 14 },
    { id: "meerkat_soft", emoji: "🦫", art: "a", one: "meerkat soft toy", many: "meerkat soft toys", gbp: 14 },
    { id: "llama_soft", emoji: "🦙", art: "a", one: "llama soft toy", many: "llama soft toys", gbp: 14 },
    { id: "alpaca_soft", emoji: "🦙", art: "an", one: "alpaca soft toy", many: "alpaca soft toys", gbp: 14 },
    { id: "reindeer_soft", emoji: "🦌", art: "a", one: "reindeer soft toy", many: "reindeer soft toys", gbp: 15 },
    { id: "dolphin_soft", emoji: "🐬", art: "a", one: "dolphin soft toy", many: "dolphin soft toys", gbp: 14 },
    { id: "whale_soft", emoji: "🐋", art: "a", one: "whale soft toy", many: "whale soft toys", gbp: 18 },
    { id: "butterfly_net", emoji: "🦋", art: "a", one: "butterfly-watching kit", many: "butterfly-watching kits", gbp: 10 },
    { id: "ladybird_kit", emoji: "🐞", art: "a", one: "minibeast kit", many: "minibeast kits", gbp: 8 },
    { id: "bee_hotel", emoji: "🐝", art: "a", one: "bee hotel", many: "bee hotels", gbp: 15 },
    { id: "wildlife_park", emoji: "🎟️", art: "a", one: "Highland Wildlife Park ticket", many: "Highland Wildlife Park tickets", gbp: 22 },
    { id: "sspca_toy", emoji: "🧸", art: "an", one: "animal-rescue soft toy", many: "animal-rescue soft toys", gbp: 12 },
    { id: "aquarium", emoji: "🐠", art: "an", one: "aquarium trip", many: "aquarium trips", gbp: 18 },
    { id: "sea_life", emoji: "🦈", art: "a", one: "sea-life centre ticket", many: "sea-life centre tickets", gbp: 20 },
    { id: "pony_groom", emoji: "🐎", art: "a", one: "pony grooming session", many: "pony grooming sessions", gbp: 15 },
    { id: "bird_feeder", emoji: "🐦", art: "a", one: "bird feeder", many: "bird feeders", gbp: 12 },
    { id: "binoculars_birds", emoji: "🔭", art: "a", one: "pair of birdwatching binoculars", many: "pairs of birdwatching binoculars", gbp: 35 },
    { id: "hamster_cage", emoji: "🏠", art: "a", one: "hamster cage", many: "hamster cages", gbp: 30 },
    { id: "fish_tank", emoji: "🐠", art: "a", one: "fish tank", many: "fish tanks", gbp: 40 },
    { id: "dog_bed", emoji: "🛏️", art: "a", one: "dog bed", many: "dog beds", gbp: 30 },
    { id: "irnbru_lolly", emoji: "🧡", art: "an", one: "Irn-Bru ice lolly", many: "Irn-Bru ice lollies", gbp: 1.2 },
    { id: "irnbru_slush", emoji: "🧃", art: "an", one: "Irn-Bru slush", many: "Irn-Bru slushes", gbp: 2.5 },
    { id: "butteries", emoji: "🥐", art: "a", one: "bag of butteries", many: "bags of butteries", gbp: 3 },
    { id: "lorne_roll", emoji: "🥪", art: "a", one: "square-sausage roll", many: "square-sausage rolls", gbp: 3.5 },
    { id: "macaroni_pie", emoji: "🥧", art: "a", one: "macaroni pie", many: "macaroni pies", gbp: 2.5 },
    { id: "bridie", emoji: "🥟", art: "a", one: "bridie", many: "bridies", gbp: 2.2 },
    { id: "stovies", emoji: "🍲", art: "a", one: "plate of stovies", many: "plates of stovies", gbp: 7 },
    { id: "tattie_scone", emoji: "🥔", art: "a", one: "tattie scone", many: "tattie scones", gbp: 0.6 },
    { id: "scotch_egg", emoji: "🥚", art: "a", one: "Scotch egg", many: "Scotch eggs", gbp: 2 },
    { id: "clootie", emoji: "🍮", art: "a", one: "clootie dumpling", many: "clootie dumplings", gbp: 4 },
    { id: "snowball_cake", emoji: "🧁", art: "a", one: "Tunnock's snowball", many: "Tunnock's snowballs", gbp: 0.6 },
    { id: "millionaire", emoji: "🍫", art: "a", one: "millionaire shortbread", many: "millionaire shortbreads", gbp: 2.5 },
    { id: "empire_biscuit", emoji: "🍪", art: "an", one: "empire biscuit", many: "empire biscuits", gbp: 1.5 },
    { id: "soor_ploom", emoji: "🍬", art: "a", one: "bag of soor plooms", many: "bags of soor plooms", gbp: 1.5 },
    { id: "cola_cubes", emoji: "🍬", art: "a", one: "bag of cola cubes", many: "bags of cola cubes", gbp: 1.5 },
    { id: "flying_saucer", emoji: "🛸", art: "a", one: "packet of flying saucers", many: "packets of flying saucers", gbp: 1 },
    { id: "lucky_bag", emoji: "🎒", art: "a", one: "lucky bag", many: "lucky bags", gbp: 1.5 },
    { id: "red_lemonade", emoji: "🥤", art: "a", one: "red lemonade", many: "red lemonades", gbp: 1.2 },
    { id: "chippy_sauce", emoji: "🍟", art: "a", one: "chippy supper with sauce", many: "chippy suppers with sauce", gbp: 9 },
    { id: "tartan_blanket", emoji: "🧶", art: "a", one: "tartan blanket", many: "tartan blankets", gbp: 35 },
    { id: "tartan_bunnet", emoji: "🧢", art: "a", one: "tartan bunnet", many: "tartan bunnets", gbp: 15 },
    { id: "tartan_socks", emoji: "🧦", art: "a", one: "pair of tartan socks", many: "pairs of tartan socks", gbp: 8 },
    { id: "sporran_toy", emoji: "👜", art: "a", one: "toy sporran", many: "toy sporrans", gbp: 12 },
    { id: "ceilidh_ticket", emoji: "🎟️", art: "a", one: "ceilidh ticket", many: "ceilidh tickets", gbp: 12 },
    { id: "highland_shoes", emoji: "👟", art: "a", one: "pair of highland dancing shoes", many: "pairs of highland dancing shoes", gbp: 40 },
    { id: "highland_games", emoji: "🎫", art: "a", one: "Highland games ticket", many: "Highland games tickets", gbp: 15 },
    { id: "caber_toy", emoji: "🪵", art: "a", one: "toy caber", many: "toy cabers", gbp: 10 },
    { id: "wellie_wang", emoji: "👢", art: "a", one: "wellie-wanging go", many: "wellie-wanging goes", gbp: 3 },
    { id: "nessie_mug", emoji: "☕", art: "a", one: "Nessie mug", many: "Nessie mugs", gbp: 10 },
    { id: "nessie_globe", emoji: "🔮", art: "a", one: "Nessie snow globe", many: "Nessie snow globes", gbp: 12 },
    { id: "tin_whistle", emoji: "🎶", art: "a", one: "tin whistle", many: "tin whistles", gbp: 8 },
    { id: "chanter", emoji: "🎶", art: "a", one: "practice chanter", many: "practice chanters", gbp: 25 },
    { id: "accordion", emoji: "🪗", art: "an", one: "accordion", many: "accordions", gbp: 200 },
    { id: "skye_trip", emoji: "🚌", art: "a", one: "trip to Skye", many: "trips to Skye", gbp: 40 },
    { id: "nessie_cruise", emoji: "🚢", art: "a", one: "Loch Ness cruise", many: "Loch Ness cruises", gbp: 22 },
    { id: "cairngorm_funi", emoji: "🚠", art: "a", one: "Cairngorm funicular ticket", many: "Cairngorm funicular tickets", gbp: 18 },
    { id: "jacobite", emoji: "🚂", art: "a", one: "Jacobite steam-train ticket", many: "Jacobite steam-train tickets", gbp: 55 },
    { id: "science_centre", emoji: "🎟️", art: "a", one: "Glasgow Science Centre ticket", many: "Glasgow Science Centre tickets", gbp: 16 },
    { id: "dynamic_earth", emoji: "🌍", art: "an", one: "Our Dynamic Earth ticket", many: "Our Dynamic Earth tickets", gbp: 18 },
    { id: "codonas", emoji: "🎡", art: "a", one: "Codona's wristband", many: "Codona's wristbands", gbp: 25 },
    { id: "aberdeen_beach", emoji: "🏖️", art: "an", one: "Aberdeen beach day", many: "Aberdeen beach days", gbp: 10 },
    { id: "rowie_roll", emoji: "🥐", art: "a", one: "rowie and square sausage", many: "rowies and square sausage", gbp: 4 },
    { id: "irnbru_bar", emoji: "🍫", art: "an", one: "Irn-Bru bar", many: "Irn-Bru bars", gbp: 1 },
    { id: "tunnocks_hamper", emoji: "🧺", art: "a", one: "Tunnock's hamper", many: "Tunnock's hampers", gbp: 20 },
    { id: "kilt_own", emoji: "🧶", art: "a", one: "wee kilt", many: "wee kilts", gbp: 80 },
    { id: "thistle_badge", emoji: "🟣", art: "a", one: "thistle badge", many: "thistle badges", gbp: 4 },
    { id: "edin_zoo", emoji: "🎟️", art: "an", one: "Edinburgh Zoo ticket", many: "Edinburgh Zoo tickets", gbp: 24 },
    { id: "stirling_castle", emoji: "🏰", art: "a", one: "Stirling Castle ticket", many: "Stirling Castle tickets", gbp: 18 },
    { id: "homer_plush", emoji: "🧸", art: "a", one: "Homer soft toy", many: "Homer soft toys", gbp: 16 },
    { id: "bart_figure", emoji: "🛹", art: "a", one: "Bart figure", many: "Bart figures", gbp: 15 },
    { id: "lisa_sax", emoji: "🎷", art: "a", one: "Lisa-style saxophone", many: "Lisa-style saxophones", gbp: 40 },
    { id: "maggie_dummy", emoji: "👶", art: "a", one: "Maggie-style dummy", many: "Maggie-style dummies", gbp: 4 },
    { id: "marge_hairband", emoji: "💙", art: "a", one: "Marge-style hairband", many: "Marge-style hairbands", gbp: 6 },
    { id: "santa_helper", emoji: "🐶", art: "a", one: "Santa's Little Helper toy", many: "Santa's Little Helper toys", gbp: 14 },
    { id: "snowball_cat", emoji: "🐱", art: "a", one: "Snowball cat toy", many: "Snowball cat toys", gbp: 12 },
    { id: "radioactive_comic", emoji: "📘", art: "a", one: "Radioactive Man comic", many: "Radioactive Man comics", gbp: 8 },
    { id: "itchy_toy", emoji: "🐭", art: "an", one: "Itchy toy", many: "Itchy toys", gbp: 12 },
    { id: "scratchy_toy", emoji: "🐱", art: "a", one: "Scratchy toy", many: "Scratchy toys", gbp: 12 },
    { id: "kang_figure", emoji: "👽", art: "a", one: "Kang figure", many: "Kang figures", gbp: 18 },
    { id: "kodos_figure", emoji: "👽", art: "a", one: "Kodos figure", many: "Kodos figures", gbp: 18 },
    { id: "ralph_figure", emoji: "🧸", art: "a", one: "Ralph figure", many: "Ralph figures", gbp: 15 },
    { id: "ned_figure", emoji: "😉", art: "a", one: "Ned Flanders figure", many: "Ned Flanders figures", gbp: 15 },
    { id: "simpsons_house", emoji: "🏠", art: "a", one: "Simpsons house playset", many: "Simpsons house playsets", gbp: 50 },
    { id: "couch_play", emoji: "🛋️", art: "a", one: "couch playset", many: "couch playsets", gbp: 25 },
    { id: "kwik_e_play", emoji: "🏪", art: "a", one: "Kwik-E-Mart playset", many: "Kwik-E-Mart playsets", gbp: 45 },
    { id: "plant_play", emoji: "🏭", art: "a", one: "power-plant playset", many: "power-plant playsets", gbp: 40 },
    { id: "school_bus_toy", emoji: "🚌", art: "a", one: "school-bus toy", many: "school-bus toys", gbp: 20 },
    { id: "donut_sprinkles", emoji: "🍩", art: "a", one: "tub of donut sprinkles", many: "tubs of donut sprinkles", gbp: 2 },
    { id: "squishee_cup", emoji: "🥤", art: "a", one: "Squishee cup", many: "Squishee cups", gbp: 8 },
    { id: "krusty_merch", emoji: "🤡", art: "a", one: "Krusty merch pack", many: "Krusty merch packs", gbp: 12 },
    { id: "itchy_game", emoji: "🎮", art: "an", one: "Itchy & Scratchy game", many: "Itchy & Scratchy games", gbp: 20 },
    { id: "chalkboard", emoji: "📋", art: "a", one: "Bart-style chalkboard", many: "Bart-style chalkboards", gbp: 10 },
    { id: "donut_phone", emoji: "📱", art: "a", one: "donut toy phone", many: "donut toy phones", gbp: 12 },
    { id: "homer_mug", emoji: "☕", art: "a", one: "Homer mug", many: "Homer mugs", gbp: 10 },
    { id: "bart_tee", emoji: "👕", art: "a", one: "Bart T-shirt", many: "Bart T-shirts", gbp: 18 },
    { id: "lisa_book", emoji: "📖", art: "a", one: "Lisa-style homework book", many: "Lisa-style homework books", gbp: 6 },
    { id: "milhouse_fig", emoji: "🤓", art: "a", one: "Milhouse figure", many: "Milhouse figures", gbp: 15 },
    { id: "wiggum_fig", emoji: "👮", art: "a", one: "Chief Wiggum figure", many: "Chief Wiggum figures", gbp: 15 },
    { id: "willie_fig", emoji: "🧹", art: "a", one: "Groundskeeper Willie figure", many: "Groundskeeper Willie figures", gbp: 15 },
    { id: "apu_fig", emoji: "🏪", art: "an", one: "Apu figure", many: "Apu figures", gbp: 15 },
    { id: "nelson_fig", emoji: "😄", art: "a", one: "Nelson figure", many: "Nelson figures", gbp: 15 },
    { id: "simpsons_cards", emoji: "🃏", art: "a", one: "Simpsons card game", many: "Simpsons card games", gbp: 12 },
    { id: "simpsons_puzzle", emoji: "🧩", art: "a", one: "Simpsons puzzle", many: "Simpsons puzzles", gbp: 14 },
    { id: "donut_slippers", emoji: "🍩", art: "a", one: "pair of donut slippers", many: "pairs of donut slippers", gbp: 16 },
    { id: "couch_gag_book", emoji: "📕", art: "a", one: "couch-gag picture book", many: "couch-gag picture books", gbp: 10 },
    { id: "playdoh", emoji: "🎨", art: "a", one: "Play-Doh tub set", many: "Play-Doh tub sets", gbp: 10 },
    { id: "slime_tub", emoji: "🟢", art: "a", one: "tub of slime", many: "tubs of slime", gbp: 5 },
    { id: "slinky", emoji: "🌀", art: "a", one: "Slinky", many: "Slinkies", gbp: 6 },
    { id: "beyblade", emoji: "🌀", art: "a", one: "spinning-top battle set", many: "spinning-top battle sets", gbp: 15 },
    { id: "pokemon_pack", emoji: "📦", art: "a", one: "Pokémon-style card pack", many: "Pokémon-style card packs", gbp: 4 },
    { id: "pokemon_tin", emoji: "🗃️", art: "a", one: "Pokémon-style card tin", many: "Pokémon-style card tins", gbp: 12 },
    { id: "squishmallow", emoji: "🧸", art: "a", one: "squishy plush", many: "squishy plushes", gbp: 18 },
    { id: "fidget", emoji: "🌀", art: "a", one: "fidget toy", many: "fidget toys", gbp: 4 },
    { id: "kinetic_sand", emoji: "🏖️", art: "a", one: "tub of kinetic sand", many: "tubs of kinetic sand", gbp: 12 },
    { id: "marble_run", emoji: "🔵", art: "a", one: "marble run", many: "marble runs", gbp: 25 },
    { id: "jigsaw_500", emoji: "🧩", art: "a", one: "500-piece jigsaw", many: "500-piece jigsaws", gbp: 12 },
    { id: "magic_set", emoji: "🎩", art: "a", one: "magic set", many: "magic sets", gbp: 18 },
    { id: "science_kit", emoji: "🔬", art: "a", one: "science kit", many: "science kits", gbp: 20 },
    { id: "microscope", emoji: "🔬", art: "a", one: "toy microscope", many: "toy microscopes", gbp: 25 },
    { id: "walkie_talkies", emoji: "📡", art: "a", one: "pair of walkie-talkies", many: "pairs of walkie-talkies", gbp: 22 },
    { id: "kendama", emoji: "🎯", art: "a", one: "kendama", many: "kendamas", gbp: 12 },
    { id: "hacky_sack", emoji: "⚽", art: "a", one: "hacky sack", many: "hacky sacks", gbp: 5 },
    { id: "pogo_stick", emoji: "🦘", art: "a", one: "pogo stick", many: "pogo sticks", gbp: 30 },
    { id: "stilts", emoji: "🦵", art: "a", one: "pair of stilts", many: "pairs of stilts", gbp: 20 },
    { id: "roller_skates", emoji: "🛼", art: "a", one: "pair of roller skates", many: "pairs of roller skates", gbp: 35 },
    { id: "ice_skates", emoji: "⛸️", art: "a", one: "pair of ice skates", many: "pairs of ice skates", gbp: 40 },
    { id: "helmet", emoji: "⛑️", art: "a", one: "bike helmet", many: "bike helmets", gbp: 25 },
    { id: "knee_pads", emoji: "🛡️", art: "a", one: "pair of knee pads", many: "pairs of knee pads", gbp: 12 },
    { id: "uno", emoji: "🃏", art: "a", one: "pack of UNO", many: "packs of UNO", gbp: 8 },
    { id: "dobble", emoji: "🟡", art: "a", one: "Dobble-style game", many: "Dobble-style games", gbp: 12 },
    { id: "guess_who", emoji: "❓", art: "a", one: "Guess Who-style game", many: "Guess Who-style games", gbp: 15 },
    { id: "connect4", emoji: "🔴", art: "a", one: "Connect 4-style game", many: "Connect 4-style games", gbp: 12 },
    { id: "jenga", emoji: "🪵", art: "a", one: "Jenga-style tower game", many: "Jenga-style tower games", gbp: 12 },
    { id: "hungry_hippos", emoji: "🦛", art: "a", one: "Hungry Hippos-style game", many: "Hungry Hippos-style games", gbp: 16 },
    { id: "kerplunk", emoji: "🟢", art: "a", one: "Kerplunk-style game", many: "Kerplunk-style games", gbp: 14 },
    { id: "twister", emoji: "🌀", art: "a", one: "Twister-style mat game", many: "Twister-style mat games", gbp: 16 },
    { id: "mouse_trap", emoji: "🐭", art: "a", one: "Mouse Trap-style game", many: "Mouse Trap-style games", gbp: 20 },
    { id: "playmobil", emoji: "🧱", art: "a", one: "Playmobil-style set", many: "Playmobil-style sets", gbp: 25 },
    { id: "sylvanian", emoji: "🏠", art: "a", one: "Sylvanian-style family set", many: "Sylvanian-style family sets", gbp: 25 },
    { id: "rubiks", emoji: "🧊", art: "a", one: "Rubik's Cube-style puzzle", many: "Rubik's Cube-style puzzles", gbp: 10 },
    { id: "etch_a", emoji: "✏️", art: "an", one: "Etch A Sketch-style board", many: "Etch A Sketch-style boards", gbp: 15 },
    { id: "magformers", emoji: "🔷", art: "a", one: "magnetic tiles set", many: "magnetic tiles sets", gbp: 30 },
    { id: "plusplus", emoji: "➕", art: "a", one: "Plus-Plus-style set", many: "Plus-Plus-style sets", gbp: 15 },
    { id: "knex", emoji: "🔧", art: "a", one: "KNex-style building set", many: "KNex-style building sets", gbp: 22 },
    { id: "meccano", emoji: "🔩", art: "a", one: "Meccano-style kit", many: "Meccano-style kits", gbp: 25 },
    { id: "scalextric", emoji: "🏎️", art: "a", one: "slot-car set", many: "slot-car sets", gbp: 60 },
    { id: "robot_kit", emoji: "🤖", art: "a", one: "robot kit", many: "robot kits", gbp: 35 },
    { id: "coding_robot", emoji: "🤖", art: "a", one: "coding robot", many: "coding robots", gbp: 50 },
    { id: "jump_rope", emoji: "🪢", art: "a", one: "skipping rope", many: "skipping ropes", gbp: 6 },
    { id: "hula_hoop", emoji: "⭕", art: "a", one: "hula hoop", many: "hula hoops", gbp: 8 },
    { id: "frisbee", emoji: "🥏", art: "a", one: "frisbee", many: "frisbees", gbp: 8 },
    { id: "water_balloons", emoji: "💧", art: "a", one: "pack of water balloons", many: "packs of water balloons", gbp: 3 },
    { id: "sand_set", emoji: "🏖️", art: "a", one: "sandcastle set", many: "sandcastle sets", gbp: 10 },
    { id: "kaleidoscope", emoji: "🌈", art: "a", one: "kaleidoscope", many: "kaleidoscopes", gbp: 7 },
    { id: "sticker_book", emoji: "📔", art: "a", one: "sticker book", many: "sticker books", gbp: 6 },
    { id: "colouring", emoji: "🖍️", art: "a", one: "colouring book and pens", many: "colouring books and pens", gbp: 8 },
    { id: "paint_set", emoji: "🎨", art: "a", one: "paint set", many: "paint sets", gbp: 12 },
    { id: "bead_kit", emoji: "📿", art: "a", one: "bead kit", many: "bead kits", gbp: 10 },
    { id: "puppet", emoji: "🧦", art: "a", one: "sock puppet kit", many: "sock puppet kits", gbp: 6 },
    { id: "teddy_picnic", emoji: "🧺", art: "a", one: "teddy bears’ picnic set", many: "teddy bears’ picnic sets", gbp: 15 },
    { id: "jammy_dodger", emoji: "🍪", art: "a", one: "Jammy Dodger", many: "Jammy Dodgers", gbp: 0.6 },
    { id: "custard_cream", emoji: "🍪", art: "a", one: "custard cream", many: "custard creams", gbp: 0.4 },
    { id: "jaffa_cake", emoji: "🍊", art: "a", one: "Jaffa Cake", many: "Jaffa Cakes", gbp: 0.5 },
    { id: "wagon_wheel", emoji: "🍪", art: "a", one: "Wagon Wheel", many: "Wagon Wheels", gbp: 0.7 },
    { id: "penguin_bar", emoji: "🐧", art: "a", one: "Penguin biscuit", many: "Penguin biscuits", gbp: 0.6 },
    { id: "kitkat", emoji: "🍫", art: "a", one: "KitKat", many: "KitKats", gbp: 0.8 },
    { id: "freddo", emoji: "🐸", art: "a", one: "Freddo", many: "Freddos", gbp: 0.4 },
    { id: "curly_wurly", emoji: "🍫", art: "a", one: "Curly Wurly", many: "Curly Wurlys", gbp: 0.5 },
    { id: "flake99", emoji: "🍦", art: "a", one: "99 flake", many: "99 flakes", gbp: 2.5 },
    { id: "screwball", emoji: "🍦", art: "a", one: "screwball ice cream", many: "screwball ice creams", gbp: 2 },
    { id: "calippo", emoji: "🧃", art: "a", one: "Calippo", many: "Calippos", gbp: 1.5 },
    { id: "solero", emoji: "🥭", art: "a", one: "Solero", many: "Soleros", gbp: 1.8 },
    { id: "ice_lolly", emoji: "🍭", art: "an", one: "ice lolly", many: "ice lollies", gbp: 1 },
    { id: "sausage_roll", emoji: "🥐", art: "a", one: "sausage roll", many: "sausage rolls", gbp: 1.8 },
    { id: "steak_pie", emoji: "🥧", art: "a", one: "steak pie", many: "steak pies", gbp: 3.5 },
    { id: "beans_toast", emoji: "🍞", art: "a", one: "plate of beans on toast", many: "plates of beans on toast", gbp: 3 },
    { id: "toastie", emoji: "🥪", art: "a", one: "toastie", many: "toasties", gbp: 4 },
    { id: "pancake", emoji: "🥞", art: "a", one: "stack of pancakes", many: "stacks of pancakes", gbp: 5 },
    { id: "crumpet", emoji: "🍞", art: "a", one: "crumpet with butter", many: "crumpets with butter", gbp: 1 },
    { id: "hot_choc", emoji: "☕", art: "a", one: "hot chocolate", many: "hot chocolates", gbp: 3 },
    { id: "marshmallow", emoji: "🍬", art: "a", one: "bag of marshmallows", many: "bags of marshmallows", gbp: 1.5 },
    { id: "popcorn", emoji: "🍿", art: "a", one: "tub of popcorn", many: "tubs of popcorn", gbp: 3 },
    { id: "candy_floss", emoji: "🍭", art: "a", one: "candy floss", many: "candy flosses", gbp: 3 },
    { id: "toffee_apple", emoji: "🍏", art: "a", one: "toffee apple", many: "toffee apples", gbp: 2.5 },
    { id: "fudge_bag", emoji: "🍬", art: "a", one: "bag of fudge", many: "bags of fudge", gbp: 3 },
    { id: "jelly_bag", emoji: "🍇", art: "a", one: "bag of jelly sweets", many: "bags of jelly sweets", gbp: 1.5 },
    { id: "ice_pole", emoji: "🧊", art: "an", one: "ice pole", many: "ice poles", gbp: 0.5 },
    { id: "cupcake", emoji: "🧁", art: "a", one: "cupcake", many: "cupcakes", gbp: 2 },
    { id: "traybake", emoji: "🍰", art: "a", one: "traybake slice", many: "traybake slices", gbp: 2 },
    { id: "pokey_hat", emoji: "🍦", art: "a", one: "pokey hat", many: "pokey hats", gbp: 2 },
    { id: "waffle", emoji: "🧇", art: "a", one: "waffle", many: "waffles", gbp: 4 },
    { id: "churros", emoji: "🍩", art: "a", one: "portion of churros", many: "portions of churros", gbp: 4 },
    { id: "belgian_bun", emoji: "🧁", art: "a", one: "Belgian bun", many: "Belgian buns", gbp: 2 },
    { id: "cream_bun", emoji: "🧁", art: "a", one: "cream bun", many: "cream buns", gbp: 2 },
    { id: "biscuit_tin", emoji: "🍪", art: "a", one: "family biscuit tin", many: "family biscuit tins", gbp: 5 },
    { id: "selection_box", emoji: "🎁", art: "a", one: "selection box", many: "selection boxes", gbp: 6 },
    { id: "advent_cal", emoji: "📅", art: "an", one: "advent calendar", many: "advent calendars", gbp: 5 },
    { id: "hot_cross", emoji: "🧁", art: "a", one: "hot cross bun", many: "hot cross buns", gbp: 0.7 },
    { id: "ginger_bread", emoji: "🍪", art: "a", one: "gingerbread person", many: "gingerbread people", gbp: 1.5 },
    { id: "ice_cream_van", emoji: "🚚", art: "an", one: "ice-cream van treat", many: "ice-cream van treats", gbp: 2.5 },
    { id: "bus_ticket", emoji: "🚌", art: "a", one: "bus ticket", many: "bus tickets", gbp: 2.5 },
    { id: "train_ticket", emoji: "🚆", art: "a", one: "train ticket", many: "train tickets", gbp: 12 },
    { id: "plane_ticket", emoji: "✈️", art: "a", one: "plane ticket", many: "plane tickets", gbp: 80 },
    { id: "ferry_ticket", emoji: "⛴️", art: "a", one: "ferry ticket", many: "ferry tickets", gbp: 25 },
    { id: "double_decker", emoji: "🚌", art: "a", one: "double-decker bus toy", many: "double-decker bus toys", gbp: 18 },
    { id: "steam_train", emoji: "🚂", art: "a", one: "steam-train ride", many: "steam-train rides", gbp: 18 },
    { id: "model_railway", emoji: "🛤️", art: "a", one: "model railway set", many: "model railway sets", gbp: 70 },
    { id: "heli_toy", emoji: "🚁", art: "a", one: "toy helicopter", many: "toy helicopters", gbp: 16 },
    { id: "aeroplane_toy", emoji: "✈️", art: "a", one: "toy aeroplane", many: "toy aeroplanes", gbp: 15 },
    { id: "fire_engine", emoji: "🚒", art: "a", one: "toy fire engine", many: "toy fire engines", gbp: 18 },
    { id: "ambulance_toy", emoji: "🚑", art: "a", one: "toy ambulance", many: "toy ambulances", gbp: 16 },
    { id: "police_car", emoji: "🚓", art: "a", one: "toy police car", many: "toy police cars", gbp: 16 },
    { id: "bin_lorry", emoji: "🚛", art: "a", one: "toy bin lorry", many: "toy bin lorries", gbp: 16 },
    { id: "digger", emoji: "🚜", art: "a", one: "toy digger", many: "toy diggers", gbp: 18 },
    { id: "bulldozer", emoji: "🚧", art: "a", one: "toy bulldozer", many: "toy bulldozers", gbp: 18 },
    { id: "cement_mixer", emoji: "🚚", art: "a", one: "toy cement mixer", many: "toy cement mixers", gbp: 16 },
    { id: "crane_toy", emoji: "🏗️", art: "a", one: "toy crane", many: "toy cranes", gbp: 20 },
    { id: "forklift_toy", emoji: "🏭", art: "a", one: "toy forklift", many: "toy forklifts", gbp: 15 },
    { id: "camper_van", emoji: "🚐", art: "a", one: "camper-van weekend", many: "camper-van weekends", gbp: 150 },
    { id: "caravan", emoji: "🏕️", art: "a", one: "caravan holiday", many: "caravan holidays", gbp: 200 },
    { id: "canoe", emoji: "🛶", art: "a", one: "canoe session", many: "canoe sessions", gbp: 20 },
    { id: "kayak", emoji: "🛶", art: "a", one: "kayak session", many: "kayak sessions", gbp: 22 },
    { id: "paddleboard", emoji: "🏄", art: "a", one: "paddleboard session", many: "paddleboard sessions", gbp: 20 },
    { id: "unicycle", emoji: "🚲", art: "a", one: "unicycle", many: "unicycles", gbp: 50 },
    { id: "trike", emoji: "🚲", art: "a", one: "trike", many: "trikes", gbp: 40 },
    { id: "balance_bike", emoji: "🚲", art: "a", one: "balance bike", many: "balance bikes", gbp: 45 },
    { id: "mountain_bike", emoji: "🚵", art: "a", one: "mountain bike", many: "mountain bikes", gbp: 250 },
    { id: "bmx", emoji: "🚲", art: "a", one: "BMX", many: "BMXs", gbp: 180 },
    { id: "ice_cream_van_toy", emoji: "🚚", art: "a", one: "toy ice-cream van", many: "toy ice-cream vans", gbp: 16 },
    { id: "hoverboard", emoji: "🛹", art: "a", one: "hoverboard", many: "hoverboards", gbp: 90 },
    { id: "segway_ride", emoji: "🛴", art: "a", one: "hover-scooter ride", many: "hover-scooter rides", gbp: 20 },
    { id: "cable_car", emoji: "🚠", art: "a", one: "cable-car ticket", many: "cable-car tickets", gbp: 14 },
    { id: "telescope", emoji: "🔭", art: "a", one: "telescope", many: "telescopes", gbp: 60 },
    { id: "planetarium", emoji: "🌌", art: "a", one: "planetarium ticket", many: "planetarium tickets", gbp: 14 },
    { id: "star_projector", emoji: "✨", art: "a", one: "star projector", many: "star projectors", gbp: 25 },
    { id: "astro_suit", emoji: "👨‍🚀", art: "an", one: "astronaut dress-up suit", many: "astronaut dress-up suits", gbp: 22 },
    { id: "moon_rock", emoji: "🌑", art: "a", one: "toy moon rock", many: "toy moon rocks", gbp: 8 },
    { id: "rocket_model", emoji: "🚀", art: "a", one: "rocket model", many: "rocket models", gbp: 18 },
    { id: "saturn_v", emoji: "🚀", art: "a", one: "Saturn V model", many: "Saturn V models", gbp: 25 },
    { id: "space_lego", emoji: "🧱", art: "a", one: "space-station building set", many: "space-station building sets", gbp: 40 },
    { id: "glow_stars", emoji: "⭐", art: "a", one: "pack of glow-in-the-dark stars", many: "packs of glow-in-the-dark stars", gbp: 8 },
    { id: "alien_plush", emoji: "👽", art: "an", one: "alien soft toy", many: "alien soft toys", gbp: 12 },
    { id: "ufo_toy", emoji: "🛸", art: "a", one: "UFO toy", many: "UFO toys", gbp: 15 },
    { id: "satellite_toy", emoji: "🛰️", art: "a", one: "satellite toy", many: "satellite toys", gbp: 14 },
    { id: "mars_rover", emoji: "🚐", art: "a", one: "Mars rover toy", many: "Mars rover toys", gbp: 20 },
    { id: "moon_boots", emoji: "👢", art: "a", one: "pair of moon boots (toy)", many: "pairs of moon boots (toy)", gbp: 16 },
    { id: "astro_ice", emoji: "🍦", art: "a", one: "pack of astronaut ice cream", many: "packs of astronaut ice cream", gbp: 6 },
    { id: "space_film", emoji: "🎬", art: "a", one: "space film at the IMAX", many: "space films at the IMAX", gbp: 14 },
    { id: "space_centre", emoji: "🎟️", art: "a", one: "National Space Centre ticket", many: "National Space Centre tickets", gbp: 18 },
    { id: "jodrell", emoji: "📡", art: "a", one: "Jodrell Bank ticket", many: "Jodrell Bank tickets", gbp: 12 },
    { id: "constellation", emoji: "🗺️", art: "a", one: "constellation map", many: "constellation maps", gbp: 8 },
    { id: "meteorite", emoji: "☄️", art: "a", one: "toy meteorite", many: "toy meteorites", gbp: 7 },
    { id: "space_badge", emoji: "📛", art: "a", one: "mission badge", many: "mission badges", gbp: 4 },
    { id: "moon_trip", emoji: "🌙", art: "a", one: "pretend trip to the moon", many: "pretend trips to the moon", gbp: 1000000 },
    { id: "star_book", emoji: "📖", art: "a", one: "book of stars", many: "books of stars", gbp: 10 },
    { id: "night_sky_app", emoji: "📱", art: "a", one: "night-sky stargazing kit", many: "night-sky stargazing kits", gbp: 15 },
    { id: "rocket_launch", emoji: "🚀", art: "a", one: "model-rocket launch kit", many: "model-rocket launch kits", gbp: 22 },
    { id: "space_hoodie", emoji: "🧥", art: "a", one: "space hoodie", many: "space hoodies", gbp: 25 },
    { id: "planet_mobile", emoji: "🪐", art: "a", one: "planets mobile", many: "planets mobiles", gbp: 12 },
    { id: "solar_system", emoji: "☀️", art: "a", one: "solar-system model", many: "solar-system models", gbp: 18 },
    { id: "comet_kit", emoji: "☄️", art: "a", one: "comet-making kit", many: "comet-making kits", gbp: 10 },
    { id: "astro_lunch", emoji: "🍱", art: "an", one: "astronaut packed lunch box", many: "astronaut packed lunch boxes", gbp: 12 },
    { id: "trex_model", emoji: "🦖", art: "a", one: "T. rex model", many: "T. rex models", gbp: 20 },
    { id: "triceratops", emoji: "🦕", art: "a", one: "triceratops model", many: "triceratops models", gbp: 18 },
    { id: "stegosaurus", emoji: "🦕", art: "a", one: "stegosaurus model", many: "stegosaurus models", gbp: 18 },
    { id: "diplodocus", emoji: "🦕", art: "a", one: "diplodocus model", many: "diplodocus models", gbp: 18 },
    { id: "velociraptor", emoji: "🦖", art: "a", one: "velociraptor model", many: "velociraptor models", gbp: 16 },
    { id: "pterodactyl", emoji: "🦅", art: "a", one: "pterodactyl model", many: "pterodactyl models", gbp: 16 },
    { id: "dino_egg", emoji: "🥚", art: "a", one: "dinosaur egg toy", many: "dinosaur egg toys", gbp: 8 },
    { id: "dino_dig", emoji: "⛏️", art: "a", one: "dinosaur dig kit", many: "dinosaur dig kits", gbp: 15 },
    { id: "dino_park", emoji: "🎟️", art: "a", one: "dinosaur-park ticket", many: "dinosaur-park tickets", gbp: 22 },
    { id: "fossil", emoji: "🦴", art: "a", one: "fossil", many: "fossils", gbp: 10 },
    { id: "ammonite", emoji: "🐚", art: "an", one: "ammonite", many: "ammonites", gbp: 8 },
    { id: "dino_hoodie", emoji: "🧥", art: "a", one: "dinosaur hoodie", many: "dinosaur hoodies", gbp: 25 },
    { id: "dino_duvet", emoji: "🛏️", art: "a", one: "dinosaur duvet set", many: "dinosaur duvet sets", gbp: 30 },
    { id: "dino_nuggets", emoji: "🍗", art: "a", one: "box of dinosaur nuggets", many: "boxes of dinosaur nuggets", gbp: 3.5 },
    { id: "nhm_trip", emoji: "🦕", art: "a", one: "trip to a dinosaur museum", many: "trips to a dinosaur museum", gbp: 25 },
    { id: "dino_book", emoji: "📖", art: "a", one: "dinosaur book", many: "dinosaur books", gbp: 10 },
    { id: "inflatable_rex", emoji: "🦖", art: "an", one: "inflatable T. rex suit", many: "inflatable T. rex suits", gbp: 35 },
    { id: "dino_stickers", emoji: "📔", art: "a", one: "dinosaur sticker book", many: "dinosaur sticker books", gbp: 6 },
    { id: "paleo_brush", emoji: "🪥", art: "a", one: "palaeontology brush set", many: "palaeontology brush sets", gbp: 12 },
    { id: "amber_toy", emoji: "🟡", art: "a", one: "toy amber fossil", many: "toy amber fossils", gbp: 7 },
    { id: "dino_bedtime", emoji: "🌙", art: "a", one: "dinosaur night light", many: "dinosaur night lights", gbp: 14 },
    { id: "dino_backpack", emoji: "🎒", art: "a", one: "dinosaur backpack", many: "dinosaur backpacks", gbp: 18 },
    { id: "dino_puzzle", emoji: "🧩", art: "a", one: "dinosaur puzzle", many: "dinosaur puzzles", gbp: 10 },
    { id: "dino_lego", emoji: "🧱", art: "a", one: "dinosaur building set", many: "dinosaur building sets", gbp: 30 },
    { id: "dino_figures", emoji: "🦖", art: "a", one: "tub of dinosaur figures", many: "tubs of dinosaur figures", gbp: 15 },
    { id: "dino_poster", emoji: "📄", art: "a", one: "dinosaur poster", many: "dinosaur posters", gbp: 6 },
    { id: "dino_timeline", emoji: "📏", art: "a", one: "dinosaur timeline chart", many: "dinosaur timeline charts", gbp: 8 },
    { id: "ankylosaurus", emoji: "🦕", art: "an", one: "ankylosaurus model", many: "ankylosaurus models", gbp: 16 },
    { id: "brachiosaurus", emoji: "🦕", art: "a", one: "brachiosaurus model", many: "brachiosaurus models", gbp: 18 },
    { id: "spinosaurus", emoji: "🦖", art: "a", one: "spinosaurus model", many: "spinosaurus models", gbp: 18 },
    { id: "dino_cake", emoji: "🎂", art: "a", one: "dinosaur cake", many: "dinosaur cakes", gbp: 25 },
    { id: "fossil_hunt", emoji: "🎟️", art: "a", one: "fossil-hunt day", many: "fossil-hunt days", gbp: 18 }
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
    if (!S.kid) return '';
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
  function loadRewards(force) {
    if (RW && !force) return Promise.resolve(RW);
    return call('getRewards', S.kid ? KID_ROLE : S.role).then(function (r) { RW = r; return r; });
  }
  function niceWhen(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
    catch (e) { return String(iso).slice(0, 16); }
  }
  function rwAction(a) {
    return ({ photo: 'Photo', found: 'Ticked off a find', update: 'Updated something', add: 'New item', streak: '3-day streak bonus' })[a] || a;
  }
  function paintRewardsHome(r) {
    var box = $('rwHomeTile'); if (!box || !r) return;
    var bits = [];
    if (r.queue && r.queue.length) bits.push(r.queue.length + ' photo' + (r.queue.length === 1 ? '' : 's') + ' waiting');
    if (r.pendingRequests && r.pendingRequests.length) bits.push(r.pendingRequests.length + ' reward' + (r.pendingRequests.length === 1 ? '' : 's') + ' to decide');
    box.innerHTML = '<div class="head">\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</div>' +
      '<div class="big">' + r.earned + '</div><div class="hint">points earned' + (bits.length ? ' \u00B7 ' + bits.join(' \u00B7 ') : '') + '</div>' +
      '<button class="btn main" data-act="go" data-to="rewards">' + (bits.length ? 'Review' : 'Open') + '</button>';
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
      var rewards = (r.rewards || []).map(function (x) {
        var pending = (r.requests || []).some(function (q) { return q.title === x.title && q.status === 'Pending'; });
        var need = x.cost - (r.balance || 0);
        var btn = pending ? '<span class="pill yel">Asked \u2014 waiting for Dad</span>' :
          (need > 0 ? '<span class="hint">' + need + ' more points to go</span>' :
            '<button class="btn main" data-act="rwAsk" data-id="' + esc(x.id) + '">Ask Dad</button>');
        return '<div class="rwItem"><div class="row"><b>' + esc(x.title) + '</b><span class="pill">' + x.cost + ' pts</span></div>' + btn + '</div>';
      }).join('');
      var reqs = (r.requests || []).length ? '<h2>Your asks</h2><div class="rwList">' + r.requests.map(function (q) {
        return '<div class="rwItem"><b>' + esc(q.title) + '</b><small>' + esc(q.status) + (q.when ? ' \u00B7 ' + esc(niceWhen(q.when)) : '') + '</small></div>';
      }).join('') + '</div>' : '';
      var recent = (r.recent || []).length ? '<h2>Lately</h2><div class="list rwLog">' + r.recent.slice(0, 12).map(function (x) {
        return '<div class="li"><div class="grow">' + esc(rwAction(x.action)) + (x.item ? '<small>' + esc(x.item) + '</small>' : '') + '</div><span class="pill">' + (x.points > 0 ? '+' : '') + x.points + '</span></div>';
      }).join('') + '</div>' : '';
      setMain(backBtn() + '<h1>\u2B50 My points</h1>' + rwLevelCard(r) +
        (function () {
        var p = (r && r.points) || {};
        var photo = p.photo != null ? p.photo : 10, tick = p.found != null ? p.found : 5, neu = p.add != null ? p.add : 20;
        return (r.waiting ? '<div class="nudge">Dad is having a look at ' + r.waiting + ' photo' + (r.waiting === 1 ? '' : 's') + '. You get ' + photo + ' points for each one he says yes to.</div>' : '') +
        '<h2>Rewards you can ask for</h2><p class="hint">Photos (when Dad says yes) are ' + photo + ' points, ticks are ' + tick + ', and a brand new item is ' + neu + '. Help 3 days in a row for a bonus.</p><div class="rwList">';
      })() +
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
      var all = (r.allRewards || []).map(function (x) {
        return '<div class="rwItem" data-id="' + esc(x.id) + '"><p class="rwEditHead">Edit this reward</p>' +
          '<label class="field">Reward name <input type="text" class="rwTitle" data-id="' + esc(x.id) + '" value="' + esc(x.title) + '" maxlength="60" autocomplete="off"></label>' +
          '<label class="field">Points needed <input type="number" class="rwCost" data-id="' + esc(x.id) + '" value="' + x.cost + '" min="5" step="5"></label>' +
          '<label class="rwOnRow"><input type="checkbox" class="rwOn" data-id="' + esc(x.id) + '"' + (x.active ? ' checked' : '') + '> On the list</label></div>';
      }).join('');
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
        '<h2>Rewards he can ask for</h2><p class="hint">You can edit the name, the points, or tick \u201COn the list\u201D. Add as many as you like, then tap Save. Switch one off rather than deleting it. No money in the names, please.</p><div class="rwList" id="rwEdit">' + all + '</div>' +
        '<p><button type="button" class="rwAdd" data-act="rwAdd">+ Add reward</button></p>' +
        '<h2>Points he earns</h2><p class="hint">Change how many points a photo, a tick, or a new item is worth.</p>' +
        '<div class="card" id="rwRules">' +
          '<label class="field">Points for a photo (when you say yes) <input type="number" id="rwPtsPhoto" min="0" step="1" value="' + (pts.photo != null ? pts.photo : 10) + '"></label>' +
          '<label class="field">Points for a tick / found it <input type="number" id="rwPtsTick" min="0" step="1" value="' + (pts.found != null ? pts.found : 5) + '"></label>' +
          '<label class="field">Points for an update <input type="number" id="rwPtsUpdate" min="0" step="1" value="' + (pts.update != null ? pts.update : 5) + '"></label>' +
          '<label class="field">Points for a brand new item <input type="number" id="rwPtsAdd" min="0" step="1" value="' + (pts.add != null ? pts.add : 20) + '"></label>' +
          '<label class="field">Bonus for helping 3 days in a row <input type="number" id="rwPtsStreak" min="0" step="1" value="' + (pts.streak != null ? pts.streak : 15) + '"></label>' +
        '</div>' +
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
  function collectRewardsForm() {
    var list = [], bad = '';
    document.querySelectorAll('#rwEdit .rwItem').forEach(function (el) {
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
    var pts = {
      photo: parseInt(($('rwPtsPhoto') && $('rwPtsPhoto').value) || '10', 10),
      found: parseInt(($('rwPtsTick') && $('rwPtsTick').value) || '5', 10),
      update: parseInt(($('rwPtsUpdate') && $('rwPtsUpdate').value) || '5', 10),
      add: parseInt(($('rwPtsAdd') && $('rwPtsAdd').value) || '20', 10),
      streak: parseInt(($('rwPtsStreak') && $('rwPtsStreak').value) || '15', 10)
    };
    return { list: list, pts: pts, bad: bad };
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
    withDadPinThen(function () {
      busy('Saving\u2026');
      var p1 = call('saveRewards', form.list, S.role);
      var p2 = call('savePointRules', form.pts, S.role).catch(function (e) {
        var msg = String((e && e.message) || e || '');
        if (/unknown action/i.test(msg)) return { skipped: true };
        throw e;
      });
      return Promise.all([p1, p2]).then(function (res) {
        done();
        RW = null;
        var saved = res[0] && res[0].rewards;
        if (saved && $('rwEdit')) {
          var titles = $('rwEdit').querySelectorAll('.rwTitle');
          saved.forEach(function (r, i) { if (titles[i]) titles[i].setAttribute('data-id', r.id); });
        }
        markRewardsSaved();
        if (res[1] && res[1].skipped) toast('Rewards saved. Points rules need the server update before they will stick.', 'good');
        loadRewards(true);
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
    var A = addState(), hits = itemsByBarcode(digits).filter(function (it) { return isOwned(it) && !neverShow(it.name) && (!S.kid || kidSafe(it)); });
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
      '<button class="btn full" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode - big buttons, no prices</button>' +
      '</div></div>');
  };

  SCREENS.home = function () {
    loadBoot().then(function (b) {
      var t = b.tiles, h = '';
      h += '<h1>' + (S.role === PRIV ? 'Alright, ' : 'Hiya, ') + esc(S.role) + '! \uD83D\uDC4B</h1>';
      h += '<div class="card ownCard"><label class="ownLabel" for="homeSearch">\uD83E\uDD14 Do I own it?</label>' +
        '<div class="ownRow"><input id="homeSearch" class="ownInput" type="search" placeholder="Type a name\u2026" aria-label="Do I own it? Type a name" enterkeyhint="search" autocomplete="off">' +
        '<button class="btn main scanBtn" data-act="scan" aria-label="Scan a barcode">\uD83D\uDCF7<small>Scan</small></button></div>' +
        '<div id="ownOut"></div></div>';
      var ownedN = S.items.filter(function (it) { return isOwned(it) && !it.pending; }).length;
      if (isPriv()) h += '<div id="valueBox">' + valueCardHtml(localValueSummary()) + '</div>';
      else h += '<div class="card skyL valueCard"><div class="head">\uD83E\uDDF8 Our collection</div><div class="big">' + ownedN + '</div><div class="hint">items owned</div></div>';
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
      if (isPriv()) h += '<div class="card pinkL tile" id="rwHomeTile"><div class="head">\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</div><div class="hint">Points, photo approvals and rewards.</div><button class="btn main" data-act="go" data-to="rewards">Open</button></div>';
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
      h += '<div class="card tile"><div class="head">\u2B50 Wanted</div><div class="big">' + t.wanted.count + '</div><div class="hint">things on the hunt list</div><div id="dealLine"></div><button class="btn main" data-act="go" data-to="wanted">See the wanted list</button></div>';
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
      h += '<button class="btn pink full" style="margin-top:12px" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode (big buttons, no prices)</button>';
      h += '<div class="row" style="margin-top:6px"><button class="btn small" data-act="refresh">\u21BB Refresh</button><button class="btn small" data-act="go" data-to="stats">\uD83D\uDCCA Stats</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button><button class="btn small" data-act="go" data-to="help">\u2753 Help</button></div>';
      setMain(h);
      if (LS.get('tourPending')) { LS.set('tourPending', ''); setTimeout(startTour, 350); }
      var hs = $('homeSearch');
      hs.addEventListener('keydown', function (e) { if (e.key === 'Enter') { hs.blur(); } });
      bindOwnSearch('homeSearch', 'ownOut');
      refreshDealBadges();
      loadHomeWanted();
      if (isPriv()) {
        call('getValueSummary', S.role).then(function (vs) {
          if (vs && typeof vs.total === 'number' && $('valueBox') && S.screen === 'home') $('valueBox').innerHTML = valueCardHtml(vs);
        }).catch(noop);
        loadRewards().then(paintRewardsHome).catch(noop);
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
      var h = backBtn() + '<h1>' + esc(it.name) + '</h1>' +
        '<div id="hero" class="hero" data-act="heroOpen">' + (it.folderId ? '\u23F3' : '<span style="font-size:44px">\uD83D\uDCF7</span>') + '</div>' +
        '<div id="nudge"></div>' +
        '<div class="stack" style="margin:12px 0"><button class="btn main full" data-act="snapCurrent">\uD83D\uDCF7 Take photo</button>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="pickCurrent">\uD83D\uDDBC\uFE0F From gallery</button><button class="btn" style="flex:1" data-act="videoCurrent">\uD83C\uDFA5 Record video</button></div>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="replaceMain">\uD83D\uDD04 New main photo</button><button class="btn" style="flex:1" data-act="scanAssign">\uD83C\uDFF7\uFE0F ' + ((it.barcode || itemBarcode(itemByKey(it.key))) ? 'Change barcode' : 'Save barcode') + '</button></div>' +
        (it.offlineCopy ? '<div class="nudge">\uD83D\uDCF4 Offline copy - the full details and photos load when you\u2019re back online.</div>' : '') +
        '<div class="row"><button class="btn yel" style="flex:1" data-act="edit">\u270F\uFE0F Edit details</button>' +
        (it.folderId ? '<a class="btn" style="flex:1" href="https://drive.google.com/drive/folders/' + esc(it.folderId) + '" target="_blank" rel="noopener">\uD83D\uDCC1 Folder \u2197</a>' : '') + '</div>' +
        (shareable(it) || isPriv() ? '<div class="row">' + (shareable(it) ? '<button class="btn pink" style="flex:1" data-act="shareFind">\uD83D\uDCE4 Share this find</button>' : '') + (isPriv() ? '<button class="btn" style="flex:1" data-act="priceCheck">\uD83D\uDD0E Price check</button>' : '') + '</div><div id="priceSlot"></div>' : '') +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full" data-act="gotItem">\u2705 Got it!</button>' : '') + '</div>' +
        '<h2>Photos</h2><div id="gallery" class="gallery"><div class="hint">' + (it.folderId ? 'Loading photos\u2026' : 'No photos yet.') + '</div></div>' +
        (plats ? '<div class="card skyL"><h3>\uD83D\uDCE3 Posted on</h3><div class="chips">' + plats + '</div><p class="hint">Tap one to tick it off when it\u2019s been posted.</p></div>' : '') +
        '<div class="card"><dl class="facts">' + facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl></div>';
      setMain(h);
      if (!it.folderId) { $('nudge').innerHTML = '<div class="nudge">\uD83D\uDCF7 No photos yet - tap \u201CAdd photo / video\u201D and I\u2019ll make its folder too.</div>'; return; }
      call('getItemPhotos', it.folderId).then(function (ph) {
        if (!$('hero') || !$('gallery')) return;   // moved on to another screen already
        S.gallery = ph;
        if (!ph.length) { $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">No photos yet.</div>'; $('nudge').innerHTML = '<div class="nudge">\uD83D\uDCF7 Missing photo! Snap the front first - no faces in shot.</div>'; return; }
        var first = ph[0];
        $('hero').innerHTML = first.thumb ? '<img alt="' + esc(first.name) + '" src="' + first.thumb + '"><span class="zoom">\uD83D\uDD0D Tap to zoom</span>' : '<span style="font-size:44px">' + (first.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>';
        $('gallery').innerHTML = ph.map(function (x, i) {
          return '<button class="gthumb' + (x.main ? ' main' : '') + '" data-act="openPhoto" data-i="' + i + '" aria-label="' + esc(x.name) + '">' + (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span>' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') + (x.main ? '<b>Main</b>' : '') + (x.video ? '<i>\u25B6</i>' : '') + '</button>';
        }).join('') + '<p class="hint" style="grid-column:1/-1">' + ph.length + ' photo' + (ph.length === 1 ? '' : 's') + ' \u00B7 tap one to see it big or make it the main photo</p>';
        if (!ph.some(function (x) { return /- back\b/i.test(x.name); }) && !ph.some(function (x) { return x.video; })) $('nudge').innerHTML = '<div class="nudge">Tip: a photo of the back or box side helps with values later.</div>';
      }).catch(function () { if (!$('hero') || !$('gallery')) return; $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">Couldn\u2019t load the photos - tap Refresh in \u201CI\u2019m stuck\u201D.</div>'; });
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
    var wasOpen = !lb.hidden;
    lb.hidden = false;
    layerOpen(wasOpen);
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
  function wantedDivider(n) {
    var bits = [];
    for (var i = 0; i < WANT_EGGS.length; i++) bits.push(WANT_EGGS[(i + n) % WANT_EGGS.length]);
    return '<div class="wantDiv" aria-hidden="true">' + bits.join(' ') + '</div>';
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
      if (gi) h += wantedDivider(gi);
      h += '<button type="button" class="wantHead" data-act="wantToggle" data-gid="' + esc(g.id) + '" aria-expanded="' + (closed ? 'false' : 'true') + '">' +
        '<span class="wantChev">' + (closed ? '\u25B8' : '\u25BE') + '</span> ' +
        esc(g.title) + ' <span class="wantN">(' + g.items.length + ')</span></button>';
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
    return [w && w.name, w && w.range, w && w.series].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  function ebayWantedUrl(w) {
    return 'https://www.ebay.co.uk/sch/i.html?_nkw=' + encodeURIComponent(wantedSearchQuery(w));
  }
  var REF_PIC_MEM = {};
  function refPicQuery(w) {
    var n = String((w && w.name) || '');
    n = n.replace(/\((?:sealed|carded|loose)[^)]*\)/ig, '');
    n = n.replace(/\b(?:funko|pop!|pop|figure|figurine|exclusive)\b/ig, '');
    n = n.replace(/\s+/g, ' ').trim();
    if (n && !/simpsons/i.test(n)) n += ' The Simpsons';
    return n;
  }
  function rememberRefPic(key, url) {
    REF_PIC_MEM[key] = url || '';
    try {
      var o = JSON.parse(LS.get('wantRefPic') || '{}');
      o[key] = url || '';
      var keys = Object.keys(o);
      if (keys.length > 80) keys.slice(0, keys.length - 80).forEach(function (k) { delete o[k]; });
      LS.set('wantRefPic', JSON.stringify(o));
    } catch (e) {}
    return url || '';
  }
  function wikiApiPics(api, q) {
    var url = api + '?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail&pithumbsize=400&generator=search&gsrlimit=5&gsrsearch=' + encodeURIComponent(q);
    return fetch(url).then(function (r) { return r.ok ? r.json() : {}; }).then(function (data) {
      var pages = (data && data.query && data.query.pages) || {}, best = '';
      Object.keys(pages).forEach(function (id) {
        var t = pages[id] && pages[id].thumbnail && pages[id].thumbnail.source;
        if (t && /^https:\/\//.test(t) && !best) best = t;
      });
      return best;
    }).catch(function () { return ''; });
  }
  function findRefPic(w) {
    var key = wantedSearchQuery(w);
    if (REF_PIC_MEM[key] !== undefined) return Promise.resolve(REF_PIC_MEM[key]);
    try {
      var cached = JSON.parse(LS.get('wantRefPic') || '{}');
      if (typeof cached[key] === 'string') { REF_PIC_MEM[key] = cached[key]; return Promise.resolve(cached[key]); }
    } catch (e) {}
    var q = refPicQuery(w);
    return wikiApiPics('https://en.wikipedia.org/w/api.php', q).then(function (url) {
      if (url) return rememberRefPic(key, url);
      return wikiApiPics('https://simpsons.fandom.com/api.php', q).then(function (url2) { return rememberRefPic(key, url2 || ''); });
    }).catch(function () { return rememberRefPic(key, ''); });
  }
  function wantedInfoSheet(i, list) {
    var w = (list || [])[i]; if (!w) return;
    var ebay = ebayWantedUrl(w);
    sheet(w.name, '<div class="wantInfo">' +
      '<div class="wantRef" id="wantRef"><div class="wantRefPh">Looking for a reference picture\u2026</div></div>' +
      '<p class="wantRefLab">Reference picture</p>' +
      '<p class="hint">This is just to help us recognise it \u2014 it is not one of our photos, and we never save it as one.</p>' +
      '<a class="btn full main" href="' + esc(ebay) + '" target="_blank" rel="noopener">Search on eBay UK \u2197</a>' +
      '</div>',
      [{ label: 'Close', value: false }]);
    findRefPic(w).then(function (url) {
      var box = $('wantRef'); if (!box) return;
      if (url) box.innerHTML = '<img alt="" src="' + esc(url) + '" referrerpolicy="no-referrer">';
      else box.innerHTML = '<div class="wantRefPh">No reference picture just now \u2014 you can still hunt by name on eBay.</div>';
    });
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
      ['history', '\uD83D\uDDD3\uFE0F', 'Item history', 'When each thing joined, and where from'],
      ['missing', '\uD83E\uDDE9', 'Missing list', 'Everything still needed for the full sets'],
      ['checklists', '\u2705', 'Checklists', 'How close each full set is'],
      ['photos', '\uD83D\uDCF8', 'Photos to take', 'Items still needing our own photos']
    ];
    if (isPriv()) {
      tiles.push(['rewards', '\u2B50', KID_ROLE + '\u2019s rewards', 'Points, photo approvals, activity log']);
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
    ['\uD83D\uDCF8 Photos', ['Open any item and tap <b>Add photo / video</b>. It saves straight into that item\u2019s own Drive folder.', 'Tap <b>New main photo</b> to replace the picture that shows in the lists. The old one stays in the folder - nothing is deleted.', 'Tap any photo to see it big, then <b>Make main photo</b> to pick a different main one.', 'No faces in shot, please. Hands are fine.']],
    ['\uD83E\uDD14 Do I own it? + barcode scan', ['Type any name in <b>Do I own it?</b> on Home - it tells you yes, maybe or no as you type, even with spelling mistakes.', 'Tap <b>\uD83D\uDCF7 Scan</b> and point the camera at a box\u2019s barcode. If the barcode is saved on an item it matches straight away.', 'First time for a barcode? Search the name and tap the item to save the barcode on it. Or open any item and tap <b>Save barcode</b>.']],
    ['\uD83D\uDCF4 No signal', ['The last collection you opened is kept on the phone, with photos you\u2019ve already seen.', 'Adds, edits, ticks and photos made with no signal are kept on the phone and sync on their own when you\u2019re back online.']],
    ['\uD83E\uDDD2 ' + KID_ROLE + '\u2019s mode', ['Big buttons and photos, no prices. Tick off finds on the hunt list and add photos.', 'A <b>letter from Dad</b> opens the first time each day, and you can read it again any time from the Home tile.', 'The <b>\u2B50 My points</b> page awards points for photos (once Dad says yes), ticks and new finds, with levels and real rewards Dad sets. Secret or hidden things never earn points, and there is never any money.', 'The <b>\uD83C\uDFC6 Badges</b> wall unlocks badges from the collection (10 Funkos, first rare find, finds this month, photos added\u2026) with confetti for each new one. No money badges, and secret or Christmas things never count.', 'Getting back to the full app needs ' + esc(THEME.privateRole) + '\u2019s PIN.']],
    ['\uD83D\uDD0D Finding things', ['Use the search box on Home or in Collection. It searches names, characters, lines and IDs.', 'Tap <b>Filters</b> to narrow down by category, line, condition, status, posted or photos.', 'Use the sort menu for newest first, A to Z or by year.']],
    ['\u2B50 Wanted and missing', ['<b>Wanted</b> is your hunt list. Tap <b>Got it</b> when one arrives and it moves into the collection.', '<b>Missing list</b> (under More) shows everything still needed from every full-set checklist in one place.', '<b>Checklists</b> shows how close each set is.']],
    ['\uD83D\uDCE3 Posted on socials', ['Each item page has the platforms as buttons. Tap one to tick it once it\u2019s posted.', 'Under More \u2192 <b>Posted on socials</b> you can see what hasn\u2019t been posted yet - handy for planning.']],
    ['\uD83D\uDD01 Spares & duplicates', ['Under More \u2192 <b>Spares & duplicates</b> you\u2019ll see anything you own more than once (same name, or a quantity over 1), plus names that nearly match.', 'Tap <b>Mark for sale</b> on the copy you want to sell or swap. It stays in the sheet, just with the status For sale.', 'Values only show for ' + esc(THEME.privateRole) + '.']],
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

  /* ---------------- Item history (timeline) ---------------- */
  SCREENS.history = function () {
    busy('Building the timeline\u2026');
    Promise.all([loadBoot(), loadHistory()]).then(function (r) {
      done();
      var hist = r[1], priv = isPriv();
      if (!hist) { setMain(backBtn() + '<h1>\uD83D\uDDD3\uFE0F Item history</h1><div class="nudge">This needs the latest Apps Script (v4.3). Ask ' + esc(PRIV) + ' to paste it in - then this page fills itself from the sheet.</div>'); return; }
      var items = (S.items || []).filter(function (it) { return !neverShow(it.name) && (priv || !sonHidden(it.name)); });
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
  function computeBadges(hist) {
    var items = kidItems(), B = [];
    var add = function (id, icon, name, desc, have, need) { B.push({ id: id, icon: icon, name: name, desc: desc, have: Math.min(have, need), need: need, got: have >= need }); };
    var ladder = function (idp, icon, label, desc, have, tiers) {
      tiers.forEach(function (t, i) { var tn = Array.isArray(t) ? t : [t, label + ' ' + (i + 1)]; add(idp + tn[0], icon, tn[1], desc.replace('{n}', tn[0]), have, tn[0]); });
    };
    ladder('size:', '\uD83C\uDFC6', 'Collector', 'Have {n} things in our collection', items.length, [[10, 'Collector Level 1'], [25, 'Collector Level 2'], [50, 'Collector Level 3'], [100, 'Collector Level 4'], [200, 'Collector Level 5'], [300, 'Super Collector'], [400, 'Mega Collector'], [500, 'Ultimate Collector']]);
    var byCat = {}; items.forEach(function (it) { var r = it.range || 'Other'; if (!/^(unknown|other)$/i.test(r)) byCat[r] = (byCat[r] || 0) + 1; });
    Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).forEach(function (r) {
      CAT_TIERS.forEach(function (t) { if (t[0] <= Math.max(10, byCat[r] * 2)) add('cat:' + r + ':' + t[0], catIcon(r), r + ' ' + t[1], 'Have ' + t[0] + ' ' + r + ' things', byCat[r], t[0]); });
    });
    var nCats = Object.keys(byCat).length;
    ladder('explore:', '\uD83E\uDDED', 'Explorer', 'Collect from {n} different kinds of thing', nCats, [[5, 'Explorer'], [10, 'Adventurer'], [15, 'World Traveller']]);
    CHARS.forEach(function (c) {
      var re = new RegExp('\\b' + c[0] + '\\b', 'i'), n = items.filter(function (it) { return re.test(it.character || '') || re.test(it.name || ''); }).length;
      if (n) [5, 10, 25].forEach(function (t, i) { add('char:' + c[0] + ':' + t, c[2], c[1] + (i ? ' ' + ['', 'II', 'III'][i] : ''), 'Have ' + t + ' ' + c[0] + ' things', n, t); });
    });
    var rares = items.filter(function (it) { return RARE_RE.test([it.name, it.series].join(' ')); }).length;
    add('rare:1', '\uD83D\uDC8E', 'First Rare Find!', 'Get a limited, exclusive, chase or glow-in-the-dark one', rares, 1);
    add('rare:5', '\uD83D\uDC8E', 'Rare Hunter', 'Have 5 rare ones', rares, 5);
    add('rare:10', '\uD83D\uDC51', 'Treasure Keeper', 'Have 10 rare ones', rares, 10);
    var years = items.map(function (it) { var m = String(it.year || '').match(/\b(19|20)\d{2}\b/); return m ? +m[0] : 0; }).filter(Boolean);
    var oldest = years.length ? Math.min.apply(null, years) : 9999;
    add('old:1995', '\uD83D\uDCFC', 'Retro Rocker', 'Have something from 1995 or older', oldest <= 1995 ? 1 : 0, 1);
    add('old:1990', '\u23F3', 'Time Traveller', 'Have something from 1990 or older', oldest <= 1990 ? 1 : 0, 1);
    var photos = items.filter(function (it) { return it.folderId; }).length;
    ladder('photo:', '\uD83D\uDCF8', 'Photo', 'Have photos for {n} things', photos, [[25, 'Photo Fan'], [100, 'Photo Pro'], [250, 'Photo Superstar']]);
    ladder('snap:', '\uD83E\uDD33', 'Snap', 'Add {n} photos in ' + KID_ROLE + '\u2019s mode', kidCount('kidPhotos'), [[1, 'Snap Happy'], [5, 'Camera Kid'], [20, 'Ace Photographer']]);
    ladder('found:', '\uD83D\uDD75\uFE0F', 'Hunter', 'Tick off {n} finds from the hunt list', kidCount('kidFound'), [[1, 'Found One!'], [5, 'Super Sleuth'], [10, 'Master Hunter']]);
    var posted = items.filter(function (it) { return it.posted; }).length;
    ladder('posted:', '\uD83D\uDCE3', 'Social', 'Have {n} things posted online', posted, [[10, 'Social Star'], [50, 'Influencer'], [100, 'Famous!']]);
    if (hist) {
      var now = new Date(), y = now.getFullYear(), mo = now.getMonth(), mon = 0, yr = 0;
      items.forEach(function (it) { var h = hist[it.key]; if (!h) return; var d = parseLoose(h.dg) || parseLoose(h.ph); if (!d) return; if (d.y === y) { yr++; if (d.m === mo && d.p !== 'y') mon++; } });
      ladder('month:' + y + '-' + mo + ':', '\uD83D\uDD25', 'Month', 'Get {n} new things this month', mon, [[1, 'Fresh Find'], [5, 'Hot Streak'], [10, 'On Fire!']]);
      ladder('year:' + y + ':', '\uD83D\uDCC5', 'Year', 'Get {n} new things this year', yr, [[25, y + ' Collector'], [100, y + ' Champion']]);
    }
    return B;
  }
  function badgesSeen() { try { return JSON.parse(LS.get('kidBadgesSeen') || 'null'); } catch (e) { return null; } }
  function checkNewBadges() {
    return loadHistory().catch(function () { return null; }).then(function (hist) {
      var B = computeBadges(hist), got = B.filter(function (b) { return b.got; }), seen = badgesSeen(), first = !seen;
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
  SCREENS.kidBadges = function () {
    busy('Polishing your badges\u2026');
    loadBoot().then(checkNewBadges).then(function (B) {
      done();
      var got = B.filter(function (b) { return b.got; });
      var grp = function (b) { return b.id.replace(/:[^:]*$/, ''); }, rank = {}, cnt = {};
      got.slice().reverse().forEach(function (b) { var g = grp(b); cnt[g] = (cnt[g] || 0); rank[b.id] = cnt[g]++; });   // best badge of each kind first
      got = got.map(function (b, i) { return { b: b, i: i }; }).sort(function (x, y) { return rank[x.b.id] - rank[y.b.id] || x.i - y.i; }).map(function (x) { return x.b; });
      var next = B.filter(function (b) { return !b.got; }).sort(function (a, b) { return (b.have / b.need) - (a.have / a.need); });
      var tile = function (b) {
        return '<div class="badge' + (b.got ? ' got' : '') + '" title="' + esc(b.desc) + '"><span class="bIc">' + b.icon + '</span><b>' + esc(b.name) + '</b><small>' + esc(b.desc) + '</small>' +
          (b.got ? '<em>\u2705 Got it!</em>' : '<span class="bBar"><i style="width:' + Math.round(100 * b.have / b.need) + '%"></i></span><em>' + b.have + ' / ' + b.need + '</em>') + '</div>';
      };
      setMain('<h1>\uD83C\uDFC6 My badges</h1><div class="card yel center"><b style="font-size:26px">' + got.length + '</b> badge' + (got.length === 1 ? '' : 's') + ' so far! <br><small>Collect more stuff, add photos and tick off the hunt list to get more.</small></div>' +
        '<h2>\u2B50 Got them</h2><div class="badgeWall">' + (got.length ? got.map(tile).join('') : '<p class="hint">None yet - add something!</p>') + '</div>' +
        '<h2>\uD83D\uDD12 Up next</h2><div class="badgeWall">' + next.slice(0, 24).map(tile).join('') + '</div>');
    }).catch(oops);
  };
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
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (tab) { if (tab.getAttribute('data-tab') === 'scan') { openScanner({}); return; } S.history = []; var to = tab.getAttribute('data-tab'); if (to === 'add') layerPush(); go(to, {}, true); return; }
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.getAttribute('data-act'), key = el.getAttribute('data-key');
    switch (a) {
      case 'back': layerBack(); break;
      case 'go': if (el.getAttribute('data-to') === 'guide') { go('guide', { i: 0 }); break; } go(el.getAttribute('data-to'), { tab: el.getAttribute('data-tab') }); break;
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
      case 'pinCancel': S.pendingRole = ''; S.pinDigits = ''; S.pinError = ''; if (S.kidExit) { S.kidExit = false; go('kid', {}, true); break; } go('who', {}, true); break;
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
      case 'scan': openScanner({}); break;
      case 'scanAssign': openScanner({ assign: { key: S.current.key, name: S.current.name } }); break;
      case 'scanClose': if (NAV.pushed > 0) layerBack(); else stopScanner(); break;
      case 'scanType': typeCode(); break;
      case 'scanPhoto': $('scanInput').value = ''; $('scanInput').click(); break;
      case 'bcAssign':
        var bi = itemByKey(key); if (!bi) break; $('sheet').hidden = true;
        saveBarcodeTo(bi.key, bi.name, S.lastCode); break;
      case 'bcAddNew':
        $('sheet').hidden = true; S.add = { step: 1, shots: [], name: '', range: '', condition: '', more: {}, barcode: S.lastCode }; go('add'); break;
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
      case 'rwAsk': askReward(el.getAttribute('data-id')); break;
      case 'rwYes': decideRewardUI(el.getAttribute('data-id'), true); break;
      case 'rwNo': decideRewardUI(el.getAttribute('data-id'), false); break;
      case 'rwPhotoYes': decidePhotoUI(el.getAttribute('data-id'), true, !!(el.closest('.rwItem') && el.closest('.rwItem').querySelector('.qMain') && el.closest('.rwItem').querySelector('.qMain').checked)); break;
      case 'rwPhotoNo': decidePhotoUI(el.getAttribute('data-id'), false, false); break;
      case 'rwSave': saveRewardsUI(); break;
      case 'rwAdd': addRewardRow(); break;
      case 'addScan': keepAddName(); openScanner({ add: true }); break;
      case 'addTypeBc': keepAddName(); SCAN.opts = { add: true }; typeCode(); break;
      case 'addClearBc': var A0 = addState(); A0.barcode = ''; A0.bcLook = undefined; A0.bcRef = ''; go('add', {}, true); break;
      case 'kidEnter': enterKid(); break;
      case 'kidExit': exitKid(); break;
      case 'kidItem': $('sheet').hidden = true; go('kidItem', { key: key }); break;
      case 'kidMore': S.kidShown = (S.kidShown || 40) + 40; if (S.redrawKid) S.redrawKid(); break;
      case 'kidSnap': if (S.current) openCamera({ key: S.current.key, name: S.current.name }); break;
      case 'kidGot': kidGot(+el.getAttribute('data-i')); break;
      case 'kidNew': S.add = null; go('add'); break;
      case 'kidGotItem':
        confirmSheet('We got it? \uD83C\uDF89', 'Mark <b>' + esc(S.current.name) + '</b> as ours?', 'Yes!', 'Not yet').then(function (ok) {
          if (!ok) return; busy('Saving\u2026');
          return call('markGotIt', 'item', S.current.key, S.current.name, KID_ROLE).then(function (r) { done(); bumpKid('kidFound'); S.current.status = 'Owned'; S.boot = null; pointsNote(r, '\uD83C\uDF89 It\u2019s ours!'); go('kidItem', S.params, true); });
        }).catch(oops); break;
    }
  });
  $('stuckBtn').addEventListener('click', function () {
    if (!S.kid) return showHelp();
    sheet('How it works', '<ul><li>\uD83E\uDDF8 <b>Our stuff</b>: tap anything to see it big or add a photo.</li><li>\u2B50 <b>Hunt</b>: things we\u2019re looking for. Found one? Tap \u201CFound it!\u201D</li><li>\uD83D\uDCF7 <b>Scan</b>: point at a box\u2019s barcode to see if we\u2019ve got it.</li><li>\u2709\uFE0F <b>Letter from Dad</b>: how it all started. It pops up every now and then, and you can open it again any time.</li><li>\uD83D\uDCDD <b>Notes from Dad</b>: a little note every few visits, and all of them under Notes from Dad.</li><li>\uD83D\uDE04 <b>A daft joke</b>: a new one when you open this mode. Tap it for another.</li><li>\uD83C\uDF66 <b>What\u2019s our collection worth?</b>: swipe or tap to try ice creams, Dons tickets, tractors and lots more.</li><li>\u2B50 <b>My points</b>: earn points and ask Dad for rewards.</li><li>No faces in photos - hands are fine.</li></ul>',
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
