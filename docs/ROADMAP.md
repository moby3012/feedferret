# FeedFerret Roadmap

> Last updated: 2026-05-18 — v1.0.0 released.

This file is the **top-level index**. Each release and workstream has its own detailed planning document in [`docs/releases/`](releases/).

---

## Release Overview

| Version | Theme | Status | Details |
|---|---|---|---|
| **v1.0.0** | Initial public release | ✅ Shipped 2026-05-18 | [`releases/v1.0.md`](releases/v1.0.md) |
| **v1.1** | i18n + Full API/MCP Coverage | 🟡 In Progress | [`releases/v1.1-i18n.md`](releases/v1.1-i18n.md) |
| **v1.2** | Theming & Accessibility | ⬜ Queued | [`releases/v1.2-theming.md`](releases/v1.2-theming.md) |
| **v1.3** | Podcast & Text-to-Speech | ⬜ Queued | [`releases/v1.3-podcast-tts.md`](releases/v1.3-podcast-tts.md) |

---

## Continuous Workstreams

These run in parallel with feature releases — each item gets its own PR.

| Workstream | Details |
|---|---|
| Dependency upgrades, ops, monitoring | [`releases/maintenance.md`](releases/maintenance.md) |
| Small features & API backlog | [`releases/backlog.md`](releases/backlog.md) |
| Test coverage (Vitest + Playwright) | [`releases/testing.md`](releases/testing.md) |

---

## Versioning Policy

- **Patch (x.y.Z):** Bug fixes, security patches, doc corrections — no new features.
- **Minor (x.Y.0):** One or more new user-facing features. Full lint + typecheck + build must pass. CHANGELOG.md updated.
- **Major (X.0.0):** Breaking changes to API, auth, or DB schema.

Each minor release is planned in a dedicated `releases/vX.Y-*.md` file before work starts. Features are batched so every minor release ships at least one significant user-facing improvement.

---

## What is in v1.0.0

See [`releases/v1.0.md`](releases/v1.0.md) for the full feature list.  
See [`CHANGELOG.md`](../CHANGELOG.md) for the detailed change log.

**Build status:** `pnpm run build` ✅ · `pnpm run lint` ✅ · `tsc --noEmit` ✅ · CI ✅

---

## Contributing

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the contribution guide and CLA.  
Feature ideas → [GitHub Issues](https://github.com/moby3012/feedferret/issues) using the Feature Request template.
