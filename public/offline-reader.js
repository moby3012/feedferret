/* Offline reader for the static offline page: lists and opens the article bodies the app stored in IndexedDB
 * (features/offline/store.ts). Read-only, no framework. Bodies are the server-sanitized HTML of
 * the app's reader; they render inside a script-less sandboxed iframe on top of that.
 *
 * Authorization policy — the stored `session` record is NOT a login:
 *  - Online (navigator.onLine): GET /api/app/session first (2.5 s budget). 401 → everything is cleared and nothing
 *    is shown; another account signed in (userId differs) → cleared; same account → `verifiedAt` is refreshed.
 *    Unreachable (timeout / 5xx / network) says nothing and falls through to the expiry rule.
 *  - Expiry: data whose `verifiedAt` is older than MAX_AGE_MS (the 30-day session lifetime), missing, or from the
 *    future (clock turned back) is not shown and is cleared — also when offline and nothing can be verified.
 *  - Clearing is bound to what was judged: the store is only wiped inside a transaction that re-reads the session
 *    record and finds the same (userId, gen) — a verdict that arrives after another account claimed the DB never
 *    touches the new owner's data (same gate as the app's own writes, features/offline/store.ts).
 *  - A page is never trusted for longer than it was checked: the session is re-validated on `pageshow` (BFCache
 *    restores included), when the tab becomes visible, on the app's cross-tab session signals, and — against the
 *    DB, atomically with the read — before any body is opened. When the session is gone / replaced / expired the
 *    rendered DOM (lists, title, the article iframe) is emptied at once, not only the DB. */
(function () {
  "use strict";
  document.getElementById("retry").addEventListener("click", function () { location.reload(); });

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

    var SIGNAL_CHANNEL = "feedferret-offline-session"; // keep in sync with features/offline/session.ts
  var SIGNAL_KEY = "feedferret:offline-session-signal";

  function sameSession(a, b) {
    return !!a && !!b && a.userId === b.userId && a.gen === b.gen;
  }

  /**
   * Drops everything the app stored (what logout does) — but only if the DB still belongs to the session that was
   * judged: the (userId, gen) comparison happens INSIDE the clearing transaction. For the expiry path the record
   * must also still be expired (the app may have re-verified it meanwhile).
   * Resolves "cleared" | "gone" (nothing stored any more) | "stale" (somebody else owns the DB now: untouched) | "error".
   */
  function clearStoreIf(db, session, why) {
    if (!db || !session) return Promise.resolve("gone");
    return new Promise(function (resolve) {
      var outcome = "error";
      try {
        var tx = db.transaction([INDEX_STORE, BODY_STORE, META_STORE], "readwrite");
        var get = tx.objectStore(META_STORE).get(SESSION_KEY);
        get.onsuccess = function () {
          var cur = get.result;
          if (!cur) {
            outcome = "gone";
          } else if (!sameSession(cur, session) || (why === "expired" && judge(cur, Date.now()) !== "expired")) {
            outcome = "stale";
          } else {
            tx.objectStore(INDEX_STORE).clear();
            tx.objectStore(BODY_STORE).clear();
            tx.objectStore(META_STORE).clear();
            outcome = "cleared";
          }
        };
        tx.oncomplete = function () {
          resolve(outcome);
        };
        tx.onerror = tx.onabort = function () {
          resolve("error");
        };
      } catch (e) {
        resolve("error");
      }
    });
  }

  /** The server confirmed the session just now. Resolves false when the session was replaced meanwhile. */
  function markVerified(db, session) {
    return new Promise(function (resolve) {
      var matched = false;
      try {
        var tx = db.transaction([META_STORE], "readwrite");
        var meta = tx.objectStore(META_STORE);
        var get = meta.get(SESSION_KEY);
        get.onsuccess = function () {
          var cur = get.result;
          if (sameSession(cur, session)) {
            matched = true;
            cur.verifiedAt = Date.now();
            meta.put(cur, SESSION_KEY);
          }
        };
        tx.oncomplete = function () {
          resolve(matched);
        };
        tx.onerror = tx.onabort = function () {
          resolve(matched);
        };
      } catch (e) {
        resolve(matched);
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

  /**
   * Reads the store under the policy above. Resolves to {db, session, rows, message}.
   * `onLocal(state)` runs right after the local read, before any network wait, so a caller can react to a DB
   * that already says "gone / replaced / expired" without waiting for the server.
   */
  function authorize(onLocal, attempt) {
    attempt = attempt || 0;
    return load()
      .catch(function () {
        return { db: null, session: null, verdict: "none", rows: [] };
      })
      .then(function (state) {
        if (onLocal) onLocal(state);
        var result = function (rows, message) {
          return { db: state.db, session: message ? null : state.session, rows: rows, message: message };
        };
        // The DB changed owner between our read and our write: judge again from the top, once.
        var retryOr = function (message) {
          return attempt < 1 ? authorize(onLocal, attempt + 1) : result([], message);
        };
        if (state.verdict === "none") return result([], null);
        if (state.verdict === "expired") {
          return clearStoreIf(state.db, state.session, "expired").then(function (outcome) {
            return outcome === "stale" ? retryOr("expired") : result([], "expired");
          });
        }
        return verifyOnline(state.session).then(function (verdict) {
          if (verdict === "unauthorized" || verdict === "mismatch") {
            return clearStoreIf(state.db, state.session, "revoked").then(function (outcome) {
              return outcome === "stale" ? retryOr("signedOut") : result([], "signedOut");
            });
          }
          if (verdict === "ok") {
            return markVerified(state.db, state.session).then(function (matched) {
              return matched ? result(state.rows, null) : retryOr("signedOut");
            });
          }
          return result(state.rows, null);
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

  // The sandbox has an opaque origin: CORP same-origin images cannot load
  // there directly. Read only already-cached proxy bytes in the authorized
  // parent, then embed data URLs; never relax sandbox permissions or CORP.
  async function offlineMediaHtml(html) {
    if (!html.includes("/api/media?") || !window.caches) return html;
    var template = document.createElement("template");
    template.innerHTML = html;
    async function embed(raw) {
      try {
        var url = new URL(raw, location.origin);
        if (url.origin !== location.origin || url.pathname !== "/api/media") return raw;
        var cached = await caches.match(url.href);
        if (!cached || !cached.ok) return "";
        var blob = await cached.blob();
        return await new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { resolve(""); };
          reader.readAsDataURL(blob);
        });
      } catch { return ""; }
    }
    for (var el of template.content.querySelectorAll("img, picture source, video[poster]")) {
      for (var attr of ["src", "poster"]) {
        if (el.hasAttribute(attr)) el.setAttribute(attr, await embed(el.getAttribute(attr)));
      }
      if (el.hasAttribute("srcset")) {
        // Render-time proxy output contains encoded URL tokens + descriptors.
        var candidates = el.getAttribute("srcset").split(", ");
        var result = [];
        for (var candidate of candidates) {
          var parts = candidate.split(" ");
          var embedded = await embed(parts[0]);
          if (embedded) result.push(embedded + (parts[1] ? " " + parts[1] : ""));
        }
        el.setAttribute("srcset", result.join(", "));
      }
    }
    return template.innerHTML;
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

  // What the page currently shows. `scope` = the (userId, gen) the rendered lists were read for (null = nothing
  // sensitive in the DOM); `shown` = false while the "server is slow" choice is pending (lists stay hidden).
  var view = { scope: null, locked: null, db: null, byId: {}, shown: true, epoch: 0, ready: Promise.resolve() };

  /** Empties everything rendered from the store — lists, article title/meta and the article iframe — right now. */
  function wipeDom(clearHash) {
    view.scope = null;
    view.byId = {};
    $("sections").textContent = "";
    $("r-title").textContent = "";
    $("r-meta").textContent = "";
    var frame = $("body");
    frame.onload = null;
    frame.title = "";
    frame.style.height = "";
    frame.srcdoc = "";
    frame.removeAttribute("srcdoc");
    $("reader").hidden = true;
    if (view.shown) $("lists").hidden = false;
    if (clearHash && /^#a=/.test(location.hash)) {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch (e) {
        /* keep the hash */
      }
    }
  }

  /** Locked state: no stored content in the DOM, only the message (and the sign-in link when the session ended). */
  function lock(message) {
    wipeDom(true);
    view.locked = message;
    $("intro").textContent = message ? T[message] : T.none;
    $("login").hidden = message !== "signedOut";
  }

  function route() {
    var m = /^#a=(.+)$/.exec(location.hash);
    var row = view.shown && view.scope && m && view.byId[decodeURIComponent(m[1])];
    if (row) void showArticle(row);
    else showLists();
  }

  function showLists() {
    $("reader").hidden = true;
    $("lists").hidden = !view.shown;
  }

  /** The body of `row`, read in ONE transaction together with the session record: only if it still is the rendered session. */
  function openBody(row) {
    return new Promise(function (resolve) {
      var scope = view.scope;
      var db = view.db;
      if (!scope || !db) return resolve({ ok: false });
      var out = { ok: false, detail: null };
      try {
        var tx = db.transaction([META_STORE, BODY_STORE], "readonly");
        var get = tx.objectStore(META_STORE).get(SESSION_KEY);
        get.onsuccess = function () {
          var cur = get.result;
          if (!sameSession(cur, scope) || judge(cur, Date.now()) !== "fresh") return;
          out.ok = true;
          var body = tx.objectStore(BODY_STORE).get(row.key);
          body.onsuccess = function () {
            out.detail = body.result || null;
          };
        };
        tx.oncomplete = function () {
          resolve(out);
        };
        tx.onerror = tx.onabort = function () {
          resolve({ ok: out.ok, detail: null });
        };
      } catch (e) {
        resolve({ ok: false });
      }
    });
  }

  function showArticle(row) {
    var scope = view.scope;
    return openBody(row).then(async function (res) {
      if (scope !== view.scope) return; // locked / re-rendered while the body was read
      if (!res.ok) {
        // The DB no longer says this session is valid: lock now, then find out why.
        lock("signedOut");
        void refresh();
        return;
      }
      var detail = res.detail;
      $("lists").hidden = true;
      $("reader").hidden = false;
      $("r-title").textContent = row.item.displayTitle || row.item.title;
      $("r-meta").textContent = [row.item.canonicalFeedName, row.item.author, fmtDate(row.item.publishedAt)].filter(Boolean).join(" · ");
      var frame = $("body");
      frame.title = row.item.title;
      if (!detail) {
        frame.srcdoc = frameDoc('<p class="missing">' + T.bodyMissing + "</p>");
      } else {
        frame.onload = function () {
          if (view.scope !== scope) return;
          var doc = frame.contentDocument;
          if (!doc) return;
          Array.prototype.forEach.call(doc.images, function (img) {
            if (img.complete && img.naturalWidth === 0) placeholder(doc, img);
            else img.addEventListener("error", function () { placeholder(doc, img); });
          });
          frame.style.height = doc.documentElement.scrollHeight + "px";
        };
        var offlineHtml = await offlineMediaHtml(detail.html || "");
        if (view.scope !== scope) return;
        frame.srcdoc = frameDoc(offlineHtml);
        window.scrollTo(0, 0);
      }
      // Re-check against the server in the background (the local check above already passed).
      void refresh();
    });
  }

  function renderLists(state) {
    var later = state.rows
      .filter(function (r) { return r.readLater; })
      .sort(function (a, b) { return String(b.item.publishedAt).localeCompare(String(a.item.publishedAt)); });
    var recent = state.rows
      .filter(function (r) { return !r.readLater && r.openedAt != null; })
      .sort(function (a, b) { return b.openedAt - a.openedAt; })
      .slice(0, MAX_RECENT);
    wipeDom(!!view.scope); // a hash left over from another session's article must not be followed
    view.locked = null;
    $("login").hidden = true;
    if (!later.length && !recent.length) {
      $("intro").textContent = T.none;
      return;
    }
    $("intro").textContent = T.intro;
    view.scope = state.session ? { userId: state.session.userId, gen: state.session.gen } : null;
    view.db = state.db;
    var host = $("sections");
    var open = function (row) {
      location.hash = "a=" + encodeURIComponent(row.id);
    };
    if (later.length) host.appendChild(section(T.later, later, open));
    if (recent.length) host.appendChild(section(T.recent, recent, open));
    later.concat(recent).forEach(function (r) { view.byId[r.id] = r; });
    route();
  }

  /** Shows the outcome of an authorization pass. Same session as already rendered → the DOM stays as it is. */
  function apply(state) {
    if (state.message) return lock(state.message);
    if (view.scope && sameSession(view.scope, state.session)) return;
    // The store was emptied under a page that showed (or had just locked) something: say so, do not claim "nothing stored".
    if (!state.session && (view.scope || view.locked)) return lock(view.locked || "signedOut");
    renderLists(state);
  }

  /**
   * (Re-)validates the session and updates the page. Every trigger below runs it; the newest run wins.
   * Locally detectable revocation / replacement / expiry empties the DOM before the network is asked.
   */
  function refresh() {
    var epoch = ++view.epoch;
    var run = authorize(function (state) {
      if (epoch !== view.epoch || !view.scope) return;
      if (state.verdict !== "fresh" || !sameSession(view.scope, state.session)) {
        lock(state.verdict === "expired" ? "expired" : "signedOut");
      }
    }).then(function (state) {
      if (epoch === view.epoch) apply(state);
    });
    view.ready = run;
    return run;
  }

  $("back").addEventListener("click", function () {
    location.hash = "";
  });
  window.addEventListener("hashchange", route);

  // Re-validation triggers. A page restored from the BFCache (`pageshow` with persisted=true) or brought back to the
  // front still shows whatever it showed when it was frozen; the session may have ended or changed owner since.
  var firstPageshow = true;
  window.addEventListener("pageshow", function (event) {
    if (firstPageshow && !event.persisted) {
      firstPageshow = false; // the load that is running right now already authorizes
      return;
    }
    firstPageshow = false;
    if (event.persisted) document.body.setAttribute("data-checking", "");
    refresh().then(function () {
      document.body.removeAttribute("data-checking");
    });
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") void refresh();
  });
  // The app tells every tab when the account / session changes (features/offline/session.ts).
  try {
    var channel = new BroadcastChannel(SIGNAL_CHANNEL);
    channel.onmessage = function () {
      void refresh();
    };
  } catch (e) {
    /* no BroadcastChannel: the storage event below covers it */
  }
  window.addEventListener("storage", function (event) {
    if (event.key === SIGNAL_KEY && event.newValue) void refresh();
  });

  // The service worker flags a page it showed because the server hangs (not because the connection failed):
  // the visitor chooses between the offline view and a fresh try ("Keep waiting" = reload = new navigation).
  var slow = document.body.getAttribute("data-mode") === "slow";
  if (slow) {
    view.shown = false;
    $("lists").hidden = true;
    $("slow").hidden = false;
    $("wait").addEventListener("click", function () {
      location.reload();
    });
    $("show-offline").addEventListener("click", function () {
      $("slow").hidden = true;
      view.shown = true;
      $("lists").hidden = false;
      view.ready.then(function () {
        if (view.shown) route();
      });
    });
  }
  void refresh();
})();
