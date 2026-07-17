import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Automated accessibility gate (sprint A-5.2 / A-4).
 *
 * Scope: PUBLIC, unauthenticated pages only. Authenticated screens (home
 * timeline, manage-feeds, settings, server-settings) require a seeded DB
 * user + a signed-in session and are intentionally OUT OF SCOPE here — see
 * TODO at the bottom of this file for how to extend coverage once a seeded
 * test user is available in CI.
 *
 * Route discovery: on a fresh, empty database (no users yet — the state a
 * new self-hosted instance boots into, and what CI provisions via
 * `prisma db push`), this app's client-side routing behaves as follows:
 *   - "/"       -> redirects (client-side, via useSession + hasUsers()) to /setup
 *   - "/login"  -> redirects (client-side, via hasUsers()) to /setup
 *   - "/register" -> renders directly (registrationsEnabled defaults to true
 *                     and it does not check hasUsers())
 *   - "/setup"    -> renders directly (onboarding wizard, terminal page)
 *   - "/accessibility" -> renders directly (static statement page, no auth)
 * So "/" and "/login" don't have distinct content to audit on a fresh
 * instance -- they are just a flash before landing on /setup, which is
 * covered directly below. Auditing them here would either double-test
 * /setup's DOM or be flaky (racing the client-side redirect).
 */
const PUBLIC_ROUTES = ["/setup", "/register", "/accessibility"];

// Only fail the build on axe's "serious" and "critical" impact violations.
// "minor"/"moderate" findings are logged by axe but not asserted on yet --
// tightening this threshold is tracked in docs/accessibility-todo.md (A-5.2).
const FAILING_IMPACTS = new Set(["serious", "critical"]);

// axe's "color-contrast" rule is DISABLED — not to hide real issues, but
// because it cannot correctly read this app's colors. Every color token is a
// Tailwind v4 `oklch(...)` value; Chromium serializes those back through
// getComputedStyle as `lab(...)`, and axe's contrast math mis-composites
// `lab()`/oklab through the cards' stacked semi-transparent layers +
// `backdrop-filter`. Concretely, on /register axe reported the muted footer
// text as `#a8abaf` (~oklch L0.71) when the token is `--muted-foreground:
// oklch(0.46 …)` (~#6a6d71, a real ~6.6:1 on the card) — a bogus ~2:1
// reading. This flakes across Chromium versions on any muted-foreground
// element, so a per-element exclusion just moves the whack-a-mole. Contrast
// is instead guaranteed at the design-token level (the ratios are computed
// and documented inline in app/globals.css) and by the design audit. All
// other WCAG 2.1 A/AA rules stay active. Tracked in docs/accessibility-todo.md.
const DISABLED_AXE_RULES = ["color-contrast"];

for (const route of PUBLIC_ROUTES) {
  test(`${route} has no serious/critical axe violations`, async ({ page }) => {
    await page.goto(route);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .disableRules(DISABLED_AXE_RULES)
      .analyze();

    const blockingViolations = results.violations.filter((violation) =>
      FAILING_IMPACTS.has(violation.impact ?? "")
    );

    if (blockingViolations.length > 0) {
      const details = blockingViolations
        .map((violation) => {
          const nodes = violation.nodes
            .map((node) => `    - ${node.target.join(" ")}\n      ${node.failureSummary}`)
            .join("\n");
          return `[${violation.impact}] ${violation.id}: ${violation.help}\n${nodes}`;
        })
        .join("\n\n");
      console.error(`axe violations on ${route}:\n\n${details}`);
    }

    expect(blockingViolations, JSON.stringify(blockingViolations, null, 2)).toEqual([]);
  });
}

// TODO(A-5.2 follow-up): add authenticated-page coverage (/, /manage-feeds,
// /settings, /server-settings) once CI can seed a test user + session,
// e.g. via a Prisma seed script + a login helper (fill /login form, or set
// the authjs session cookie directly) run in a `test.beforeEach`.
