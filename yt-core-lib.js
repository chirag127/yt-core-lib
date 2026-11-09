// ==UserScript==
// @name         yt-core-lib
// @namespace    https://github.com/chirag127
// @version      1.2.0
// @description  Shared core for the YouTube userscripts: synced storage, one AI key, InnerTube reads/writes, SAPISIDHASH auth, and small UI helpers. Not a standalone script — @require it.
// @author       chirag127
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      *
// ==/UserScript==

/*
 * This file is NEVER installed on its own. Consuming scripts do:
 *
 *   // @require  https://raw.githubusercontent.com/chirag127/yt-core-lib/main/yt-core-lib.js
 *
 * and then use the global `Ytk`. Everything here is shared state: one AI key, one
 * settings object, one storage namespace (`ytk.`), so a user configures AI once and
 * every script picks it up. ScriptCat's cloud sync replicates GM storage, so it
 * follows the user across browsers with no extra work.
 */

/*LIB_ONLY*/ var Ytk = (function () {
  'use strict';

  var NS = 'ytk';
  var VERSION = '1.2.0';

  var DEFAULTS = {
    aiBaseUrl: 'https://api.openai.com/v1',
    aiKey: '',
    aiModel: '',
    aiTimeoutMs: 60000,
    capAdd: 100,
    capRemove: 50,
    seriesPrivacy: 'PRIVATE',
    tvMazeEnabled: true,
    tmdbKey: '',
    aniListEnabled: true,
    features: {},
    hotkeyFeedback: false
  };

  // ---------------------------------------------------------------- storage

  function storeGet(key, fallback) {
    var full = NS + '.' + key;
    var v;
    try { v = GM_getValue(full); } catch (e) { v = undefined; }
    if (v === undefined) {
      try {
        var raw = localStorage.getItem(full);
        if (raw !== null) v = JSON.parse(raw);
      } catch (e) { /* ignore */ }
    }
    return v === undefined || v === null ? fallback : v;
  }

  function storeSet(key, value) {
    var full = NS + '.' + key;
    try { GM_setValue(full, value); } catch (e) { /* ignore */ }
    try { localStorage.setItem(full, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function storeDel(key) {
    var full = NS + '.' + key;
    try { GM_deleteValue(full); } catch (e) { /* ignore */ }
    try { localStorage.removeItem(full); } catch (e) { /* ignore */ }
  }

  function settings() {
    var saved = storeGet('settings', {}) || {};
    var out = {};
    for (var k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      out[k] = saved[k] === undefined || saved[k] === null || saved[k] === '' ? DEFAULTS[k] : saved[k];
    }
    return out;
  }

  function saveSettings(patch) {
    var next = settings();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    storeSet('settings', next);
    return next;
  }

  // ---------------------------------------------------------------- dom

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) {
        for (var j = 0; j < kid.length; j++) if (kid[j]) el.append(kid[j].nodeType ? kid[j] : document.createTextNode(String(kid[j])));
      } else {
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return el;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------------------------------------------------------------- AI

  function aiReady() {
    var s = settings();
    return !!(s.aiKey && s.aiBaseUrl && s.aiModel);
  }

  function aiUrl() {
    return String(settings().aiBaseUrl).replace(/\/+$/, '') + '/chat/completions';
  }

  function aiChat(messages, options) {
    var s = settings();
    var opts = options || {};
    return new Promise(function (resolve) {
      if (!s.aiKey || !s.aiModel) {
        resolve({ ok: false, error: 'AI is not configured. Set base URL, key and model once — every script reads the same settings.' });
        return;
      }
      if (typeof GM_xmlhttpRequest !== 'function') {
        resolve({ ok: false, error: 'This manager has no GM_xmlhttpRequest, so cross-origin AI calls are blocked.' });
        return;
      }
      var body = {
        model: s.aiModel,
        messages: messages,
        temperature: opts.temperature === undefined ? 0.2 : opts.temperature
      };
      if (opts.json) body.response_format = { type: 'json_object' };

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'AI request timed out.' });
      }, s.aiTimeoutMs);

      GM_xmlhttpRequest({
        method: 'POST',
        url: aiUrl(),
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.aiKey },
        data: JSON.stringify(body),
        timeout: s.aiTimeoutMs,
        onload: function (res) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (res.status < 200 || res.status >= 300) {
            resolve({ ok: false, error: 'AI endpoint returned ' + res.status + ': ' + String(res.responseText || '').slice(0, 240) });
            return;
          }
          try {
            var parsed = JSON.parse(res.responseText);
            var msg = parsed.choices && parsed.choices[0] && parsed.choices[0].message;
            var text = msg && (msg.content || msg.reasoning_content || '');
            resolve(text ? { ok: true, text: String(text) } : { ok: false, error: 'AI returned an empty message.' });
          } catch (e) {
            resolve({ ok: false, error: 'AI response was not JSON.' });
          }
        },
        onerror: function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: 'Network error calling the AI endpoint.' });
        },
        ontimeout: function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: 'AI request timed out.' });
        }
      });
    });
  }

  function aiJson(system, user) {
    return aiChat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true })
      .then(function (res) {
        if (!res.ok) return { ok: false, error: res.error };
        var text = res.text.trim();
        if (text.slice(0, 3) === '```') text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
        var first = text.indexOf('{');
        var last = text.lastIndexOf('}');
        if (first === -1 || last === -1) return { ok: false, error: 'AI did not return a JSON object.' };
        try {
          return { ok: true, data: JSON.parse(text.slice(first, last + 1)) };
        } catch (e) {
          return { ok: false, error: 'AI returned malformed JSON.' };
        }
      });
  }

  // ---------------------------------------------------------------- innertube

  function ytcfg(k) {
    try { return window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get(k) : undefined; }
    catch (e) { return undefined; }
  }

  function itContext() {
    var c = ytcfg('INNERTUBE_CONTEXT');
    if (c) return c;
    return { client: { clientName: 'WEB', clientVersion: ytcfg('INNERTUBE_CLIENT_VERSION') || '2.20250101.00.00', hl: 'en', gl: 'US' } };
  }

  function itKey() {
    return ytcfg('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  }

  /** POST to InnerTube. Surfaces the response body — a bare status hides the reason. */
  function itPost(path, body, extraHeaders) {
    var url = '/youtubei/v1/' + path + '?key=' + encodeURIComponent(itKey()) + '&prettyPrint=false';
    var headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    return fetch(url, {
      method: 'POST',
      headers: headers,
      credentials: 'include',
      body: JSON.stringify(Object.assign({ context: itContext() }, body || {}))
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('InnerTube ' + path + ' HTTP ' + res.status + ' — ' + String(t).replace(/\s+/g, ' ').slice(0, 240));
        }, function () {
          throw new Error('InnerTube ' + path + ' HTTP ' + res.status);
        });
      }
      return res.json();
    });
  }

  /** Recursively collect every value stored under `key`. Survives schema drift. */
  function collect(obj, key, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 48) return out;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) collect(obj[i], key, out, depth + 1);
      return out;
    }
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (k === key) out.push(v);
      if (v && typeof v === 'object') collect(v, key, out, depth + 1);
    }
    return out;
  }

  function textOf(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.simpleText) return node.simpleText;
    if (Array.isArray(node.runs)) {
      var s = '';
      for (var i = 0; i < node.runs.length; i++) s += node.runs[i].text || '';
      return s;
    }
    return '';
  }

  function browseIdOf(node) {
    try {
      if (!node) return null;
      if (Array.isArray(node.runs) && node.runs[0] && node.runs[0].navigationEndpoint &&
          node.runs[0].navigationEndpoint.browseEndpoint) {
        return node.runs[0].navigationEndpoint.browseEndpoint.browseId;
      }
      if (node.navigationEndpoint && node.navigationEndpoint.browseEndpoint) {
        return node.navigationEndpoint.browseEndpoint.browseId;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function deepTexts(node, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 14) return out;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) deepTexts(node[i], out, depth + 1);
      return out;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if ((k === 'content' || k === 'simpleText' || k === 'text') && typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') deepTexts(v, out, depth + 1);
    }
    return out;
  }

  /** Row from the current `lockupViewModel` shape (YouTube's live shape). */
  function lockupToItem(node) {
    var id = node && node.contentId;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    var title = '';
    try {
      var md = node.metadata && node.metadata.lockupMetadataViewModel;
      title = (md && md.title && md.title.content) || '';
    } catch (e) { title = ''; }
    var texts = deepTexts(node, [], 0);
    var duration = '';
    var channel = '';
    var i;
    for (i = 0; i < texts.length; i++) {
      if (!duration && /^\d{1,2}:\d{2}(:\d{2})?$/.test(texts[i])) duration = texts[i];
    }
    for (i = 0; i < texts.length; i++) {
      var t = texts[i];
      if (t === title || t === duration) continue;
      if (t.length < 2 || t.length > 80) continue;
      if (/^\d/.test(t) || /view|ago|subscriber|watch|playlist/i.test(t)) continue;
      channel = t;
      break;
    }
    return { id: id, title: title, channel: channel, duration: duration };
  }

  // ---------------------------------------------------------------- auth

  function authHeaders() {
    var m = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m) return Promise.resolve(null);
    var ts = Math.floor(Date.now() / 1000);
    var msg = ts + ' ' + m[1] + ' https://www.youtube.com';
    return crypto.subtle.digest('SHA-1', new TextEncoder().encode(msg)).then(function (digest) {
      var bytes = new Uint8Array(digest);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      var out = { 'Authorization': 'SAPISIDHASH ' + ts + '_' + hex, 'X-Origin': 'https://www.youtube.com' };
      var vis = ytcfg('VISITOR_DATA');
      if (vis) out['X-Goog-Visitor-Id'] = vis;
      var cv = ytcfg('INNERTUBE_CLIENT_VERSION');
      if (cv) {
        out['X-Youtube-Client-Name'] = '1';
        out['X-Youtube-Client-Version'] = cv;
      }
      return out;
    });
  }

  function requireAuth() {
    return authHeaders().then(function (hdr) {
      if (!hdr) throw new Error('Not signed in: no SAPISID cookie. Reload YouTube and sign in again.');
      return hdr;
    });
  }

  // ---------------------------------------------------------------- playlist IO

  function enumeratePlaylist(listId, onProgress) {
    return requireAuth().then(function (auth) {
      var items = [];
      var seen = {};
      var guard = 0;
      function absorb(res) {
        var legacy = collect(res, 'playlistVideoRenderer');
        for (var i = 0; i < legacy.length; i++) {
          var r = legacy[i];
          if (!r.videoId || seen[r.videoId]) continue;
          seen[r.videoId] = 1;
          items.push({ id: r.videoId, title: textOf(r.title), channel: textOf(r.shortBylineText), duration: textOf(r.lengthText) });
        }
        var lockups = collect(res, 'lockupViewModel');
        for (var j = 0; j < lockups.length; j++) {
          var item = lockupToItem(lockups[j]);
          if (!item || seen[item.id]) continue;
          seen[item.id] = 1;
          items.push(item);
        }
        if (onProgress) onProgress(items.length);
        return collect(res, 'continuationCommand').map(function (c) { return c && c.token; }).filter(Boolean);
      }
      function step(body) {
        return itPost('browse', body, auth).then(function (res) {
          var tokens = absorb(res);
          if (!tokens.length || guard++ > 200) return items;
          return sleep(120).then(function () { return step({ continuation: tokens[0] }); });
        });
      }
      return step({ browseId: 'VL' + listId });
    });
  }

  function enumerateChannel(channelId, onProgress) {
    return enumeratePlaylist('UU' + channelId.slice(2), onProgress);
  }

  function searchVideos(query, limit) {
    limit = limit || 40;
    var items = [];
    var seen = {};
    var guard = 0;
    function absorb(res) {
      var vids = collect(res, 'videoRenderer');
      for (var i = 0; i < vids.length; i++) {
        var r = vids[i];
        if (!r.videoId || seen[r.videoId]) continue;
        seen[r.videoId] = 1;
        items.push({
          id: r.videoId,
          title: textOf(r.title),
          channel: textOf(r.ownerText) || textOf(r.longBylineText),
          channelId: browseIdOf(r.ownerText) || browseIdOf(r.longBylineText),
          duration: textOf(r.lengthText),
          views: textOf(r.viewCountText) || textOf(r.shortViewCountText)
        });
      }
      return collect(res, 'continuationCommand').map(function (c) { return c && c.token; }).filter(Boolean);
    }
    function step(body) {
      return itPost('search', body).then(function (res) {
        var tokens = absorb(res);
        if (items.length >= limit || !tokens.length || guard++ > 20) return items.slice(0, limit);
        return sleep(100).then(function () { return step({ continuation: tokens[0] }); });
      });
    }
    return step({ query: query });
  }

  function channelSubscribers(channelId) {
    return itPost('browse', { browseId: channelId }).then(function (res) {
      var json = JSON.stringify(res);
      var m = json.match(/"([\d.,]+\s*[KMB]?)\s+subscribers"/i);
      if (!m) return 0;
      var n = parseFloat(String(m[1]).replace(/,/g, '').match(/[\d.]+/)[0]);
      if (isNaN(n)) return 0;
      var unit = (String(m[1]).match(/[KMB]/i) || [''])[0].toUpperCase();
      if (unit === 'K') n *= 1e3;
      else if (unit === 'M') n *= 1e6;
      else if (unit === 'B') n *= 1e9;
      return Math.round(n);
    }, function () { return 0; });
  }

  function createPlaylist(options) {
    return requireAuth().then(function (auth) {
      var body = { title: options.title };
      if (options.description) body.description = options.description;
      if (options.privacyStatus) body.privacyStatus = options.privacyStatus;
      if (options.videoIds && options.videoIds.length) body.videoIds = options.videoIds;
      return itPost('playlist/create', body, auth);
    }).then(function (res) {
      var id = res && res.playlistId;
      if (!id) throw new Error('playlist/create returned no playlistId.');
      return id;
    });
  }

  function addVideos(playlistId, videoIds) {
    return requireAuth().then(function (auth) {
      var actions = videoIds.map(function (id) { return { action: 'ACTION_ADD_VIDEO', addedVideoId: id }; });
      var chunks = [];
      for (var i = 0; i < actions.length; i += 50) chunks.push(actions.slice(i, i + 50));
      var done = 0;
      function step(idx) {
        if (idx >= chunks.length) return done;
        return itPost('browse/edit_playlist', { playlistId: playlistId, actions: chunks[idx] }, auth).then(function () {
          done += chunks[idx].length;
          return sleep(200).then(function () { return step(idx + 1); });
        });
      }
      return step(0);
    });
  }

  function removeVideos(playlistId, videoIds) {
    return requireAuth().then(function (auth) {
      var actions = videoIds.map(function (id) { return { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: id }; });
      return itPost('browse/edit_playlist', { playlistId: playlistId, actions: actions }, auth);
    });
  }

  // ---------------------------------------------------------------- misc

  function parseCount(text) {
    if (text === null || text === undefined) return 0;
    var m = String(text).replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    if (isNaN(n)) return 0;
    var unit = (m[2] || '').toUpperCase();
    if (unit === 'K') n *= 1e3;
    else if (unit === 'M') n *= 1e6;
    else if (unit === 'B') n *= 1e9;
    return Math.round(n);
  }

  function parseDuration(text) {
    if (!text) return 0;
    var parts = String(text).trim().split(':').map(function (p) { return parseInt(p, 10); });
    for (var i = 0; i < parts.length; i++) if (isNaN(parts[i])) return 0;
    return parts.reduce(function (acc, n) { return acc * 60 + n; }, 0);
  }

  var EPISODE_PATTERNS = [
    { re: /\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})\b/i, season: 1, episode: 2 },
    { re: /\bEpisode\s*(\d{1,4})\b/i, episode: 1 },
    { re: /\bEP?\.?\s*(\d{1,4})\b/i, episode: 1 },
    { re: /\bPart\s*(\d{1,3})\b/i, episode: 1 },
    { re: /第\s*(\d{1,4})\s*[集話话]/, episode: 1 },
    { re: /#\s*(\d{1,4})\b/, episode: 1 },
    { re: /^\s*(\d{1,3})\s*[.)\-|]/, episode: 1 }
  ];

  function parseEpisode(title) {
    if (!title) return null;
    var t = String(title).replace(/\s+/g, ' ');
    for (var i = 0; i < EPISODE_PATTERNS.length; i++) {
      var p = EPISODE_PATTERNS[i];
      var m = t.match(p.re);
      if (!m) continue;
      var ep = parseInt(m[p.episode], 10);
      if (isNaN(ep)) continue;
      var season = p.season ? parseInt(m[p.season], 10) : null;
      return { episode: ep, season: isNaN(season) ? null : season };
    }
    return null;
  }

  function notify(text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ text: String(text).slice(0, 200), title: 'YouTube Toolkit', timeout: 6000 });
        return;
      }
    } catch (e) { /* ignore */ }
    try { alert(text); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- shared UI

  /**
   * Feature flag. Scripts return early when their own flag is off, so the user can
   * disable one script without uninstalling it. Defaults to on.
   */
  function featureOn(name, dflt) {
    var s = settings();
    var f = s.features || {};
    if (f[name] === undefined) return dflt === undefined ? true : !!dflt;
    return !!f[name];
  }

  function setFeature(name, on) {
    var s = settings();
    var f = Object.assign({}, s.features || {});
    f[name] = !!on;
    saveSettings({ features: f });
    return f;
  }

  var CSS_ID = 'ytk-shared-css';

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = [
      '.ytk2-bar{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;gap:4px;',
      'align-items:center;padding:5px;border-radius:999px;background:rgba(28,28,28,.96);',
      'box-shadow:0 4px 20px rgba(0,0,0,.5);font:500 12px/1 system-ui,sans-serif;color:#eaeaea;',
      'backdrop-filter:blur(8px);flex-wrap:wrap;max-width:calc(100vw - 32px)}',
      '.ytk2-bar button{font:inherit;font-size:12px;padding:6px 10px;border-radius:999px;border:0;',
      'cursor:pointer;background:transparent;color:#cfcfcf}',
      '.ytk2-bar button:hover{background:#333;color:#fff}',
      '.ytk2-panel{position:fixed;left:16px;bottom:64px;z-index:2147483001;width:min(420px,calc(100vw - 32px));',
      'max-height:70vh;overflow:auto;border-radius:14px;background:#1c1c1c;color:#eaeaea;',
      'box-shadow:0 8px 40px rgba(0,0,0,.6);font:400 12.5px/1.5 system-ui,sans-serif}',
      '.ytk2-panel header{display:flex;align-items:center;gap:8px;padding:12px 14px;',
      'border-bottom:1px solid #2e2e2e;position:sticky;top:0;background:#1c1c1c}',
      '.ytk2-panel header b{flex:1;font-size:13px;font-weight:650}',
      '.ytk2-panel .x{border:0;background:transparent;color:#9a9a9a;cursor:pointer;font-size:16px}',
      '.ytk2-panel .body{padding:10px 14px 14px}',
      '.ytk2-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #262626}',
      '.ytk2-row:first-child{border-top:0}',
      '.ytk2-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ytk2-dim{color:#8f8f8f}',
      '.ytk2-ok{color:#7ee787}',
      '.ytk2-warn{color:#ffa657}',
      '.ytk2-err{color:#ff8a80}',
      '.ytk2-kv{display:flex;justify-content:space-between;padding:3px 0}',
      '.ytk2-kv span:last-child{font-variant-numeric:tabular-nums;color:#fff}',
      '.ytk2-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:2147483647;',
      'padding:5px 13px;border-radius:999px;background:rgba(15,15,15,.92);color:#fff;',
      'font:500 12.5px/1.4 system-ui,sans-serif;pointer-events:none}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  var toastTimer = null;

  function toast(text) {
    ensureCss();
    var el = document.getElementById('ytk2-toast');
    if (!el) {
      el = h('div', { id: 'ytk2-toast', class: 'ytk2-toast' });
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = String(text).slice(0, 60);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      var node = document.getElementById('ytk2-toast');
      if (node) node.remove();
      toastTimer = null;
    }, 1300);
  }

  var openPanel = null;

  function closePanel() {
    if (openPanel && openPanel.parentNode) openPanel.remove();
    openPanel = null;
  }

  /** Transient panel. `build(body)` fills it. Returns {body, close}. */
  function panel(title, build) {
    ensureCss();
    closePanel();
    var body = h('div', { class: 'body' });
    var box = h('div', { class: 'ytk2-panel' },
      h('header', {}, h('b', { text: title }), h('button', { class: 'x', text: '✕', onclick: closePanel })),
      body
    );
    (document.body || document.documentElement).appendChild(box);
    openPanel = box;
    if (typeof build === 'function') build(body);
    return { body: body, close: closePanel };
  }

  function kv(body, label, value, cls) {
    body.appendChild(h('div', { class: 'ytk2-kv' },
      h('span', { class: 'ytk2-dim', text: label }),
      h('span', { class: cls || '', text: String(value) })
    ));
  }

  function note(body, text, cls) {
    body.appendChild(h('div', { class: 'ytk2-dim ' + (cls || ''), style: 'padding:5px 0;line-height:1.55', text: text }));
  }

  var toolbarEl = null;
  var toolbarButtons = [];

  /**
   * The ONE toolbar. Every feature script contributes buttons here instead of drawing
   * its own chrome, so scripts cannot fight over the same corner of the page.
   */
  function mountToolbar(items) {
    ensureCss();
    if (!toolbarEl) {
      toolbarEl = h('div', { class: 'ytk2-bar' });
      (document.body || document.documentElement).appendChild(toolbarEl);
    }
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var btn = h('button', { text: item.label });
        btn.addEventListener('click', function () {
          try {
            item.run(btn);
          } catch (e) {
            toast((item.label || 'Action') + ' failed: ' + e.message);
          }
        });
        toolbarEl.appendChild(btn);
        toolbarButtons.push(btn);
      })(items[i]);
    }
    return function unmount() {
      for (var j = 0; j < toolbarButtons.length; j++) {
        if (toolbarButtons[j].parentNode) toolbarButtons[j].parentNode.removeChild(toolbarButtons[j]);
      }
      toolbarButtons = [];
      if (toolbarEl && !toolbarEl.children.length && toolbarEl.parentNode) toolbarEl.remove();
      toolbarEl = null;
    };
  }

  // ---------------------------------------------------------------- the ONE settings popup

  var SET_CSS_ID = 'ytk-settings-css';

  function ensureSettingsCss() {
    if (document.getElementById(SET_CSS_ID)) return;
    var st = document.createElement('style');
    st.id = SET_CSS_ID;
    st.textContent = [
      '.yts-scrim{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.66);',
      'display:flex;align-items:center;justify-content:center;padding:18px}',
      '.yts-card{width:min(580px,100%);max-height:min(88vh,820px);display:flex;flex-direction:column;',
      'border-radius:18px;background:#161616;color:#f1f1f1;box-shadow:0 24px 80px rgba(0,0,0,.7);',
      'border:1px solid rgba(255,255,255,.08);font:400 13px/1.55 Roboto,Arial,system-ui,sans-serif;overflow:hidden}',
      '.yts-card *{box-sizing:border-box}',
      '.yts-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;',
      'border-bottom:1px solid rgba(255,255,255,.09)}',
      '.yts-head .t{flex:1;min-width:0}',
      '.yts-head h3{margin:0;font-size:15.5px;font-weight:650;letter-spacing:.01em}',
      '.yts-head p{margin:3px 0 0;font-size:12px;color:#9a9a9a}',
      '.yts-x{border:0;background:transparent;color:#8f8f8f;cursor:pointer;font-size:19px;line-height:1;padding:2px 4px;border-radius:8px}',
      '.yts-x:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.yts-body{overflow:auto;padding:4px 20px 10px}',
      '.yts-sec{padding:14px 0 6px}',
      '.yts-sec+.yts-sec{border-top:1px solid rgba(255,255,255,.07)}',
      '.yts-sec>h4{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#8f8f8f}',
      '.yts-f{display:block;margin:0 0 12px}',
      '.yts-f>span{display:block;font-size:11.5px;color:#9d9d9d;margin-bottom:5px}',
      '.yts-f .hint{display:block;font-size:11px;color:#6f6f6f;margin-top:4px}',
      '.yts-card input[type=text],.yts-card input[type=password],.yts-card input[type=number],',
      '.yts-card select,.yts-card textarea{width:100%;font:inherit;font-size:12.5px;padding:8px 11px;',
      'border-radius:10px;color:inherit;background:rgba(255,255,255,.06);',
      'border:1px solid rgba(255,255,255,.14);outline:none}',
      '.yts-card input:focus,.yts-card select:focus,.yts-card textarea:focus{border-color:#3ea6ff}',
      '.yts-card textarea{min-height:92px;resize:vertical;font-family:ui-monospace,monospace;font-size:12px}',
      '.yts-key{display:flex;align-items:center;gap:10px}',
      '.yts-key kbd{flex:1;font:600 12px ui-monospace,monospace;padding:8px 11px;border-radius:10px;',
      'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14)}',
      '.yts-key.armed kbd{border-color:#3ea6ff;color:#3ea6ff}',
      '.yts-btn{font:inherit;font-size:12px;font-weight:600;padding:7px 13px;border-radius:9px;cursor:pointer;',
      'color:inherit;background:transparent;border:1px solid rgba(255,255,255,.2)}',
      '.yts-btn:hover{border-color:rgba(255,255,255,.45)}',
      '.yts-btn.p{background:#3ea6ff;border-color:#3ea6ff;color:#0f0f0f}',
      '.yts-chk{display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;font-size:12.5px}',
      '.yts-chk input{width:15px;height:15px;accent-color:#3ea6ff;cursor:pointer}',
      '.yts-foot{display:flex;align-items:center;gap:8px;padding:14px 20px 16px;',
      'border-top:1px solid rgba(255,255,255,.09);background:#161616}',
      '.yts-foot .grow{flex:1}',
      '.yts-msg{font-size:11.5px;min-height:16px;padding:0 20px 10px;color:#9a9a9a}',
      '.yts-msg.ok{color:#7ee787}',
      '.yts-msg.bad{color:#ff8a80}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  var settingsScrim = null;

  function closeSettings() {
    if (settingsScrim && settingsScrim.parentNode) settingsScrim.remove();
    settingsScrim = null;
  }

  /**
   * The single settings surface for every script in the collection.
   *
   * opts = {
   *   title, subtitle,
   *   fields: [{ key, label, type, def, options, min, max, placeholder, hint }],
   *   actions: [{ label, run }],
   *   showAi: true
   * }
   *
   * Values are written to the shared `ytk.settings` object, so the AI key is entered
   * once and every script reads it. Nothing is drawn until this is called.
   */
  function openSettings(opts) {
    opts = opts || {};
    ensureSettingsCss();
    closeSettings();

    var saved = settings();
    var draft = Object.assign({}, saved);

    function getVal(f) {
      var v = saved[f.key];
      return v === undefined || v === null || v === '' ? f.def : v;
    }

    function field(f) {
      var wrap = h('label', { class: 'yts-f' });
      wrap.appendChild(h('span', { text: f.label }));
      var input;

      if (f.type === 'checkbox') {
        wrap.className = 'yts-chk';
        input = h('input', { type: 'checkbox' });
        input.checked = !!getVal(f);
        input.addEventListener('change', function () { draft[f.key] = input.checked; });
        wrap.appendChild(input);
        wrap.appendChild(h('span', { text: f.label }));
      } else if (f.type === 'select') {
        input = h('select');
        (f.options || []).forEach(function (o) {
          var opt = h('option', { value: o, text: o });
          if (String(getVal(f)) === String(o)) opt.selected = true;
          input.appendChild(opt);
        });
        draft[f.key] = getVal(f);
        input.addEventListener('change', function () { draft[f.key] = input.value; });
        wrap.appendChild(input);
      } else if (f.type === 'textarea') {
        input = h('textarea');
        input.value = Array.isArray(getVal(f)) ? getVal(f).join('\n') : String(getVal(f) || '');
        input.addEventListener('input', function () {
          draft[f.key] = f.split ? input.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean) : input.value;
        });
        wrap.appendChild(input);
      } else if (f.type === 'key') {
        var holder = h('div', { class: 'yts-key' });
        var kb = h('kbd', { text: String(getVal(f)) });
        var btn = h('button', { class: 'yts-btn', text: 'Rebind' });
        var armed = false;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          armed = true;
          holder.className = 'yts-key armed';
          btn.textContent = 'Press a key…';
        });
        holder.appendChild(kb);
        holder.appendChild(btn);
        wrap.appendChild(holder);
        var capture = function (e) {
          if (!armed) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') {
            armed = false;
            holder.className = 'yts-key';
            btn.textContent = 'Rebind';
            return;
          }
          var combo = normalizeCombo(e);
          if (!combo) return;
          draft[f.key] = combo;
          kb.textContent = combo;
          armed = false;
          holder.className = 'yts-key';
          btn.textContent = 'Rebind';
        };
        document.addEventListener('keydown', capture, true);
        (opts.__cleanups = opts.__cleanups || []).push(function () {
          document.removeEventListener('keydown', capture, true);
        });
      } else {
        input = h('input', { type: f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text' });
        input.value = getVal(f) === undefined ? '' : getVal(f);
        if (f.placeholder) input.placeholder = f.placeholder;
        input.addEventListener('input', function () {
          draft[f.key] = f.type === 'number' ? (parseInt(input.value, 10) || f.def) : input.value;
        });
        wrap.appendChild(input);
      }

      if (f.hint) wrap.appendChild(h('span', { class: 'hint', text: f.hint }));
      return wrap;
    }

    var body = h('div', { class: 'yts-body' });
    var msg = h('div', { class: 'yts-msg' });

    if (opts.fields && opts.fields.length) {
      var sec = h('div', { class: 'yts-sec' }, h('h4', { text: opts.sectionTitle || 'Options' }));
      opts.fields.forEach(function (f) { sec.appendChild(field(f)); });
      body.appendChild(sec);
    }

    if (opts.showAi !== false) {
      var aiSec = h('div', { class: 'yts-sec' }, h('h4', { text: 'AI — shared by every script' }));
      aiSec.appendChild(field({ key: 'aiBaseUrl', label: 'Endpoint', type: 'text', def: DEFAULTS.aiBaseUrl, placeholder: 'https://api.openai.com/v1' }));
      aiSec.appendChild(field({ key: 'aiKey', label: 'API key', type: 'password', def: '', hint: 'Stored once in ScriptCat storage and synced by its cloud backup.' }));
      aiSec.appendChild(field({ key: 'aiModel', label: 'Model', type: 'text', def: '', placeholder: 'gpt-4o-mini' }));
      var test = h('button', {
        class: 'yts-btn',
        text: 'Test connection',
        onclick: function () {
          saveSettings(draft);
          msg.className = 'yts-msg';
          msg.textContent = 'Testing…';
          aiChat([{ role: 'user', content: 'Reply with the single word: ok' }], { temperature: 0 }).then(function (res) {
            msg.className = 'yts-msg ' + (res.ok ? 'ok' : 'bad');
            msg.textContent = res.ok ? 'Connected — model replied: ' + res.text.slice(0, 40) : 'Failed: ' + res.error;
          });
        }
      });
      aiSec.appendChild(test);
      body.appendChild(aiSec);
    }

    if (opts.actions && opts.actions.length) {
      var actSec = h('div', { class: 'yts-sec' }, h('h4', { text: 'Actions' }));
      opts.actions.forEach(function (a) {
        actSec.appendChild(h('div', { style: 'padding:4px 0' },
          h('button', {
            class: 'yts-btn', text: a.label,
            onclick: function () { closeSettings(); if (typeof a.run === 'function') a.run(); }
          })
        ));
      });
      body.appendChild(actSec);
    }

    var saveBtn = h('button', { class: 'yts-btn p', text: 'Save' });
    var resetBtn = h('button', { class: 'yts-btn', text: 'Reset' });
    var cancelBtn = h('button', { class: 'yts-btn', text: 'Cancel' });

    saveBtn.addEventListener('click', function () {
      for (var k in draft) if (Object.prototype.hasOwnProperty.call(draft, k)) saved[k] = draft[k];
      saveSettings(saved);
      if (typeof opts.onSave === 'function') opts.onSave(saved);
      (opts.__cleanups || []).forEach(function (fn) { fn(); });
      closeSettings();
      msg.textContent = '';
      try { toast(opts.title + ' — saved'); } catch (e) { /* ignore */ }
      if (opts.reload !== false) setTimeout(function () { location.reload(); }, 220);
    });

    resetBtn.addEventListener('click', function () {
      if (!confirm('Reset this script\'s settings to defaults?')) return;
      var next = settings();
      (opts.fields || []).forEach(function (f) { delete next[f.key]; });
      saveSettings(next);
      (opts.__cleanups || []).forEach(function (fn) { fn(); });
      closeSettings();
      setTimeout(function () { location.reload(); }, 200);
    });

    cancelBtn.addEventListener('click', function () {
      (opts.__cleanups || []).forEach(function (fn) { fn(); });
      closeSettings();
    });

    var card = h('div', { class: 'yts-card' },
      h('div', { class: 'yts-head' },
        h('div', { class: 't' },
          h('h3', { text: opts.title || 'Settings' }),
          h('p', { text: opts.subtitle || 'These settings apply to this script. The AI key is shared by every script.' })
        ),
        h('button', { class: 'yts-x', text: '✕', onclick: function () { (opts.__cleanups || []).forEach(function (fn) { fn(); }); closeSettings(); } })
      ),
      body,
      msg,
      h('div', { class: 'yts-foot' }, saveBtn, resetBtn, h('span', { class: 'grow' }), cancelBtn)
    );

    var scrim = h('div', { class: 'yts-scrim' }, card);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) { (opts.__cleanups || []).forEach(function (fn) { fn(); }); closeSettings(); } });
    (document.body || document.documentElement).appendChild(scrim);
    settingsScrim = scrim;

    var esc = function (e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      (opts.__cleanups || []).forEach(function (fn) { fn(); });
      closeSettings();
    };
    document.addEventListener('keydown', esc, true);
    (opts.__cleanups = opts.__cleanups || []).push(function () { document.removeEventListener('keydown', esc, true); });

    return scrim;
  }

  /** Canonical combo string for a keyboard event: ctrl+alt+shift+meta+key. */
  function normalizeCombo(e) {
    var dead = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'];
    if (e.isComposing || !e.key || dead.indexOf(e.key) !== -1) return null;
    var mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.shiftKey) mods.push('shift');
    if (e.metaKey) mods.push('meta');
    return mods.concat(e.key.toLowerCase()).join('+');
  }

  return {
    VERSION: VERSION,
    NS: NS,
    DEFAULTS: DEFAULTS,
    storeGet: storeGet, storeSet: storeSet, storeDel: storeDel,
    settings: settings, saveSettings: saveSettings,
    h: h, sleep: sleep,
    aiReady: aiReady, aiChat: aiChat, aiJson: aiJson,
    ytcfg: ytcfg, itKey: itKey, itContext: itContext, itPost: itPost,
    collect: collect, textOf: textOf, browseIdOf: browseIdOf, deepTexts: deepTexts, lockupToItem: lockupToItem,
    authHeaders: authHeaders, requireAuth: requireAuth,
    enumeratePlaylist: enumeratePlaylist, enumerateChannel: enumerateChannel, searchVideos: searchVideos,
    channelSubscribers: channelSubscribers,
    createPlaylist: createPlaylist, addVideos: addVideos, removeVideos: removeVideos,
    parseCount: parseCount, parseDuration: parseDuration, parseEpisode: parseEpisode,
    notify: notify,
    featureOn: featureOn, setFeature: setFeature,
    toast: toast, panel: panel, kv: kv, note: note, closePanel: closePanel, ensureCss: ensureCss,
    mountToolbar: mountToolbar,
    openSettings: openSettings, closeSettings: closeSettings, normalizeCombo: normalizeCombo
  };
})();
