# QA & Test Checklist — 2026-07-17 work

Everything merged to `main` today, with a manual test checklist. Tick items as you go; note anything that misbehaves.

## Automated verification (already green on `main`)
`pnpm install` ✅ · `prisma:generate` ✅ · `tsc --noEmit` ✅ · `lint` ✅ · `translations:check` (1230 keys, en/de parity) ✅ · `pnpm test` **127/127** ✅ · `next build` ✅ · `test:e2e` axe a11y **3/3** ✅

## What shipped today (15 PRs)
- **Phase 0** (#135–#140): command palette, copy-as-markdown, sanitizer hardening, per-feed reader defaults, axe a11y CI gate.
- **M1** (#141–#144): auto full-text → HTML/Markdown-selectable content + reader rendering.
- **M3** (#145–#147): "Create feed from a web page" builder.

> Run locally with `pnpm run build && pnpm run start` (or your Docker/Coolify deploy). All of the below is manual UI testing.

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
- [ ] A Markdown-format article renders as rich text (headings, lists, links, code).
- [ ] Desktop toolbar has a **`</>` (code) toggle** → switches the body to raw **Markdown source** in a monospace block; toggling back returns to rich view. Switching articles resets to rich view.

### 2.4 Back-compat (important)
- [ ] A feed that **already had** auto-fetch full text enabled *before* today still fetches full text after the update (it should show as "Custom selector" mode and behave as before). Nothing silently turned off.

---

## 3. M3 — Create a feed from a web page

### 3.1 The happy path
- [ ] Sidebar → **Add feed** → third tab **"From web page"**.
- [ ] Paste a **listing page** URL that has no RSS (e.g. a blog index, a news category page, a forum board) → **Find items**.
- [ ] You get one or more **ranked candidates**, each showing an item count, sample titles, and a couple of preview items. The best is pre-selected.
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

## Known limitations (by design — not bugs)
- **M3 suggestions are heuristic.** On messy/unusual pages the top candidate may not be perfect — that's expected; the AI proposal (M4, not built yet) will improve this. The manual Scout Studio (feed settings) remains the power-user fallback.
- **JS-only pages** (content rendered client-side) won't yield items from the page→feed builder yet (needs the heavy-render connectors, a later milestone).
- **a11y color-contrast** is guaranteed at the design-token level; axe's automated contrast check is disabled because it mis-reads our oklch tokens (all other WCAG checks run in CI). Authenticated-page axe coverage + a 200%-zoom pass are still pending.
- **AI config proposal (M4)** — the "✨ let AI set this up" flow — is **not built yet**; it's the planned next milestone.

## How to report back
For anything that misbehaves, note: which section, the feed/article URL, what you expected vs. saw, and browser/device. Screenshots help. I'll triage and fix.
