import type { Page } from "@playwright/test";
import { test, expect, ACTIVE_LIST } from "../helpers/test";
import { articleFlags, makeStoryCluster, patchArticles, setUserFlags } from "../helpers/db";
import { touchDrag, touchHoldOn, touchSwipeOn } from "../helpers/gestures";

/**
 * PR 6: gesture module (lib/gestures), row v2 (kind × density), story cluster
 * card and the K3 chips. Touch tests drive real input through CDP (pointer +
 * touch streams, `touch-action`, native scroll), not synthetic TouchEvents.
 *
 * Seed facts: #001–#012 are unread, not starred; #006 is read-later.
 */

/** Records every swipe attribute the gesture module writes on rows while `fn` runs. */
async function recordSwipeAttrs(page: Page, fn: () => Promise<void>): Promise<string[]> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __swipeSeen: string[] }).__swipeSeen = seen;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (r.attributeName && el.hasAttribute(r.attributeName)) seen.push(`${r.attributeName}=${el.getAttribute(r.attributeName)}`);
      }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-swipe", "data-armed", "data-swiping"] });
    (window as unknown as { __swipeMo: MutationObserver }).__swipeMo = mo;
  });
  await fn();
  return page.evaluate(() => {
    const w = window as unknown as { __swipeSeen: string[]; __swipeMo: MutationObserver };
    w.__swipeMo.disconnect();
    return w.__swipeSeen;
  });
}

/**
 * Opens the app and waits until the list stops moving: the K2 briefing card
 * above the Neu list opens by itself after its GET, which pushes the rows
 * down. Touch input aimed at a row must start after that.
 */
async function openSettled(app: import("../helpers/test").App) {
  await app.open();
  const first = app.row(1);
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const y = (await first.boundingBox())?.y ?? -1;
    if (y !== last) {
      last = y;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 600) {
      return;
    }
    await app.page.waitForTimeout(100);
  }
}

test.describe("touch swipes (mobile)", () => {
  test.beforeEach(({ app }) => {
    test.skip(!app.isMobile, "touch gestures");
  });

  test("swipe right toggles read, swipe left toggles read-later; every drag arms visibly", async ({ app, page }) => {
    await openSettled(app);
    const row = app.row(1);
    const seen = await recordSwipeAttrs(page, () => touchSwipeOn(page, row, 220));
    expect(seen).toContain("data-swipe=leading");
    expect(seen).toContain("data-armed=");
    await expect.poll(() => articleFlags(app.articleId(1)).isRead).toBe(true);
    await expect(row).not.toHaveAttribute("aria-label", /^Unread: /);
    // The row stays where it was (no removal under the finger) and springs home.
    await expect(row).toBeVisible();
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).transform)).toBe("none");

    await touchSwipeOn(page, app.row(2), -220);
    await expect.poll(() => articleFlags(app.articleId(2)).isReadLater).toBe(true);
    expect(articleFlags(app.articleId(2)).isRead).toBe(false);

    // Same gesture again toggles back.
    await touchSwipeOn(page, row, 220);
    await expect.poll(() => articleFlags(app.articleId(1)).isRead).toBe(false);
  });

  test("a fast short flick commits", async ({ app, page }) => {
    await openSettled(app);
    // 60 px in 3 moves 8 ms apart: ~2.5 px/ms, far below the 35 % distance.
    await touchSwipeOn(page, app.row(3), 60, { steps: 3, stepMs: 8 });
    await expect.poll(() => articleFlags(app.articleId(3)).isRead).toBe(true);
  });

  test("a vertical scroll with up to 30° drift never arms a swipe", async ({ app, page }) => {
    await openSettled(app);
    const scroller = app.listScroller();
    await app.row(2).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const box = (await scroller.boundingBox())!;
    const vh = page.viewportSize()!.height;
    // Start low in the visible part of the list, so the 2 × 300 px upward drags stay on screen.
    const start = { x: box.x + box.width / 2 - 40, y: Math.min(box.y + box.height, vh) - 160 };
    const before = await scroller.evaluate((el) => el.scrollTop);
    const seen = await recordSwipeAttrs(page, async () => {
      // tan(27°) ≈ 0.51: 150 px sideways over 300 px up, then the mirror image.
      await touchDrag(page, start, 150, -300, { steps: 12, stepMs: 16 });
      await page.waitForTimeout(200);
      await touchDrag(page, { x: start.x + 120, y: start.y }, -150, -300, { steps: 12, stepMs: 16 });
    });
    expect(seen.filter((s) => s.startsWith("data-swipe") || s.startsWith("data-armed"))).toEqual([]);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const flags = articleFlags(app.articleId(n));
      expect(flags.isRead).toBe(false);
    }
  });

  test("a swipe that starts in the 24 px screen edge is left to the OS (no row action)", async ({ app, page }) => {
    await openSettled(app);
    await app.row(1).scrollIntoViewIfNeeded();
    const box = (await app.row(1).boundingBox())!;
    const y = box.y + 40;
    const seen = await recordSwipeAttrs(page, async () => {
      await touchDrag(page, { x: 10, y }, 260, 0);
      const vw = page.viewportSize()!.width;
      await touchDrag(page, { x: vw - 10, y }, -260, 0);
    });
    expect(seen).toEqual([]);
    await page.waitForTimeout(600);
    expect(articleFlags(app.articleId(1))).toMatchObject({ isRead: false, isReadLater: false });
  });

  test("long-press opens the row menu as a sheet; its actions work, incl. 'Mark all up to here' with Undo", async ({ app, page }) => {
    await openSettled(app);
    await touchHoldOn(page, app.row(2));
    const menu = page.getByTestId("article-context-menu");
    await expect(menu).toBeVisible();
    // The long-press did not open the article.
    await expect(page.locator("article").filter({ hasText: "(#002)" })).toBeHidden();
    await menu.getByRole("menuitem", { name: "Save to Read Later" }).tap();
    await expect(menu).toBeHidden();
    await expect.poll(() => articleFlags(app.articleId(2)).isReadLater).toBe(true);

    await touchHoldOn(page, app.row(4));
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Mark all up to here as read" }).tap();
    for (const n of [1, 2, 3, 4]) await expect.poll(() => articleFlags(app.articleId(n)).isRead).toBe(true);
    expect(articleFlags(app.articleId(5)).isRead).toBe(false);
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: /Marked 4 articles as read/ });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).tap();
    for (const n of [1, 2, 3, 4]) await expect.poll(() => articleFlags(app.articleId(n)).isRead).toBe(false);
  });

  test("offline: swipes are disabled", async ({ app, page }) => {
    await openSettled(app);
    await page.context().setOffline(true);
    try {
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
      const seen = await recordSwipeAttrs(page, () => touchSwipeOn(page, app.row(1), 220));
      expect(seen).toEqual([]);
    } finally {
      await page.context().setOffline(false);
    }
    expect(articleFlags(app.articleId(1)).isRead).toBe(false);
  });
});

test.describe("mouse + keyboard (desktop)", () => {
  test.beforeEach(({ app }) => {
    test.skip(app.isMobile, "pointer: fine");
  });

  test("a mouse drag never swipes; right-click opens the menu at the pointer", async ({ app, page }) => {
    await app.open();
    const box = (await app.row(1).boundingBox())!;
    const y = box.y + 30;
    const seen = await recordSwipeAttrs(page, async () => {
      await page.mouse.move(box.x + 200, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 450, y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    });
    expect(seen).toEqual([]);
    expect(articleFlags(app.articleId(1)).isReadLater).toBe(false);

    await app.row(3).click({ button: "right", position: { x: 200, y: 30 } });
    const menu = page.getByTestId("article-context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Star" }).click();
    await expect.poll(() => articleFlags(app.articleId(3)).isStarred).toBe(true);
  });

  test("keyboard: the context-menu key opens the row menu and Escape returns focus to the row", async ({ app, page }) => {
    await app.open();
    const row = app.row(2);
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByTestId("article-context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Mark as read" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(row).toBeFocused();
  });
});

test("story cluster card: one row per story, +N expands the sources, story read cascades (incl. server cascade + Undo)", async ({ app, page }) => {
  // Lead #003 with #005 / #009 (loaded, collapse under the card) and #120 (not
  // in the first page and the card not expanded yet: only the server cascade
  // reaches it).
  const members = [3, 5, 9, 120].map((n) => app.articleId(n));
  const cleanup = makeStoryCluster(app.userKey, members);
  try {
    await app.open();
    await expect(app.row(3)).toBeVisible();
    await expect(app.row(5)).toHaveCount(0);
    await expect(app.row(9)).toHaveCount(0);
    const toggle = app.row(3).getByTestId("cluster-toggle");
    await expect(toggle).toHaveText("+3 sources");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Story mode (the default): reading the card marks every source.
    await app.activate(app.rowActions(3).read);
    for (const n of [3, 5, 9]) await expect.poll(() => articleFlags(app.articleId(n)).isRead).toBe(true);
    // #120 was not loaded: the server cascade marked it and the toast offers Undo.
    await expect.poll(() => articleFlags(app.articleId(120)).isRead).toBe(true);
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: /1 more source of this story marked as read/ });
    await expect(toast).toBeVisible();
    await app.activate(toast.getByRole("button", { name: "Undo" }));
    await expect.poll(() => articleFlags(app.articleId(120)).isRead).toBe(false);
    expect(articleFlags(app.articleId(3)).isRead).toBe(true);

    // +N expands the story's sources (from GET /api/app/clusters/:id) as nested rows.
    await app.activate(toggle);
    const group = page.locator(`${ACTIVE_LIST} [data-testid="cluster-members"]`);
    await expect(group).toBeVisible();
    for (const n of [5, 9, 120]) await expect(group.locator(`[data-article-id="${app.articleId(n)}"]`)).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await app.activate(toggle);
    await expect(group).toBeHidden();

    // Marking the card unread brings the loaded sources back too.
    await app.activate(app.rowActions(3).read);
    for (const n of [3, 5, 9]) await expect.poll(() => articleFlags(app.articleId(n)).isRead).toBe(false);
  } finally {
    cleanup();
  }
});

test("article mode: marking the card read touches only that article", async ({ app }) => {
  const cleanup = makeStoryCluster(app.userKey, [3, 5].map((n) => app.articleId(n)));
  const restoreUser = setUserFlags(app.userKey, { clusterReadMode: "article" });
  try {
    await app.open();
    await app.activate(app.rowActions(3).read);
    await expect.poll(() => articleFlags(app.articleId(3)).isRead).toBe(true);
    await app.page.waitForTimeout(800);
    expect(articleFlags(app.articleId(5)).isRead).toBe(false);
  } finally {
    cleanup();
    restoreUser();
  }
});

test("sponsored chip and clean titles (original title stays reachable)", async ({ app }) => {
  const restoreSponsored = patchArticles([app.articleId(4)], { isSponsored: 1 });
  const restoreClickbait = patchArticles([app.articleId(7)], { isClickbait: 1, cleanTitle: "A calm headline about lineups" });
  const restoreUser = setUserFlags(app.userKey, { aiCleanTitles: true });
  try {
    await app.open();
    await expect(app.row(4).getByTestId("sponsored-chip")).toHaveText("Sponsored");
    await expect(app.row(5).getByTestId("sponsored-chip")).toHaveCount(0);
    const cleaned = app.rowsMatching("A calm headline about lineups");
    await expect(cleaned).toHaveCount(1);
    await expect(cleaned.locator("h3")).toHaveAttribute("title", /^Original title: .*\(#007\)$/);
    await expect(cleaned).toHaveAccessibleDescription(/Original title: .*\(#007\)/);
  } finally {
    restoreSponsored();
    restoreClickbait();
    restoreUser();
  }
});

test("row v2: each content kind renders its variant in every density, without layout shift", async ({ app, page }) => {
  const restores = [
    patchArticles([app.articleId(1)], { kind: "video", mediaDurationSecs: 754, mediaType: "video/mp4" }),
    patchArticles([app.articleId(2)], { kind: "audio", mediaDurationSecs: 1830, mediaType: "audio/mpeg" }),
    patchArticles([app.articleId(4)], { kind: "social" }),
    patchArticles([app.articleId(3)], { kind: "image" }), // #003 has an image in the seed
  ];
  try {
    for (const mode of ["list", "minimal", "magazine"] as const) {
      const restoreMode = setUserFlags(app.userKey, { defaultViewMode: mode });
      try {
        await page.addInitScript(() => {
          (window as unknown as { __cls: number }).__cls = 0;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
          }).observe({ type: "layout-shift", buffered: true });
        });
        await app.open();
        const density = mode;
        // Count only shifts after the first paint settled (the density from
        // the user prefs is applied after load — a separate, pre-existing
        // shell concern); from here on rows must never move on their own.
        await page.waitForTimeout(500);
        await page.evaluate(() => ((window as unknown as { __cls: number }).__cls = 0));
        const rowOf = (n: number) => page.locator(`${ACTIVE_LIST} [data-article-id="${app.articleId(n)}"]`);
        await expect(rowOf(1)).toHaveAttribute("data-density", density);
        await expect(rowOf(1)).toHaveAttribute("data-kind", "video");
        await expect(rowOf(2)).toHaveAttribute("data-kind", "audio");
        await expect(rowOf(3)).toHaveAttribute("data-kind", "image");
        await expect(rowOf(4)).toHaveAttribute("data-kind", "social");
        await expect(rowOf(5)).toHaveAttribute("data-kind", "article");
        if (density === "minimal") {
          await expect(rowOf(1).getByRole("img", { name: "Video" })).toBeVisible();
          await expect(rowOf(2).getByRole("img", { name: "Audio" })).toBeVisible();
        } else {
          await expect(rowOf(1).getByLabel("Duration 12:34")).toBeVisible();
        }
        if (density === "list") {
          // Audio shows its length on the meta line; social has no title line.
          await expect(rowOf(2)).toContainText("30:30");
          await expect(rowOf(4).locator("h3")).toHaveCount(0);
        }
        // Toggling state never changes a row's size.
        const h = (await rowOf(5).boundingBox())!.height;
        await app.activate(app.rowActions(5).read);
        await expect.poll(() => articleFlags(app.articleId(5)).isRead).toBe(true);
        expect((await rowOf(5).boundingBox())!.height).toBe(h);
        await app.activate(app.rowActions(5).read);
        await expect.poll(() => articleFlags(app.articleId(5)).isRead).toBe(false);
        // Lazy images load into reserved boxes while scrolling.
        const scroller = app.listScroller();
        for (let i = 1; i <= 4; i++) {
          await scroller.evaluate((el, top) => el.scrollTo(0, top), i * 700);
          await page.waitForTimeout(120);
        }
        await scroller.evaluate((el) => el.scrollTo(0, 0));
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.01);
      } finally {
        restoreMode();
      }
    }
  } finally {
    restores.forEach((r) => r());
  }
});

test("settings: swipe mapping per direction is honoured, haptics can be switched off", async ({ app, page }) => {
  test.skip(!app.isMobile, "touch gestures");
  await page.goto("/settings");
  // Compact settings: the section tabs are a select.
  await page.getByRole("combobox").first().tap();
  await page.getByRole("option", { name: "Reading" }).tap();
  const section = page.getByTestId("gesture-settings");
  await expect(section).toBeVisible();
  await section.getByRole("combobox", { name: "Swipe right" }).tap();
  await page.getByRole("option", { name: "Favorite" }).tap();
  await section.getByRole("switch", { name: "Haptic feedback" }).tap();
  expect(await page.evaluate(() => [localStorage.getItem("ff:swipe-end"), localStorage.getItem("ff:haptics")])).toEqual(["star", "0"]);
  try {
    await openSettled(app);
    await touchSwipeOn(page, app.row(1), 220);
    await expect.poll(() => articleFlags(app.articleId(1)).isStarred).toBe(true);
    expect(articleFlags(app.articleId(1)).isRead).toBe(false);
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem("ff:swipe-end");
      localStorage.removeItem("ff:haptics");
    });
  }
});
