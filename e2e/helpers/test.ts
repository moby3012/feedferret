import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { manifest, resetArticleState, type SeedUser } from "./db";

/** localStorage key that suppresses the (modal) PWA install hint on mobile. */
export const PWA_DISMISSED_KEY = "feedferret:pwa-install-prompt-dismissed";

/**
 * The visible list pane. The shell keeps one list pane per tab mounted (hidden
 * + inert when inactive, so its scroll offset survives): row selectors must be
 * scoped to the active one.
 */
export const ACTIVE_LIST = '[data-pane^="list-"][data-active="true"]';

/**
 * Thin page object. When selectors change during refactors (e.g. URL-based
 * navigation) only this file should need updating, not the specs.
 */
export class App {
  constructor(
    readonly page: Page,
    readonly isMobile: boolean,
    readonly user: SeedUser,
    readonly userKey: string,
  ) {}

  /** "#007" -> article row (role=button wrapper with aria-label "[Unread: ]Title — Feed"). */
  row(num: number): Locator {
    return this.page.locator(`${ACTIVE_LIST} [role="button"][aria-label*="(#${String(num).padStart(3, "0")})"]`);
  }
  /** Every article row of the visible list. */
  rows(): Locator {
    return this.page.locator(`${ACTIVE_LIST} [data-article-id]`);
  }
  /** Rows of the visible list whose accessible name contains `text`. */
  rowsMatching(text: string): Locator {
    return this.page.locator(`${ACTIVE_LIST} [role="button"][aria-label*="${text}"]`);
  }
  /** Native scroller of the visible list. */
  listScroller(): Locator {
    return this.page.locator(`${ACTIVE_LIST} [data-testid="list-scroller"]`);
  }
  /** Native scroller of the reader. */
  readerScroller(): Locator {
    return this.page.locator('[data-pane="reader"] [data-testid="reader-scroller"]');
  }
  /**
   * The shell has booted its history (`<html data-nav-ready>`): deep-link
   * parents are seeded and alias rewrites done, so a Back now traverses the
   * shell's stack. Next's router still mirrors each shell write a moment later
   * (a same-URL replaceState, which can make `page.goBack()` resolve before the
   * traversal): after goBack/goForward, poll the URL instead of reading it once.
   */
  async navReady() {
    await expect(this.page.locator("html")).toHaveAttribute("data-nav-ready", "true");
    expect(await this.page.evaluate(() => !!(history.state as { ff?: unknown } | null)?.ff)).toBe(true);
  }
  /** Current URL as path + search ("/?feed=…"). */
  where(): string {
    const url = new URL(this.page.url());
    return url.pathname + url.search;
  }
  /** Article id for a seeded article number (1-based, as in the title). */
  articleId(num: number) {
    return `e2e-${this.userKey}-${String(num - 1).padStart(3, "0")}`;
  }
  rowActions(num: number) {
    const row = this.row(num);
    return {
      read: row.getByRole("button", { name: /^Mark as (read|unread)$/ }),
      star: row.getByRole("button", { name: /^(Star|Remove star)$/ }),
      // When saved, a status badge ("Remove from Read Later") precedes the action button: take the last.
      later: row.getByRole("button", { name: /^(Save to Read Later|Remove from Read Later)$/ }).last(),
    };
  }

  /** Container of the open reader (header toolbar + article): nearest ancestor of <article> that holds the Back button. */
  reader(): Locator {
    return this.page.locator("article").locator('xpath=ancestor::div[.//button[@aria-label="Back"]][1]');
  }

  async open() {
    await this.page.goto("/");
    await expect(this.page.locator('[role="button"][aria-label*="(#001)"]')).toBeVisible({ timeout: 30_000 });
    // The list (GET /api/app/articles) can paint before the sidebar's feed
    // counts (server action) arrive; specs read those badges right away.
    await this.page.waitForLoadState("networkidle");
    await this.navReady();
  }

  /** Compact navigation: the floating tab bar (Neu · Gemerkt · Feeds · Suche). */
  tabBar(): Locator {
    return this.page.getByTestId("tab-bar");
  }
  /** A tab of the compact tab bar: "New" | "Saved" | "Feeds" | "Search". */
  tab(name: "New" | "Saved" | "Feeds" | "Search"): Locator {
    return this.tabBar().getByRole("tab", { name, exact: true });
  }

  /** Tab to return to after `openSidebar()` on mobile. */
  private returnTab: "New" | "Saved" | "Feeds" | "Search" | null = null;

  /**
   * Desktop: the sidebar is always visible. Mobile: the feeds tree is the
   * Feeds tab's root — switch to it (a second tap pops a pushed feed list).
   */
  async openSidebar() {
    if (!this.isMobile) return;
    if (this.where() === "/?tab=feeds") return;
    const current = await this.tabBar().getByRole("tab", { selected: true }).textContent();
    this.returnTab = (["New", "Saved", "Feeds", "Search"] as const).find((n) => n === current?.trim()) ?? "New";
    await this.tab("Feeds").tap();
    if (this.where() !== "/?tab=feeds") {
      await expect.poll(() => this.page.locator(".ff-shell").getAttribute("data-tab")).toBe("feeds");
      if (this.where() !== "/?tab=feeds") await this.tab("Feeds").tap(); // active tab with a pushed level: up
    }
    await expect.poll(() => this.where()).toBe("/?tab=feeds");
    await expect(this.sidebar().getByRole("button", { name: /^All articles/ }).first()).toBeVisible();
  }
  /** Mobile: back to the tab `openSidebar()` came from. */
  async closeSidebar() {
    if (!this.isMobile) return;
    const back = this.returnTab ?? "New";
    this.returnTab = null;
    if (back === "Feeds") return;
    await this.tab(back).tap();
    await expect(this.tab(back)).toHaveAttribute("aria-selected", "true");
  }
  sidebar(): Locator {
    return this.isMobile ? this.page.locator('[data-pane="sources"]') : this.page.locator("body");
  }
  /** Sidebar badge number for "All articles" | "Starred" | "Read later" | label | feed. */
  async sidebarCount(name: string): Promise<number> {
    await this.openSidebar();
    // The badge is omitted when the count is 0.
    const btn = this.sidebar().getByRole("button", { name: new RegExp(`^${name}\\s*\\d*$`) }).first();
    const text = (await btn.textContent()) ?? "";
    const n = Number(text.replace(/\D+/g, "") || 0);
    await this.closeSidebar();
    return n;
  }
  async selectSidebar(name: string | RegExp) {
    await this.openSidebar();
    this.returnTab = null; // selecting navigates: nothing to return to
    await this.sidebar().getByRole("button", { name }).first().click();
    // Compact Feeds root → feed is a push: let the pane slide in before measuring anything.
    if (this.isMobile) await this.panesSettled();
  }
  /** No pane transition (push / pop slide) is running. */
  async panesSettled() {
    await this.page.waitForFunction(() =>
      document.getAnimations().every((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
        return a.playState !== "running" || !target?.matches(".ff-shell > [data-pane]");
      }),
    );
  }
  /** Search: the Suche tab (mobile) / the sidebar's search icon (desktop); the field gets focus. */
  async openSearch() {
    if (this.isMobile) await this.tab("Search").tap();
    else await this.page.getByRole("button", { name: "Search articles" }).first().click();
    await expect(this.page.getByTestId("search-field").filter({ visible: true })).toBeFocused();
  }
  /** "Mark all as read" of the visible list: top-bar button (wide) / the "…" menu (compact). */
  async markAllRead() {
    if (!this.isMobile) {
      await this.page.getByRole("button", { name: "Mark all as read" }).filter({ visible: true }).first().click();
      return;
    }
    await this.page.locator(`${ACTIVE_LIST} [data-testid="list-menu-button"]`).tap();
    await this.page.getByRole("menuitem", { name: "Mark all as read" }).tap();
  }
  /** Tap/click (touch-aware) */
  async activate(locator: Locator) {
    if (this.isMobile) await locator.tap();
    else await locator.click();
  }
}

export const test = base.extend<{ app: App }>({
  // Every test starts from the pristine seeded read/star/read-later state.
  app: async ({ page, isMobile }, provide, testInfo) => {
    const userKey = String(testInfo.project.metadata.user ?? "desktop");
    resetArticleState(userKey);
    // Headless Chromium shell crashes the renderer on the SW's Badge API call;
    // the SW is not under test here and would add cross-test caching.
    await page.context().addInitScript(([key]) => {
      try { localStorage.setItem(key, "1"); } catch { /* ignore */ }
    }, [PWA_DISMISSED_KEY]);
    await provide(new App(page, isMobile, manifest().users[userKey], userKey));
  },
});

export { expect };
