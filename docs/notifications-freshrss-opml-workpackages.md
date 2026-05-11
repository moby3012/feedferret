# Notifications + FreshRSS Extended OPML Arbeitspakete

## Entscheidungen

- Notification-Frequenz ist pro User wählbar.
- Default ist `immediate`; falls Ressourcen/Spam problematisch werden, kann auf `hourly` gewechselt werden.
- Browser-Push-Payloads dürfen Artikeltitel enthalten.
- FreshRSS cURL/HTTP-Optionen werden funktional nachgebaut, nicht nur importiert/exportiert.
- Dynamic OPML (`frss:opmlUrl`) wird beim Import automatisch aktiviert und später synchronisiert.
- Artikel-Dedupe darf von `userId + link` auf feedbezogene Dedupe-Keys migriert werden.

## Paket 1: Foundations / Schema / Dependencies

- Web-Push Dependencies + Key-Generation Script.
- VAPID Env-Dokumentation.
- Prisma-Modelle/Felder für Push, FreshRSS OPML, Source Types, Dedupe.
- Migration + Prisma Client Generate.
- Checks: `pnpm install`, `pnpm exec prisma generate`, `pnpm exec tsc --noEmit`, `pnpm run lint`, optional `pnpm run build`.
- Commit: `feat: add notification and freshrss schema foundations`.

## Paket 2: Push Notifications Backend

- Push-Sender, Notification Scheduler/Queue.
- API: subscribe, unsubscribe, status, test.
- Sync-Integration für neue Artikel.
- Checks + Commit: `feat: add web push backend`.

## Paket 3: Push Notifications Frontend + Service Worker

- Service Worker Push + Notification Click + Badging.
- Settings UI: Enable/disable/test, Frequency, Privacy toggle, Feed-Auswahl.
- React Query Hooks.
- Checks + Commit: `feat: add browser notification settings`.

## Paket 4: FreshRSS Extended OPML Import/Export

- Parser/Exporter für `xmlns:frss="https://freshrss.org/opml"`.
- FreshRSS Source Types und alle dokumentierten `frss:*` Attribute.
- Dynamic OPML Category Import.
- Roundtrip Tests mit FreshRSS Beispiel.
- Checks + Commit: `feat: support freshrss extended opml import export`.

## Paket 5: FreshRSS Fetcher / Scraper Support

- RSS/Atom, JSONFeed, JSON+DotNotation, HTML/XML+XPath, HTML+XPath+JSON.
- cURL-kompatible HTTP-Optionen.
- Unicity/Dedupe-Strategien.
- Full-content/filter/read rules Integration.
- Checks + Commit: `feat: add freshrss source types and fetch options`.

## Paket 6: Dynamic OPML + SSRF-Schutz

- Remote OPML Kategorien automatisch aktualisieren.
- HTTP/HTTPS Allowlist, private IP Block, Timeout, Size Limit, Redirect Checks.
- Checks + Commit: `feat: add dynamic opml sync`.

## Paket 7: Feed UI FreshRSS Optionen

- Feed Edit Dialog Tabs/Inputs für Source, XPath/JSON, cURL, Priority/Unicity, Filters.
- Import Report und Extended Export UX.
- Checks + Commit: `feat: expose freshrss feed options in ui`.

## Paket 8: Docs + Final Verification

- Roadmap, PWA Push Todo, README aktualisieren.
- Final: `pnpm run lint`, `pnpm run build`.
- Commit: `docs: document notifications and freshrss opml support`.
