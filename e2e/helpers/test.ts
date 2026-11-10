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
  /** The shell has written its history entry (`history.state.ff`): seeding / alias rewrite done. */
  async navReady() {
    await expect.poll(() => this.page.evaluate(() => !!(history.state as { ff?: unknown } | null)?.ff)).toBe(true);
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

  /** Desktop: sidebar is always visible. Mobile: it is a sheet behind the "Feeds" button. */
  async openSidebar() {
    if (!this.isMobile) return;
    if (await this.page.getByRole("dialog", { name: /feed navigation/i }).isVisible()) return;
    await this.page.getByRole("button", { name: "Feeds", exact: true }).tap();
    await expect(this.page.getByRole("dialog", { name: /feed navigation/i })).toBeVisible();
  }
  async closeSidebar() {
    if (!this.isMobile) return;
    await this.page.keyboard.press("Escape");
    await expect(this.page.getByRole("dialog", { name: /feed navigation/i })).toBeHidden();
  }
  sidebar(): Locator {
    return this.isMobile ? this.page.getByRole("dialog", { name: /feed navigation/i }) : this.page.locator("body");
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
    await this.sidebar().getByRole("button", { name }).first().click();
    if (this.isMobile) await this.page.getByRole("dialog", { name: /feed navigation/i }).waitFor({ state: "hidden" }).catch(() => {});
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
