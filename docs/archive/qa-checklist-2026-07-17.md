# QA & Test Checklist — 2026-07-17 work

Everything merged to `main` today, with a manual test checklist. Tick items as you go; note anything that misbehaves.

## Automated verification (already green on `main`)
`pnpm install` ✅ · `prisma:generate` ✅ · `tsc --noEmit` ✅ · `lint` ✅ · `translations:check` (1230 keys, en/de parity) ✅ · `pnpm test` **151/151** ✅ · `next build` ✅ · `test:e2e` axe a11y **3/3** ✅

## What shipped today (20 PRs)
- **Phase 0** (#135–#140): command palette, copy-as-markdown, sanitizer hardening, per-feed reader defaults, axe a11y CI gate.
- **M1** (#141–#144): auto full-text → HTML/Markdown-selectable content + reader rendering.
- **M3** (#145–#147): "Create feed from a web page" builder.
- **M4 slice 1** (#148–#149): AI config-proposal engine (backend + tests; no UI yet).
- **Security & robustness hardening** (#150): full-app audit fixes — see §6.
- **Docs cleanup** (#151): CHANGELOG, roadmap checkboxes, stale docs.
- **Mobile input-focus fix** (#152): text inputs in the Add-feed / feed-settings dialogs were untappable on iOS (no keyboard) — the mobile feed drawer was trapping focus away from the dialog. Fixed.
- **Bug-hunt fixes from live testing** (#153): a real feed (XenForo's RSS, attributed `<category>` tags) crashed the whole sync with `Cannot convert object to primitive value` — fixed. The page→feed builder no longer confidently proposes nav/footer chrome as a candidate on JS-rendered pages — it now correctly falls to "nothing found". Bot-blocked pages (Cloudflare challenges, etc.) now get a clear "this site blocked automated access" message instead of a generic one. Also fixed an SSRF false positive that wrongly rejected some legitimate public sites (192.0.0.0/16 range) as private IPs.

> **To test:** run locally with `pnpm run build && pnpm run start` (or your Docker/Coolify deploy) and open the app in a browser. Everything below is manual UI testing — work top to bottom, tick as you go. Most items are self-contained; where one depends on setup (e.g. a truncated feed), it says so.

---

## 1. Phase 0 — quick wins

### 1.1 Command palette (⌘K / Ctrl-K)
- [ ] Press **⌘K** (mac) / **Ctrl-K** (win/linux) anywhere → palette opens.
- [ ] Type to filter; **Actions** group works: Refresh, Mark all read, Focus search, Add feed, Open settings, Toggle theme, Keyboard shortcuts.
- [ ] **Feeds / Categories / Labels** groups list your items (labels show a colored dot); selecting one navigates to it.
- [ ] "Add feed" from the palette opens the add-feed dialog — and works **a second time** in the same session (this was a fixed bug).
- [ ] **Esc** closes the palette; ⌘K toggles it closed too.

### 1.2 Copy article as Markdown
- [ ] Open an article → toolbar has a **document icon** (desktop) / "Copy as Markdown" in the ⋯ menu (mobile).
- [ ] Click → toast "Copied as Markdown"; paste elsewhere → you get `# Title`, the link, then the body as Markdown.
- [ ] An article with only a link (no body) → copies title + link, no error.

### 1.3 Per-feed reader defaults (F2)
- [ ] Feed settings (edit a feed) → **Behavior** tab → "Reader defaults": Font size / Width / Open original, each with an **Inherit** option.
- [ ] Set a feed's font size to **Large** and width to **Wide**, save → open an article **from that feed** → reader uses large/wide. Open an article from a *different* feed (set to Inherit) → uses your global default.
- [ ] Set "Open original by default = On" for one feed → clicking its articles opens the original in a new tab; other feeds still open the in-app reader.

### 1.4 Sanitizer + mobile (0.1)
- [ ] An article whose source HTML has wide tables/images doesn't blow out the reader width on mobile (inline `width`/`min-width` are stripped).
- [ ] On a narrow phone (or devtools at **320px**): settings tabs scroll instead of clipping; the feed header title truncates and icon buttons don't overflow.

### 1.5 Regression check — things that already existed
- [ ] **Refresh a single feed** via the feed's context menu (right-click / long-press) still works.
- [ ] If you use the **Fever API** with an external client, it still authenticates and syncs.

---

## 2. M1 — Auto full-text → Markdown/HTML

### 2.1 Feed settings — the new controls
- [ ] Edit a feed → **Full Text** tab shows **"Full text mode"** (Off / Automatic / Custom selector) and **"Preferred content format"** (HTML / Markdown). The old raw auto-fetch switch is gone (folded into "mode").

### 2.2 Automatic full-text on a truncated feed
- [ ] Pick a feed that only gives **excerpts/summaries** (truncated). Set **Full text mode = Automatic**, **Preferred format = Markdown**, save.
- [ ] Refresh the feed → open a **newly-synced** article → the reader shows the **full article** (not just the excerpt), rendered cleanly.
- [ ] Repeat with **Preferred format = HTML** on another feed → full text renders as HTML.
- [ ] A feed set to **Off** → articles keep their original feed content (no full-text fetch).

> Note: automatic extraction only runs on **newly synced** articles after you enable it, not retroactively on already-stored ones.

### 2.3 Reader — Markdown rendering + source toggle
- [x] A Markdown-format article renders as rich text (headings, lists, links, code). *Verified — default view on opening an article is rendered; the `</>` toggle correctly switches to raw Markdown source and back.*
- [x] Desktop toolbar has a **`</>` (code) toggle** → switches the body to raw **Markdown source** in a monospace block; toggling back returns to rich view. Switching articles resets to rich view.

> **Maintainer feedback (not a bug, noted for a product decision):** the Markdown source toggle and "Copy as Markdown" were flagged as UI clutter that isn't earning its keep. Left as-is for now — say the word if you want either hidden/removed and I'll do it.

### 2.4 Back-compat (important)
- [ ] A feed that **already had** auto-fetch full text enabled *before* today still fetches full text after the update (it should show as "Custom selector" mode and behave as before). Nothing silently turned off.

---

## 3. M3 — Create a feed from a web page

### 3.1 The happy path
- [x] Sidebar → **Add feed** → third tab **"From web page"**. *Was blocked by a mobile input-focus bug (#152, now fixed) — worth a quick recheck that the URL field is now typeable on your phone.*
- [x] Paste a **listing page** URL that has no RSS → **Find items**. Tested against:
  - `till-freitag.com/blog` (JS-rendered listing — the real post list never reaches our static fetch) → **was** confidently proposing wrong nav/footer-based candidates; **now (#153) correctly returns "nothing found"** instead of misleading candidates. This site will still not produce a working page-feed (that needs the JS-rendering milestone, M5/M7 — out of scope for now) but at least no longer lies about it.
  - `xenforo.com/community/forums/announcements/` (Cloudflare bot-challenge, HTTP 403) → **was** a generic "Could not read that page"; **now (#153)** reports "This site blocked automated access (it may use bot protection like Cloudflare)" — accurate, since this is a real external block, not a FeedFerret bug.
  - **Please retest with a page whose list IS in the static HTML** (a plain WordPress/Ghost/static-site blog index, not a JS single-page app) to confirm the happy path itself — neither of the two tested sites qualifies for M3's in-scope case.
- [ ] You get one or more **ranked candidates**, each showing an item count, sample titles, and a couple of preview items. The best is pre-selected. *(needs a static-HTML test site, see above)*
- [ ] Pick one, adjust the name, **Create feed** → toast success, dialog closes, the new feed appears in the sidebar with its scraped articles.
- [ ] Open a few of its articles → titles/links are correct (links open the real source pages).

### 3.2 Edge cases
- [ ] Paste a **single-article page** (not a list) or a page with no repeating items → friendly "nothing found" empty state pointing to the manual/direct routes (no crash).
- [ ] Paste an invalid / unreachable URL → a clear error message, no crash.
- [ ] A blocked/internal URL (SSRF) is refused with an error (do **not** expect it to fetch localhost/internal addresses).

### 3.3 Persistence / interop
- [ ] The created page-feed **re-scrapes on the normal schedule** (new items appear on later refreshes) and doesn't create duplicates of the same items.
- [ ] **Export OPML** (settings) then **re-import** it → the page-feed comes back with its scraping config intact (type `HTML+XPath`, same selectors).

---

## 4. General smoke / regression
- [ ] Log in / log out works; refreshing while logged in keeps you logged in (no blank feed view).
- [ ] Feed list, unread counts, mark-as-read, star, read-later, search all still work.
- [ ] Categories, labels, and the discovery/add-by-URL tabs still work.
- [ ] Light **and** dark theme both look right on the new UI (feed settings selects, the "From web page" panel, the reader source toggle).
- [ ] Mobile PWA: the new add-feed tab and reader controls are usable and aligned.

---

## 5. M4 — "✨ Let AI set this up" (now clickable — slice 2, PR #155)

Slice 1 (#149) landed the validated backend engine; slice 2 (#155) adds the button. **Requires a configured AI provider** (Settings → AI Summaries — any BYOK provider, or Ollama without a key).

- [ ] **Without** an AI provider configured: Add feed → "From web page" shows only "Find items" — no AI button (correct).
- [ ] **With** AI configured: a secondary **"✨ Let AI set this up"** button appears next to "Find items".
- [ ] Paste a static listing page (blog index) → ✨ button → spinner → a candidate card appears with an **"✨ AI" badge**, item count, sample titles and the model's one-line note → adjust name → **Create feed** → feed appears with scraped articles (same create path as the heuristic flow).
- [ ] Paste a **single-article URL** → ✨ button → info box "This looks like a single article, not a listing" pointing at the site's own feed + automatic full-text (no crash, no bogus candidate).
- [ ] Paste a bot-blocked page (e.g. the XenForo forum URL) → clear "site blocked automated access" error.
- [ ] Hammer the ✨ button repeatedly (>10× within a minute) → friendly rate-limit message, no error crash.
- [ ] The AI note text renders as plain text (no styled/HTML content even if the page tried to inject some).

### 5b. AI full-text selector in feed settings (slice 3, PR #156 — M4 now complete ⭐)
- [ ] Edit a feed that has synced articles → **Full Text** tab → next to the selector field there's a **"✨" propose button** (only with AI configured).
- [ ] Click it → spinner → on success the **selector field fills in**, mode switches to "Custom selector", and a small box shows the AI's note + a plain-text excerpt of what the selector captured. **Nothing is saved yet** — hit Save to apply, or Cancel to discard.
- [ ] A feed with **no synced articles** → friendly "sync the feed first" error, no crash.
- [ ] The shared AI rate limit applies across both ✨ buttons (page→feed + selector) — hammering either exhausts the same 10/min budget.

---

## 6. Security & robustness hardening (#150)

Most of this PR is invisible by design (it closes audit findings). A few items **are** user-observable — verify these; the rest is "nothing should have broken."

### 6.1 Markdown feeds in external clients (was broken, now fixed)
- [ ] Set a feed to **Full text mode = Automatic, Preferred format = Markdown** (§2.2) and let it sync a full-text article.
- [ ] Open that same article through an **external client over the Fever or Google Reader API** (e.g. Reeder, NetNewsWire) → the body shows **rendered HTML** (headings, links), **not** raw `# heading` / `**bold**` text. *(Before this PR, markdown feeds reached external clients as raw text.)*
- [ ] In the FeedFerret web reader the same article still renders correctly (no regression).

### 6.2 Page→feed with awkward class names (was silently dropping candidates)
- [ ] In the "From web page" builder (§3), a listing page whose repeating items use class names containing an **apostrophe** (e.g. `class="it's-featured"`) still returns candidates instead of an empty result.

### 6.3 Deployment behavior change — `AUTH_SECRET` now fails closed ⚠️ *self-hosters read this*
- [ ] **Normal case:** with `AUTH_SECRET` set (as documented in Quick Start), the app starts and works exactly as before.
- [ ] **Misconfiguration case (optional to verify):** starting a **production** deploy with `AUTH_SECRET` **unset** now **refuses to boot** (clear error) instead of silently using an insecure built-in secret. This is intentional — if your existing deploy already sets `AUTH_SECRET` (it should), you'll notice nothing. `next build` still works without it.

### 6.4 Nothing-should-break smoke
- [ ] External API clients (Fever / Google Reader) still authenticate and sync normally.
- [ ] "Fetch full text" (manual button) and automatic full-text (§2) still work; extracted articles render, external `target="_blank"` links still open.

---

## 7. Bug-hunt fixes from live testing (#152, #153)

Found and fixed while testing this batch against real sites/devices. Nothing new to manually test here beyond a quick recheck — automated tests cover the actual regressions (151/151 passing).

### 7.1 Mobile: text inputs in Add-feed / feed-settings dialogs (#152)
- [ ] On your phone, open **Add feed** (any tab) and tap the URL/text field → keyboard now appears and you can type. *(Root cause: the mobile feed drawer was trapping focus away from dialogs rendered on top of it.)*
- [ ] Note: the feed drawer no longer dismisses on tapping outside it or locks background scroll — it still closes via drag-down or picking a feed. Flag if this feels wrong; it's an easy follow-up either way.

### 7.2 A previously-crashing real feed now syncs (#153)
- [ ] If you add `https://xenforo.com/community/forums/announcements/index.rss` as a **regular RSS feed** (not the page-scrape "From web page" flow), it now syncs successfully instead of crashing with `Cannot convert object to primitive value`. *(Any RSS feed with attributed `<category>` tags — not just this one — was affected.)*

### 7.3 Page→feed no longer proposes wrong candidates on JS-rendered pages (#153)
- [ ] See §3.1 above — `till-freitag.com/blog` now correctly shows "nothing found" instead of confidently wrong candidates.

---

## Known limitations (by design — not bugs)
- **M3 suggestions are heuristic.** On messy/unusual pages the top candidate may not be perfect — that's expected; the AI proposal (M4, engine landed, UI pending) will improve this. The manual Scout Studio (feed settings) remains the power-user fallback.
- **JS-only pages** (content rendered client-side) won't yield items from the page→feed builder yet (needs the heavy-render connectors, a later milestone).
- **a11y color-contrast** is guaranteed at the design-token level; axe's automated contrast check is disabled because it mis-reads our oklch tokens (all other WCAG checks run in CI). Authenticated-page axe coverage + a 200%-zoom pass are still pending.
- **AI config proposal (M4)** — the "✨ let AI set this up" flow — is **in progress**: the validation engine is merged (#149), but the user-facing button/flow (slice 2) is not built yet.
- **Log noise you can ignore:** `Fetch failed: 403` / private-IP-block / `AbortError` entries in the server log for OTHER feeds you've subscribed to are almost always the source site's own bot protection, an actually-unreachable host, or a genuine timeout — not a FeedFerret bug. Only worth reporting if a *specific* feed you'd expect to work keeps failing.
- **Flagged, not yet root-caused:** a one-off server log entry — `TypeError: Cannot create property 'border-width' on string 'var(--border-width, 1px)'` — looks like it originates from a dependency (possibly the Tailwind v4 CSS engine or Auth.js's built-in error/verify-request page template) rather than our own code, and couldn't be reproduced in this environment (no live browser here). If you see this again, note what you were doing right before it and I'll dig further.

## How to report back
For anything that misbehaves, note: which section, the feed/article URL, what you expected vs. saw, and browser/device. Screenshots help. I'll triage and fix.
