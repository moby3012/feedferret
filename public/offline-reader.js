/* Offline reader for the static offline page: lists and opens the article bodies the app stored in IndexedDB
 * (features/offline/store.ts). Read-only, no network, no framework. Bodies are the server-sanitized HTML of
 * the app's reader; they render inside a script-less sandboxed iframe on top of that. */
(function () {
  "use strict";

  // Keep in sync with features/offline/store.ts (tests/features/offline-reader-contract.test.ts checks it).
  var DB_NAME = "feedferret-offline";
  var DB_VERSION = 1;
  var INDEX_STORE = "index";
  var BODY_STORE = "bodies";
  var META_STORE = "meta";
  var ACTIVE_USER_KEY = "activeUser";
  var MAX_RECENT = 50;

  var de = /^de\b/i.test(navigator.language || "");
  var T = de
    ? {
        title: "Du bist offline",
        intro: "FeedFerret braucht gerade eine Verbindung. Diese Artikel kannst du trotzdem lesen:",
        none: "Offline ist noch nichts gespeichert. Artikel unter „Später lesen“ und zuletzt geöffnete Artikel erscheinen hier, sobald du sie einmal online geladen hast.",
        later: "Später lesen",
        recent: "Zuletzt gelesen offline",
        retry: "Erneut versuchen",
        back: "Zurück",
        bodyMissing: "Dieser Artikel ist nicht offline verfügbar.",
        image: "Bild offline nicht verfügbar",
      }
    : {
        title: "You are offline",
        intro: "FeedFerret needs a connection right now. You can still read these articles:",
        none: "Nothing is stored for offline yet. Read-later articles and recently opened ones show up here once you have loaded them online.",
        later: "Read later",
        recent: "Recently read offline",
        retry: "Try again",
        back: "Back",
        bodyMissing: "This article is not available offline.",
        image: "Image not available offline",
      };
  document.documentElement.lang = de ? "de" : "en";

  var $ = function (id) {
    return document.getElementById(id);
  };
  $("title").textContent = T.title;
  $("intro").textContent = T.intro;
  $("retry").textContent = T.retry;
  $("back").textContent = T.back;

  function request(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () {
        resolve(r.result);
      };
      r.onerror = function () {
        reject(r.error);
      };
    });
  }

  /** Opens the app's DB without ever creating it (an empty v1 DB would block the app's own schema upgrade). */
  function openDb() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var open;
      try {
        open = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return resolve(null);
      }
      open.onupgradeneeded = function () {
        open.transaction.abort();
      };
      open.onsuccess = function () {
        resolve(open.result);
      };
      open.onerror = function () {
        resolve(null);
      };
      open.onblocked = function () {
        resolve(null);
      };
    });
  }

  function load() {
    return openDb().then(function (db) {
      if (!db) return { db: null, user: null, rows: [] };
      var tx = db.transaction([META_STORE, INDEX_STORE], "readonly");
      return request(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY)).then(function (user) {
        if (!user) return { db: db, user: null, rows: [] };
        return request(tx.objectStore(INDEX_STORE).index("byUser").getAll(IDBKeyRange.only(user))).then(function (rows) {
          return { db: db, user: user, rows: rows };
        });
      });
    });
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(de ? "de-DE" : "en-US", { year: "numeric", month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function section(name, rows, onOpen) {
    var wrap = document.createElement("div");
    var h = document.createElement("h2");
    h.textContent = name;
    var ul = document.createElement("ul");
    rows.forEach(function (row) {
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = row.item.displayTitle || row.item.title;
      var m = document.createElement("span");
      m.className = "m";
      m.textContent = [row.item.canonicalFeedName, fmtDate(row.item.publishedAt)].filter(Boolean).join(" · ");
      b.appendChild(t);
      b.appendChild(m);
      b.addEventListener("click", function () {
        onOpen(row);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    wrap.appendChild(h);
    wrap.appendChild(ul);
    return wrap;
  }

  function placeholder(doc, img) {
    var span = doc.createElement("span");
    span.textContent = T.image;
    span.style.cssText = "display:block;padding:1rem;margin:1rem 0;border:1px dashed currentColor;opacity:.6;text-align:center;font-size:.85em";
    img.replaceWith(span);
  }

  function frameDoc(html) {
    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\'">' +
      '<base target="_blank"><meta name="color-scheme" content="light dark">' +
      "<style>body{margin:0;font:1.05rem/1.7 system-ui,sans-serif;word-wrap:break-word}img,video{max-width:100%;height:auto}pre{overflow:auto}a{color:#3f86b5}</style>" +
      "</head><body>" +
      html +
      "</body></html>"
    );
  }

  function showArticle(state, row) {
    return openBody(state, row).then(function (detail) {
      $("lists").hidden = true;
      $("reader").hidden = false;
      $("r-title").textContent = row.item.displayTitle || row.item.title;
      $("r-meta").textContent = [row.item.canonicalFeedName, row.item.author, fmtDate(row.item.publishedAt)].filter(Boolean).join(" · ");
      var frame = $("body");
      frame.title = row.item.title;
      if (!detail) {
        frame.srcdoc = frameDoc('<p class="missing">' + T.bodyMissing + "</p>");
        return;
      }
      frame.onload = function () {
        var doc = frame.contentDocument;
        if (!doc) return;
        Array.prototype.forEach.call(doc.images, function (img) {
          if (img.complete && img.naturalWidth === 0) placeholder(doc, img);
          else img.addEventListener("error", function () { placeholder(doc, img); });
        });
        frame.style.height = doc.documentElement.scrollHeight + "px";
      };
      frame.srcdoc = frameDoc(detail.html || "");
      window.scrollTo(0, 0);
    });
  }

  function openBody(state, row) {
    return request(state.db.transaction([BODY_STORE], "readonly").objectStore(BODY_STORE).get(row.key)).catch(function () {
      return null;
    });
  }

  function showLists() {
    $("reader").hidden = true;
    $("lists").hidden = false;
  }

  load()
    .catch(function () {
      return { db: null, user: null, rows: [] };
    })
    .then(function (state) {
      var later = state.rows
        .filter(function (r) { return r.readLater; })
        .sort(function (a, b) { return String(b.item.publishedAt).localeCompare(String(a.item.publishedAt)); });
      var recent = state.rows
        .filter(function (r) { return !r.readLater && r.openedAt != null; })
        .sort(function (a, b) { return b.openedAt - a.openedAt; })
        .slice(0, MAX_RECENT);
      var host = $("sections");
      if (!later.length && !recent.length) {
        $("intro").textContent = T.none;
        return;
      }
      var open = function (row) {
        location.hash = "a=" + encodeURIComponent(row.id);
      };
      if (later.length) host.appendChild(section(T.later, later, open));
      if (recent.length) host.appendChild(section(T.recent, recent, open));

      var byId = {};
      later.concat(recent).forEach(function (r) { byId[r.id] = r; });
      function route() {
        var m = /^#a=(.+)$/.exec(location.hash);
        var row = m && byId[decodeURIComponent(m[1])];
        if (row) void showArticle(state, row);
        else showLists();
      }
      $("back").addEventListener("click", function () {
        location.hash = "";
      });
      window.addEventListener("hashchange", route);
      route();
    });
})();
