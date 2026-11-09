import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers/test";

/**
 * axe on the authenticated main view and settings.
 *
 * NON-BLOCKING for now: violations are attached to the test as annotations
 * (visible in the HTML report / CI summary) and the test only fails if axe
 * itself cannot run. Tighten (assert no serious/critical) once the audit's
 * a11y fixes land (see docs/accessibility-todo.md). Same rule set and the same
 * `color-contrast` exclusion as the public gate in accessibility.spec.ts.
 */
const VIEWS = [
  { name: "main view", path: "/", ready: (app: { open: () => Promise<void> }) => app.open() },
  { name: "settings", path: "/settings", ready: undefined },
];

for (const view of VIEWS) {
  test(`axe: authenticated ${view.name}`, async ({ app, page }, testInfo) => {
    if (view.ready) await view.ready(app);
    else {
      await page.goto(view.path);
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
    }
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .disableRules(["color-contrast"])
      .analyze();

    for (const v of results.violations) {
      testInfo.annotations.push({
        type: `axe:${v.impact ?? "unknown"}`,
        description: `${v.id} (${v.nodes.length} nodes) on ${view.name}: ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" ; ")}`,
      });
    }
    // CI: surface findings in the job summary (non-blocking).
    if (process.env.GITHUB_STEP_SUMMARY && results.violations.length) {
      const lines = results.violations.map(
        (v) => `- **${v.impact}** \`${v.id}\` ×${v.nodes.length} — ${v.help} (${testInfo.project.name}, ${view.name})`,
      );
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `#### axe: ${view.name} (${testInfo.project.name})\n${lines.join("\n")}\n\n`);
    }
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    console.log(`[axe] ${view.name} (${testInfo.project.name}): ${results.violations.length} violations, ${blocking.length} serious/critical`);
    expect(results.passes.length).toBeGreaterThan(0);
  });
}
