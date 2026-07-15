# FeedFerret Roadmap

> Last updated: 2026-07-15 — v1.1.1 shipped; post-release work (digest expansion, search view, settings tabs, PRs #88–#96) merged to `main` and documented in the CHANGELOG "Unreleased" section. A full design audit (performance / UX / security / visuals) is tracked in [`design-audit-todo.md`](design-audit-todo.md) and feeds into v1.2.

This file is the **top-level index**. Each release has its own detailed planning document in [`docs/releases/`](releases/).

---

## Release Overview

| Version | Theme | Status | Details |
|---|---|---|---|
| **v1.0.0** | Initial public release | ✅ Shipped 2026-05-18 | [`releases/v1.0.md`](releases/v1.0.md) |
| **v1.1** | i18n + Full API/MCP Coverage + UX Polish | ✅ Shipped 2026-05-20 (v1.1.1 patch 2026-05-21) | [`releases/v1.1-i18n.md`](releases/v1.1-i18n.md) |
| **v1.2** | Theming & Accessibility (+ design-audit findings) | ⬜ Queued | [`releases/v1.2-theming.md`](releases/v1.2-theming.md) · [`design-audit-todo.md`](design-audit-todo.md) |
| **v1.3** | Feature Backlog Release | ⬜ Queued | [`releases/v1.3.md`](releases/v1.3.md) |
| **v2.0** | Podcast, Audio & Native Apps | ⬜ Planned | [`releases/v2.md`](releases/v2.md) |

---

## Continuous Workstreams

These run in parallel with feature releases — each item gets its own PR.

| Workstream | Details |
|---|---|
| Dependency upgrades, ops, monitoring | [`releases/maintenance.md`](releases/maintenance.md) |
| Small features & backlog | [`releases/backlog.md`](releases/backlog.md) |
| Test coverage (Vitest + Playwright) | [`releases/testing.md`](releases/testing.md) |

---

## Versioning Policy

- **Patch (x.y.Z):** Bug fixes, security patches, doc corrections — no new features.
- **Minor (x.Y.0):** One or more new user-facing features. Full lint + typecheck + build must pass. CHANGELOG.md updated.
- **Major (X.0.0):** Significant new product surface (audio, native app) or breaking changes to API, auth, or DB schema.

Each release is planned in a dedicated `releases/vX.Y.md` file before work starts.

---

## What is in v1.1

- Full i18n (English + German, 1001 keys, ICU plurals)
- All components wired with `useTranslations` / `getTranslations`
- RTL CSS logical properties
- Email localization (digest + sign-in)
- Locale-aware date formatting via `format.dateTime()` throughout
- REST API v1 extended (alerts, rules, notifications, stats, batch)
- API token scopes (`read`/`write`/`admin`) enforced per endpoint
- MCP server at 28 tools
- OR operator in rules/alerts keyword queries
- Unified label action picker in rules
- Availability filter for notification actions
- Labels: unread count + "hide empty labels" setting
- Admin storage dashboard + Logs tab
- Label badge refresh without page reload
- SystemLog table for mail/digest errors
- 85 Vitest tests

See [`releases/v1.1-i18n.md`](releases/v1.1-i18n.md) for the full checklist.
See [`CHANGELOG.md`](../CHANGELOG.md) for the detailed change log.

**Build status:** `npx tsc --noEmit` ✅ · `pnpm test` 85/85 ✅ · `pnpm run translations:check` ✅ (1001 keys)

---

## What is in v1.0

See [`releases/v1.0.md`](releases/v1.0.md) for the full feature list.
See [`CHANGELOG.md`](../CHANGELOG.md) for the detailed change log.

**Build status:** `pnpm run build` ✅ · `pnpm run lint` ✅ · `tsc --noEmit` ✅ · CI ✅

---

## Contributing

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the contribution guide and CLA.
Feature ideas → [GitHub Issues](https://github.com/moby3012/feedferret/issues) using the Feature Request template.
