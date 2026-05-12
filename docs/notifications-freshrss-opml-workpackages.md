# Notifications + FreshRSS Extended OPML Arbeitspakete

Status: ✅ abgeschlossen auf Branch `feat/notifications-freshrss-opml`.

Dieses Dokument ist ein Abschlussprotokoll für die bereits umgesetzten Pakete. Die aktuelle offene Planung steht in [`docs/next-session-workpackages.md`](next-session-workpackages.md) und `.ai/todo.md`.

## Umgesetzte Entscheidungen ✅

- [x] Notification-Frequenz ist pro User wählbar (`immediate`, `hourly`, `daily`, `off`).
- [x] Default bleibt `immediate`, kann aber pro User reduziert oder deaktiviert werden.
- [x] Browser-Push-Payloads können Artikeltitel enthalten; private/generische Payloads sind per User wählbar.
- [x] FreshRSS cURL/HTTP-Optionen werden funktional nachgebaut, nicht nur importiert/exportiert.
- [x] Dynamic OPML (`frss:opmlUrl`) wird beim Import aktiviert und später synchronisiert.
- [x] Feed-Fetching und Dynamic OPML laufen durch SSRF-Schutz; interne URLs brauchen den Admin-Override.

## Paket 1: Foundations / Schema / Dependencies ✅

- [x] Web-Push Dependencies + Key-Generation Script.
- [x] VAPID Env-Dokumentation.
- [x] Prisma-Modelle/Felder für Push, FreshRSS OPML, Source Types, Notifications.
- [x] Migration + Prisma Client Generate.
- [x] Checks: TypeScript, Lint, Build während Umsetzung ausgeführt.

## Paket 2: Push Notifications Backend ✅

- [x] Push-Sender, Notification Scheduler/Flush-Logik.
- [x] API: subscribe, unsubscribe, status, test.
- [x] Sync-Integration für neue Artikel.
- [x] Expired subscriptions werden bei 404/410 deaktiviert.

## Paket 3: Push Notifications Frontend + Service Worker ✅

- [x] Service Worker Push + Notification Click + Badging.
- [x] Settings UI: Enable/disable/test, Frequency, Privacy toggle, Feed-Auswahl.
- [x] React Query Hooks / UI-Integration.
- [x] Best-effort Badge-Updates aus App und Push Payloads.

## Paket 4: FreshRSS Extended OPML Import/Export ✅

- [x] Parser/Exporter für `xmlns:frss="https://freshrss.org/opml"`.
- [x] FreshRSS Source Types und dokumentierte `frss:*` Attribute.
- [x] Dynamic OPML Category Import.
- [x] Roundtrip-Verhalten in Doku und README beschrieben.

## Paket 5: FreshRSS Fetcher / Scraper Support ✅

- [x] RSS/Atom, JSONFeed, JSON+DotNotation, HTML/XML+XPath, HTML+XPath+JSON.
- [x] cURL-kompatible HTTP-Optionen.
- [x] Unicity/Dedupe-Strategien für FreshRSS-Importfelder.
- [x] Full-content/filter/read-rules Integration.

## Paket 6: Dynamic OPML + SSRF-Schutz ✅

- [x] Remote OPML Kategorien werden automatisch aktualisiert.
- [x] HTTP/HTTPS Allowlist, private IP Block, Timeout, Size Limit, Redirect Checks.
- [x] Admin-Schalter für vertrauenswürdige interne Feed-URLs.
- [x] Sicherheitsfolgen dokumentiert in `docs/security.md`.

## Paket 7: Feed UI FreshRSS Optionen ✅

- [x] Feed Edit Dialog Tabs/Inputs für Source, XPath/JSON, cURL, Priority/Unicity, Filters.
- [x] Import Report und Extended Export UX.
- [x] Dynamic OPML / FreshRSS Optionen in Management UI integriert.

## Paket 8: Docs + Final Verification ✅

- [x] Roadmap aktualisiert.
- [x] PWA Push Status aktualisiert.
- [x] README aktualisiert.
- [x] Security- und Database-Dokumente ergänzt.
- [x] Final Checks in den jeweiligen Arbeitspaketen ausgeführt.
