import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { ACTIVE_LIST, expect, test, type App } from "../helpers/test";
import { articleIdsOf, briefingCount, markInjection, resetBriefing, setAiProvider } from "../helpers/briefing-db";

// K2 "catch me up" card on the Neu list, against the deterministic fake AI
// provider (lib/ai/fake.ts; enabled by playwright.config.ts for the e2e DB only).

const card = (page: Page) => page.locator(`${ACTIVE_LIST} [data-testid="briefing-card"]`);
const toggle = (page: Page) => card(page).getByRole("heading", { level: 3 }).getByRole("button");

function trackBriefingPosts(page: Page): string[] {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/app/briefing") posts.push(r.url());
  });
  return posts;
}

/** Title of a citation chip from its accessible name "Source N: {title} — {feed}". */
async function chipTitle(chip: Locator): Promise<string> {
  const label = (await chip.getAttribute("aria-label")) ?? "";
  return label.replace(/^Source \d+: /, "").replace(/ — [^—]+$/, "");
}

async function openCard(app: App, page: Page, name: RegExp) {
  await app.open();
  await expect(card(page)).toBeVisible();
  await expect(toggle(page)).toHaveAccessibleName(name);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
}

test.describe("briefing card", () => {
  test.afterEach(({ app }) => resetBriefing(app.userKey));

  test("without AI: headline digest grouped by story, citation opens the reader, no generation request", async ({ app, page }) => {
    resetBriefing(app.userKey);
    const posts = trackBriefingPosts(page);
    await openCard(app, page, /Headline overview/);
    const c = card(page);
    await expect(c).toHaveAttribute("data-mode", "headlines");
    await expect(c.getByRole("heading", { level: 4, name: "Headlines" })).toBeVisible();
    await expect(c.getByRole("heading", { level: 4, name: "In brief" })).toBeVisible();
    await expect(c.locator("[data-briefing-item]")).toHaveCount(13);
    await expect(c.getByTestId("briefing-fallback-reason")).toHaveText(/No AI set up/);
    await expect(c.getByRole("button", { name: "Create briefing" })).toHaveCount(0);
    // The list's only h2 stays the list title; the card is an h3 section.
    await expect(page.locator(`${ACTIVE_LIST} h2`)).toHaveCount(1);

    const chip = c.locator("[data-citation-id]").first();
    const id = await chip.getAttribute("data-citation-id");
    const title = await chipTitle(chip);
    await app.activate(chip);
    await expect(page.locator("article").getByRole("heading", { level: 1, name: title })).toBeVisible();
    expect(app.where()).toContain(`a=${id}`);
    await page.waitForLoadState("networkidle");
    expect(posts).toEqual([]);
  });

  test("with AI: streams validated sections with citations; chip opens the reader; back keeps the card; reload is cached", async ({ app, page }) => {
    setAiProvider(app.userKey, "fake", "fake");
    markInjection(app.userKey);
    const posts = trackBriefingPosts(page);
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await openCard(app, page, /Headline overview/); // cloud-style provider: no auto-generation
    expect(posts).toEqual([]);

    await app.activate(card(page).getByRole("button", { name: "Create briefing" }));
    const c = card(page);
    await expect(c).toHaveAttribute("data-mode", "ai");
    await expect(c.getByRole("status")).toHaveText(/Briefing ready, \d+ points/);
    await expect(toggle(page)).toHaveAccessibleName(/Your briefing/);
    for (const name of ["What happened", "Why it matters", "In brief"]) await expect(c.getByRole("heading", { level: 4, name })).toBeVisible();

    const items = c.locator("[data-briefing-item]");
    const n = await items.count();
    expect(n).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < n; i++) expect(await items.nth(i).locator("[data-citation-id]").count()).toBeGreaterThan(0);
    // Every chip resolves to one of this user's articles; no hallucinated / uncited line made it.
    const owned = articleIdsOf(app.userKey);
    for (const id of await c.locator("[data-citation-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-citation-id")))) {
      expect(owned.has(id!)).toBe(true);
    }
    await expect(c).not.toContainText("Ungeprüfte Behauptung");
    await expect(c).not.toContainText("Satz ohne Quelle");
    // The injected `<script>` line is plain text without tag or URL, never an element.
    await expect(c.locator("[data-briefing-item]", { hasText: "alert(1)" })).toHaveCount(1);
    await expect(c.locator("script")).toHaveCount(0);
    await expect(c).not.toContainText("evil.example");
    expect(dialogs).toBe(0);
    expect(posts).toHaveLength(1);
    expect(briefingCount(app.userKey)).toBe(1);

    const axe = await new AxeBuilder({ page }).include(`${ACTIVE_LIST} [data-testid="briefing-card"]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);

    // Keyboard: chips are focusable buttons.
    if (!app.isMobile) {
      const first = card(page).locator("[data-citation-id]").first();
      await first.focus();
      await expect(first).toBeFocused();
    }

    await page.reload();
    await expect(card(page)).toHaveAttribute("data-mode", "ai", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    expect(posts).toHaveLength(1); // served from the cache (GET), no second generation

    const chip = card(page).locator("[data-briefing-section=what] [data-citation-id]").first();
    const id = await chip.getAttribute("data-citation-id");
    const title = await chipTitle(chip);
    await app.activate(chip);
    await expect(page.locator("article").getByRole("heading", { level: 1, name: title })).toBeVisible();
    expect(app.where()).toContain(`a=${id}`);
    await page.goBack();
    await expect(card(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(card(page)).toHaveAttribute("data-mode", "ai");

  });

  test("collapsing persists across reloads; keyboard toggles the card", async ({ app, page }) => {
    resetBriefing(app.userKey);
    await openCard(app, page, /Headline overview/);
    await app.activate(toggle(page));
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(card(page).locator("[data-briefing-item]")).toHaveCount(0);
    await page.reload();
    await expect(card(page)).toBeVisible({ timeout: 30_000 });
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    if (!app.isMobile) {
      await toggle(page).focus();
      await page.keyboard.press("Enter");
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    }
  });

  test("provider failure falls back to the headline digest with a reason", async ({ app, page }) => {
    setAiProvider(app.userKey, "fake", "fake-error");
    await openCard(app, page, /Headline overview/);
    await app.activate(card(page).getByRole("button", { name: "Create briefing" }));
    await expect(card(page).getByTestId("briefing-error")).toHaveText(/not reachable/);
    await expect(card(page)).toHaveAttribute("data-mode", "headlines");
    await expect(toggle(page)).toHaveAccessibleName(/Headline overview/);
    await expect(card(page).locator("[data-briefing-item]").first()).toBeVisible();
    await expect(card(page).getByRole("button", { name: "Try again" })).toBeVisible();
    expect(briefingCount(app.userKey)).toBe(0);
  });

  test("rows do not move when streaming completes while the list is scrolled", async ({ app, page }) => {
    setAiProvider(app.userKey, "fake", "fake-slow");
    await openCard(app, page, /Headline overview/);
    await app.activate(card(page).getByRole("button", { name: "Create briefing" }));
    await expect(card(page)).toHaveAttribute("data-state", "generating");
    const scroller = app.listScroller();
    await scroller.evaluate((el) => el.scrollTo({ top: 400 }));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(400);
    const row = app.rows().nth(3);
    const before = await row.boundingBox();
    await expect(card(page)).not.toHaveAttribute("data-state", "generating", { timeout: 30_000 });
    const after = await row.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(400);
    await expect(card(page).getByRole("button", { name: "Show more" })).toBeAttached();
  });
});
