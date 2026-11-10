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

/** Waits until the card's GET answered (status line left "Loading…"). */
async function cardLoaded(page: Page) {
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await expect(card(page).getByTestId("briefing-status-line")).not.toHaveText("Loading…", { timeout: 30_000 });
}

/** Opens the body unless it already opened by itself (briefing loaded before the first rows painted). */
async function expand(app: App, page: Page) {
  await cardLoaded(page);
  if ((await toggle(page).getAttribute("aria-expanded")) !== "true") await app.activate(toggle(page));
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
}

async function openCard(app: App, page: Page, name: RegExp) {
  await app.open();
  await expand(app, page);
  await expect(toggle(page)).toHaveAccessibleName(name);
}

type RowSample = { y: number; card: boolean; expanded: string | null; t: number; search: string };

/** Every frame: y of the first row of the active list, whether the card exists, its toggle state. */
async function sampleRows(page: Page) {
  await page.addInitScript(() => {
    const samples: RowSample[] = [];
    (window as unknown as { __rowSamples: RowSample[] }).__rowSamples = samples;
    const tick = () => {
      const pane = document.querySelector('[data-pane^="list-"][data-active="true"]');
      const row = pane?.querySelector("[data-article-id]");
      if (row) {
        const c = pane?.querySelector('[data-testid="briefing-card"]');
        samples.push({
          y: Math.round(row.getBoundingClientRect().top * 10) / 10,
          card: !!c,
          expanded: c?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
          t: performance.now(),
          search: location.search,
        });
      }
      if (samples.length < 20_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const samplesOf = (page: Page) => page.evaluate(() => (window as unknown as { __rowSamples: RowSample[] }).__rowSamples.slice());
const ys = (samples: RowSample[]) => [...new Set(samples.map((s) => s.y))];

/** Slow briefing GET (the list answers first); POSTs untouched. */
async function delayBriefingGet(page: Page, ms = 700) {
  await page.route("**/api/app/briefing?*", async (route) => {
    if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
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
    await expand(app, page);

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
    await cardLoaded(page);
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

  test("slow briefing GET: the card header is there from the first row paint, stays collapsed, rows never move", async ({ app, page }) => {
    resetBriefing(app.userKey);
    await delayBriefingGet(page);
    await sampleRows(page);
    await page.goto("/");
    await cardLoaded(page);
    await expect(card(page).getByTestId("briefing-status-line")).toHaveText(/stories since|new stories/);
    await page.waitForTimeout(300);
    const samples = await samplesOf(page);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.card)).toBe(true); // header present at the first painted frame
    expect(samples.every((s) => s.expanded === "false")).toBe(true); // arrived after the rows: no auto-open
    expect(ys(samples)).toHaveLength(1);
  });

  test("warm cache: back on Neu the card opens with the first paint (not hidden), rows never move", async ({ app, page }) => {
    resetBriefing(app.userKey);
    await app.open();
    // Opened once (default pref "expanded"): a remount with the cached briefing opens by itself.
    await expand(app, page);
    await app.selectSidebar(/^Solo Blog\s*\d+$/);
    await expect(card(page)).toHaveCount(0);
    // Same document (no reload): start the per-frame sampler now.
    await page.evaluate(() => {
      const samples: RowSample[] = [];
      (window as unknown as { __rowSamples: RowSample[] }).__rowSamples = samples;
      const tick = () => {
        const pane = document.querySelector('[data-pane^="list-"][data-active="true"]');
        const row = pane?.querySelector("[data-article-id]");
        if (row) {
          const c = pane?.querySelector('[data-testid="briefing-card"]');
          samples.push({ y: Math.round(row.getBoundingClientRect().top * 10) / 10, card: !!c, expanded: c?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ?? null, t: performance.now(), search: location.search });
        }
        if (samples.length < 20_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await app.selectSidebar(/^All articles\s*\d*$/);
    await expect(card(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(card(page).locator("[data-briefing-item]").first()).toBeVisible();
    await page.waitForTimeout(300);
    const samples = await samplesOf(page);
    const withCard = samples.slice(samples.findIndex((s) => s.card));
    expect(withCard.length).toBeGreaterThan(0);
    // From the first frame of the Neu rows on: card present and open, first row fixed.
    expect(withCard.every((s) => s.card && s.expanded === "true")).toBe(true);
    expect(ys(withCard)).toHaveLength(1);
  });

  test("local provider: auto-generation after mount streams into the header only; rows never move", async ({ app, page }) => {
    setAiProvider(app.userKey, "fake", "fake-local");
    const posts = trackBriefingPosts(page);
    await delayBriefingGet(page);
    await sampleRows(page);
    await page.goto("/");
    const status = card(page).getByTestId("briefing-status-line");
    await expect(status).toHaveText("Creating your briefing…", { timeout: 30_000 });
    await expect(card(page)).toHaveAttribute("data-state", "generating");
    await expect(status).toHaveText(/Briefing ready, \d+ points/, { timeout: 60_000 });
    expect(posts).toHaveLength(1);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(card(page).locator("[data-briefing-item]")).toHaveCount(0);
    await page.waitForTimeout(300);
    const samples = await samplesOf(page);
    expect(samples.every((s) => s.card && s.expanded === "false")).toBe(true);
    expect(ys(samples)).toHaveLength(1);
    // The result is there on demand.
    await app.activate(toggle(page));
    await expect(card(page)).toHaveAttribute("data-mode", "ai");
    await expect(card(page).locator("[data-briefing-item]").first()).toBeVisible();
  });

  test("rows move only after the user expands the card", async ({ app, page }) => {
    resetBriefing(app.userKey);
    await delayBriefingGet(page);
    await sampleRows(page);
    await page.goto("/");
    await cardLoaded(page);
    await page.waitForTimeout(300);
    const tClick = await page.evaluate(() => performance.now());
    await app.activate(toggle(page));
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(card(page).locator("[data-briefing-item]").first()).toBeVisible();
    await page.waitForTimeout(200);
    const samples = await samplesOf(page);
    const before = samples.filter((s) => s.t < tClick);
    const after = samples.filter((s) => s.t > tClick);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((s) => s.card)).toBe(true);
    expect(ys(before)).toHaveLength(1);
    expect(after.at(-1)!.y).toBeGreaterThan(before[0].y);
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
