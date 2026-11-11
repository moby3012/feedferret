# Web page fixtures (discovery / page digest)

Synthetic, anonymised pages modelled on the structures measured in
`.pm/AI-FEED-DIAGNOSIS.md` — not copies of real sites. Tests serve them through
a mocked SSRF fetch (no network in CI).

- `chromie-like/page.html` — ~13 KB `<head>` (preloads, styles), a big mega
  menu before `<main>`, a repeating news list, and feed links ONLY as anchors
  deep in the footer: five `/feed.xml?zeitlinie=…` variants first, then the
  main `/feed.xml` (RSS icon, `aria-label`). The main feed must rank first.
- `footer-anchor-only/page.html` — no `<link rel=alternate>`; the feed lives at
  a non-standard path linked only from a footer RSS icon, next to a comments feed.
- `publisher-with-link/page.html` — a homepage on a host in the curated
  publisher table that advertises its own feed via `<link rel=alternate>`.

The >1 MB feed is generated in the test (`tests/lib/discovery-fixtures.test.ts`).
