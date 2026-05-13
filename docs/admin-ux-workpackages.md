# Admin UX follow-up workpackages

This document captures larger product work that should not be rushed into small bug-fix patches. Each item is intended to become its own implementation PR with UI design, schema changes, tests, and deployment notes.

---

## 1. Guided FreshRSS XPath / full-text extraction assistant

### Problem

FeedFerret already stores FreshRSS-compatible XPath, JSON DotNotation, HTTP/cURL, and full-text extraction settings, but the current UI exposes these as raw technical fields. This is too hard for normal users:

- Users do not know whether a source needs RSS, JSON, HTML+XPath, or full-text extraction.
- Users cannot easily inspect the fetched HTML/XML/JSON.
- Users have to know selectors before they can test.
- Failures are unclear: no match, blocked by SSRF, bad selector, truncated content, wrong item boundary, etc.

### Goal

Build an assistant that guides the user from a problematic feed/site URL to a working extraction configuration.

### Proposed UX flow

1. **Start**
   - Entry point in Feed Settings → `Extraction Assistant`.
   - User enters:
     - Feed URL or site URL.
     - Optional example article URL.
     - Desired mode: “Get full article text” vs “Create feed from page”.

2. **Fetch and diagnose**
   - Fetch the RSS/Atom/JSON/HTML safely with existing SSRF controls.
   - Show detected content type, final URL after redirects, byte size, status code.
   - Detect likely source type:
     - RSS/Atom
     - JSON Feed
     - Generic JSON
     - HTML page needing XPath
     - XML page needing XPath

3. **Preview candidates**
   - For full-text extraction:
     - Auto-detect candidates using `article`, `main`, `[role=main]`, `.entry-content`, `.post-content`, etc.
     - Rank by text length, paragraph count, link density, and boilerplate ratio.
   - For XPath feed creation:
     - Suggest item containers.
     - Suggest title, URL, author, timestamp, image, content selectors.
   - Show side-by-side:
     - Raw source excerpt.
     - Extracted text/content preview.
     - Candidate selector.

4. **Refine**
   - Allow user to add remove-selectors (`.ads`, `.sidebar`, `.comments`).
   - Allow changing item selector and field selectors.
   - Re-run preview instantly.
   - Show validation warnings:
     - “Only 120 chars extracted”
     - “No links found”
     - “All items have same URL”
     - “Timestamp cannot be parsed”

5. **AI assist, optional BYOK**
   - If user has AI configured:
     - Send sanitized source snippets, not secrets.
     - Ask model to propose CSS/XPath/JSON selectors.
     - Present AI suggestions as editable drafts.
   - Never auto-save AI output without user confirmation.
   - Include “Explain why this selector was chosen”.

6. **Save**
   - Save into existing feed fields:
     - `sourceType`
     - `scraperConfig`
     - `httpOptions`
     - `fullTextSelector`
     - `fullTextRemoveSelectors`
     - `fullTextConditions`
     - `autoFetchFullText`
   - Trigger optional test sync.

### Backend requirements

- Add preview endpoints/server actions that return structured diagnostics:
  - fetch metadata
  - detected source type
  - candidate selectors
  - extracted sample items
  - warnings/errors
- Reuse existing `fetchTextWithSsrfProtection`.
- Keep response size bounded; never return huge raw pages.
- Store no fetched HTML unless explicitly needed for debug mode.

### Testing

- Unit tests for selector candidate ranking.
- Integration tests with fixture HTML, XML, JSON, RSS, Atom, JSON Feed.
- SSRF regression tests.
- UI tests:
  - successful full-text setup
  - failed selector
  - AI suggestions disabled when no AI provider is configured
  - AI suggestions shown when configured

### Open decisions

- Whether to support visual element picking in an iframe/sandbox.
- How much raw HTML to expose to the browser safely.
- Whether AI prompts should live server-side only.

---

## 2. Instance branding customization

Status: baseline implemented. Admins can set the instance name and upload/reset a small DB-stored sidebar icon in Server Management → Instance. Future iterations can add theming and file-backed uploads.

### Goal

Allow admins to replace the sidebar brand with:

- Instance name from Server Settings.
- Custom uploaded icon/logo.

### Proposed scope

- Extend `GlobalSettings` with:
  - `instanceIconDataUrl` or file-backed `instanceIconPath`.
  - Optional `instanceBrandColor`.
- Add Server Management → Instance controls:
  - Upload icon.
  - Reset to FeedFerret logo.
  - Preview in sidebar header.
- Sidebar should load public branding via a small public endpoint, e.g. `/api/instance`.

### Notes

- For Docker/self-hosting, storing a small data URL in DB is simplest.
- For larger files, use `/app/data/uploads` with volume persistence.
- Enforce MIME/type/size validation.

---

## 3. Admin-customizable starter packs

Status: baseline implemented. Admins can edit packs and feeds in Server Management → Starter Packs. Future iterations can add ordering drag-and-drop, OPML import into packs, and richer validation.

### Problem

Starter packs are currently static OPML files in `public/starter-opml`. Admins cannot edit them without changing the repo.

### Goal

Allow admins to create, edit, remove, and reorder starter packs and starter-pack feeds from Server Management.

### Proposed schema

- `StarterPack`
  - `id`
  - `name`
  - `description`
  - `order`
  - `enabled`
  - `createdAt`
  - `updatedAt`
- `StarterPackFeed`
  - `id`
  - `packId`
  - `title`
  - `xmlUrl`
  - `htmlUrl`
  - `category`
  - `order`

### UX

- Server Management → Starter Packs tab.
- Admin can:
  - Add pack.
  - Add/edit/remove feeds.
  - Import OPML into a pack.
  - Export pack as OPML.
  - Disable pack without deleting it.
- Sidebar reads enabled packs from API.

### Migration plan

1. Seed DB starter packs from existing static OPML files on first run.
2. Keep static files as fallback.
3. Later remove static-only logic.

### Testing

- Pack import creates feeds.
- Duplicate feeds update rather than fail.
- Empty packs are hidden or shown as disabled.
- Postgres nullable category edge cases covered.

---

## 4. Unified settings shell UX

Status: partial. Feed Management and Server Management now use a narrower settings-style modal shell. A full shared component extraction remains future work.

### Problem

User Settings, Feed Management, and Server Management use different presentation patterns. User Settings currently feels better and should become the common UX direction.

### Goal

Create one shared settings shell component:

- Consistent header.
- Consistent tabs/navigation.
- Consistent scroll behavior.
- Consistent footer actions.
- Works as page and modal/drawer.

### Proposed components

- `SettingsShell`
- `SettingsSection`
- `SettingsRow`
- `SettingsModal`
- `SettingsTabs`

### Acceptance criteria

- Feed Management and Server Management no longer implement their own modal chrome.
- All tab bodies scroll independently.
- Mobile layout uses drawer/full-screen modal.
- Desktop layout matches User Settings card/section style.
