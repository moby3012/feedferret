# Continuous Maintenance

> Tracks ongoing work that does not belong to a feature release.
> Updated after each release cycle.

---

## Operations — Immediate (Post-Launch)

- [ ] **Mozilla Observatory score** — run `https://observatory.mozilla.org` against the production URL; target grade ≥ B+. The current CSP includes `unsafe-inline` and `unsafe-eval` in `script-src` (required by Next.js App Router's runtime without nonce configuration). If the score falls below B+, investigate nonce-based CSP as the fix — see the Security section below.
- [ ] **Sentry setup** — install `@sentry/nextjs`, add `SENTRY_DSN` to `.env.example` with a placeholder comment, wire into `lib/logger.ts` so `logger.error()` calls forward to Sentry in production. Add `SENTRY_AUTH_TOKEN` to the GitHub Actions environment for source-map upload.
- [ ] **Google Reader API device tests** — manual verification session with each supported client. Test: add server, sync, mark-read, star, oldest-first view.
  - [ ] Reeder (macOS)
  - [ ] Reeder (iOS)
  - [ ] NetNewsWire (macOS/iOS)
  - [ ] FeedMe (Android)
  - [ ] ReadKit (macOS)
- [ ] **Backup drill** — run `pg_dump` on the production database, restore to a separate throwaway database instance, verify row counts match. Document the result (date, DB size, restore time) in `docs/self-hosting.md`.

---

## Major Dependency Upgrades

Each upgrade gets its own PR. Never bundle two major upgrades in one PR. Run the full CI suite (`lint` + `typecheck` + `build`) before merging.

| Package | Current | Target | Risk | Notes |
|---|---|---|---|---|
| ESLint | 8.57 | 9.x | Medium | Flat config migration — rename `.eslintrc.json` to `eslint.config.js`, migrate rule syntax. Do this before `eslint-config-next`. |
| `eslint-config-next` | 14.2.35 | 16.x | Medium | Requires ESLint 9 first. Next.js 16 ships its own config; check for rule renames. |
| `next-auth` | 5.0.0-beta.31 | 5.0.0 stable | Medium | Check JWT callback signature changes between beta and stable. Verify magic link, OIDC, and TOTP flows end-to-end after upgrade. |
| `zod` | 3.25 | 4.x | Medium | `.parse()` error shape changed; `.safeParse()` result type narrowed. Audit all `z.parse()` call sites. Check `@hookform/resolvers` compatibility. |
| `prisma` + `@prisma/client` | 5.22 | 6.x → 7.x | High | Two-step: upgrade 5→6 first, run migrations and smoke test, then 6→7. Check query API changes in each major. SQLite and PostgreSQL must both pass. |
| `typescript` | 5.x | 6.0 | Low | Check new strict defaults — some previously valid code may produce errors. Run `tsc --noEmit` and fix any new errors before merging. |

---

## Security — Ongoing

- [ ] **CSP `unsafe-inline` / `unsafe-eval` cleanup** — requires nonce-based CSP configuration in Next.js. Blocked until Next.js provides a stable nonce API in the App Router (track upstream). When implemented, remove `unsafe-inline` from `script-src` and validate with Mozilla Observatory.
- [ ] **Token expiry configuration** — currently API tokens do not expire. Add an optional `expiresAt` field to the `ApiToken` table. Settings UI: expiry duration picker (never / 30 d / 90 d / 1 y). Tokens past `expiresAt` return HTTP 401.
- [ ] **Full Zod schemas for all server actions** — large refactor; own PR. Currently some server actions validate inputs with ad-hoc checks. Replace with explicit `z.object()` schemas at every action entry point. No behavior change — pure defensive hardening.
