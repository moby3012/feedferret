/* Offline reader for the static offline page: lists and opens the article bodies the app stored in IndexedDB
 * (features/offline/store.ts). Read-only, no framework. Bodies are the server-sanitized HTML of
 * the app's reader; they render inside a script-less sandboxed iframe on top of that.
 *
 * Authorization policy — the stored `session` record is NOT a login:
 *  - Online (navigator.onLine): GET /api/app/session first (2.5 s budget). 401 → everything is cleared and nothing
 *    is shown; another account signed in (userId differs) → cleared; same account → `verifiedAt` is refreshed.
 *    Unreachable (timeout / 5xx / network) says nothing and falls through to the expiry rule.
 *  - Expiry: data whose `verifiedAt` is older than MAX_AGE_MS (the 30-day session lifetime), missing, or from the
 *    future (clock turned back) is not shown and is cleared — also when offline and nothing can be verified. */
(function () {
  "use strict";

  // Keep in sync with features/offline/store.ts (tests/features/offline-reader-contract.test.ts checks it).
  var DB_NAME = "feedferret-offline";
  var DB_VERSION = 1;
  var INDEX_STORE = "index";
  var BODY_STORE = "bodies";
  var META_STORE = "meta";
  var SESSION_KEY = "session";
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var CLOCK_SKEW_MS = 5 * 60 * 1000;
  var VERIFY_TIMEOUT_MS = 2500;
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
        expired: "Die gespeicherten Offline-Daten sind abgelaufen: Die Sitzung wurde zu lange nicht mit dem Server bestätigt. Verbinde dich und melde dich an.",
        signedOut: "Deine Sitzung ist nicht mehr gültig. Die Offline-Daten wurden von diesem Gerät gelöscht.",
        login: "Anmelden",
        slow: "Der Server antwortet langsam. Du kannst weiter warten oder die Offline-Ansicht öffnen.",
        wait: "Weiter warten",
        showOffline: "Offline-Ansicht",
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
        expired: "The stored offline data has expired: the server has not confirmed your session for too long. Connect and sign in.",
        signedOut: "Your session is no longer valid. The offline data was removed from this device.",
        login: "Sign in",
        slow: "The server is answering slowly. You can keep waiting or open the offline view.",
        wait: "Keep waiting",
        showOffline: "Offline view",
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
  $("login").textContent = T.login;
  $("slow-text").textContent = T.slow;
  $("wait").textContent = T.wait;
  $("show-offline").textContent = T.showOffline;

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

  /** The stored session record if it may still be shown; otherwise why not. */
  function judge(session, now) {
    if (!session || !session.userId) return "none";
    var at = session.verifiedAt;
    if (typeof at !== "number" || !isFinite(at)) return "expired";
    if (now - at > MAX_AGE_MS || at - now > CLOCK_SKEW_MS) return "expired";
    return "fresh";
  }

  function load() {
    return openDb().then(function (db) {
      if (!db) return { db: null, session: null, verdict: "none", rows: [] };
      var tx = db.transaction([META_STORE, INDEX_STORE], "readonly");
      return request(tx.objectStore(META_STORE).get(SESSION_KEY)).then(function (session) {
        var verdict = judge(session, Date.now());
        if (verdict !== "fresh") return { db: db, session: session || null, verdict: verdict, rows: [] };
        return request(tx.objectStore(INDEX_STORE).index("byUser").getAll(IDBKeyRange.only(session.userId))).then(function (rows) {
          return { db: db, session: session, verdict: verdict, rows: rows };
        });
      });
    });
  }

  /** Drops everything the app stored (what logout does): rows, bodies and the session record. */
  function clearStore(db) {
    if (!db) return Promise.resolve();
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction([INDEX_STORE, BODY_STORE, META_STORE], "readwrite");
        tx.objectStore(INDEX_STORE).clear();
        tx.objectStore(BODY_STORE).clear();
        tx.objectStore(META_STORE).clear();
        tx.oncomplete = tx.onerror = tx.onabort = function () {
          resolve();
        };
      } catch (e) {
        resolve();
      }
    });
  }

  /** The server confirmed the session just now (refresh `verifiedAt` — unless the session was replaced meanwhile). */
  function markVerified(db, session) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction([META_STORE], "readwrite");
        var meta = tx.objectStore(META_STORE);
        var get = meta.get(SESSION_KEY);
        get.onsuccess = function () {
          var cur = get.result;
          if (cur && cur.gen === session.gen && cur.userId === session.userId) {
            cur.verifiedAt = Date.now();
            meta.put(cur, SESSION_KEY);
          }
        };
        tx.oncomplete = tx.onerror = tx.onabort = function () {
          resolve();
        };
      } catch (e) {
        resolve();
      }
    });
  }

  /** "ok" | "unauthorized" | "mismatch" | "unreachable" | "offline" */
  function verifyOnline(session) {
    return new Promise(function (resolve) {
      if (navigator.onLine === false || !window.fetch) return resolve("offline");
      var controller = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        resolve("unreachable");
      }, VERIFY_TIMEOUT_MS);
      fetch("/api/app/session", { cache: "no-store", credentials: "same-origin", signal: controller ? controller.signal : undefined })
        .then(function (res) {
          clearTimeout(timer);
          if (res.status === 401) return resolve("unauthorized");
          if (!res.ok) return resolve("unreachable");
          return res.json().then(function (body) {
            resolve(body && body.userId === session.userId ? "ok" : "mismatch");
          });
        })
        .catch(function () {
          clearTimeout(timer);
          resolve("unreachable");
        });
    });
  }

  /** Reads the store under the policy above. Resolves to {db, rows, message}. */
  function authorize() {
    return load()
      .catch(function () {
        return { db: null, session: null, verdict: "none", rows: [] };
      })
      .then(function (state) {
        if (state.verdict === "none") return { db: state.db, rows: [], message: null };
        if (state.verdict === "expired") {
          return clearStore(state.db).then(function () {
            return { db: state.db, rows: [], message: "expired" };
          });
        }
        return verifyOnline(state.session).then(function (verdict) {
          if (verdict === "unauthorized" || verdict === "mismatch") {
            return clearStore(state.db).then(function () {
              return { db: state.db, rows: [], message: "signedOut" };
            });
          }
          if (verdict === "ok") markVerified(state.db, state.session);
          return { db: state.db, rows: state.rows, message: null };
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

  function render(state) {
    var later = state.rows
      .filter(function (r) { return r.readLater; })
      .sort(function (a, b) { return String(b.item.publishedAt).localeCompare(String(a.item.publishedAt)); });
    var recent = state.rows
      .filter(function (r) { return !r.readLater && r.openedAt != null; })
      .sort(function (a, b) { return b.openedAt - a.openedAt; })
      .slice(0, MAX_RECENT);
    var host = $("sections");
    if (state.message) {
      $("intro").textContent = T[state.message];
      if (state.message === "signedOut") $("login").hidden = false;
      return;
    }
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
  }

  // The service worker flags a page it showed because the server hangs (not because the connection failed):
  // the visitor chooses between the offline view and waiting for the real response.
  var slow = document.body.getAttribute("data-mode") === "slow";
  var authorized = authorize();
  if (slow) {
    $("lists").hidden = true;
    $("slow").hidden = false;
    $("wait").addEventListener("click", function () {
      location.reload();
    });
    $("show-offline").addEventListener("click", function () {
      $("slow").hidden = true;
      $("lists").hidden = false;
      authorized.then(render);
    });
  } else {
    authorized.then(render);
  }
})();
