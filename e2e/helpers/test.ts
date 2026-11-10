import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { manifest, resetArticleState, type SeedUser } from "./db";
import { touchHoldOn } from "./gestures";

/** localStorage key that suppresses the (modal) PWA install hint on mobile. */
export const PWA_DISMISSED_KEY = "feedferret:pwa-install-prompt-dismissed";
/** localStorage key of the one-time gesture hint (lib/gestures/coach.ts): "done" = never show. */
export const GESTURE_HINT_KEY = "ff:gesture-hint";

export type RowToggle = "read" | "star" | "later";
const MENU_ITEM: Record<RowToggle, RegExp> = {
  read: /^Mark as (read|unread)$/,
  star: /^(Star|Remove star)$/,
  later: /^(Save to Read Later|Remove from Read Later)$/,
};

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
  /** "↑ N neu" pill of the visible list (rendered hidden at 0). */
  newItemsPill(): Locator {
    return this.page.locator(`${ACTIVE_LIST} [data-testid="new-items-pill"]`);
  }
  /** Muted unread number in the list top bar (absent when 0 or hidden by "Show counts"). */
  listCount(): Locator {
    return this.page.locator(`${ACTIVE_LIST} [data-testid="list-count"]`);
  }
  /** First row whose bottom is below the scroller's top edge: its id and viewport y. */
  async firstVisibleRow(): Promise<{ id: string; top: number }> {
    return this.listScroller().evaluate((el) => {
      const edge = el.getBoundingClientRect().top;
      for (const row of Array.from(el.querySelectorAll<HTMLElement>("[data-article-id]"))) {
        const r = row.getBoundingClientRect();
        if (r.bottom > edge + 1) return { id: row.dataset.articleId ?? "", top: r.top };
      }
      return { id: "", top: -1 };
    });
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
  /**
   * The offline-reading boot pass (4 s after mount: session check, Read-later
   * list, paced bodies) has finished everything it planned — its requests can
   * no longer land in a measuring window (features/offline/offline-sync.tsx).
   */
  async offlinePassDone() {
    await expect(this.page.locator("html")).toHaveAttribute("data-offline-sync", "idle", { timeout: 30_000 });
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
  /** The row's host (`.ff-row`): carries `data-unread` / `data-starred` / `data-later`. */
  rowHost(num: number): Locator {
    return this.row(num).locator("xpath=..");
  }
  /**
   * The in-row action buttons — mouse / fine pointers only. Touch rows have no
   * buttons (owner decision 2026-11-10): use `toggle()` / `expectRow()`.
   */
  rowActions(num: number) {
    if (this.isMobile) throw new Error("rowActions(): touch rows have no buttons — use app.toggle() / app.expectRow()");
    const row = this.row(num);
    return {
      read: row.getByRole("button", { name: /^Mark as (read|unread)$/ }),
      star: row.getByRole("button", { name: /^(Star|Remove star)$/ }),
      // When saved, a status badge ("Remove from Read Later") precedes the action button: take the last.
      later: row.getByRole("button", { name: /^(Save to Read Later|Remove from Read Later)$/ }).last(),
    };
  }

  /**
   * Toggle read / star / later on a row the way the device offers it: the
   * in-row button with a mouse, the long-press menu on touch.
   */
  async toggle(target: number | Locator, action: RowToggle) {
    const row = typeof target === "number" ? this.row(target) : target;
    if (!this.isMobile) {
      await row.getByRole("button", { name: MENU_ITEM[action] }).last().click();
      return;
    }
    if (await this.page.evaluate(() => navigator.onLine)) {
      await touchHoldOn(this.page, row);
    } else {
      // Offline: a CDP touch session would reset Playwright's offline emulation
      // (navigator.onLine flips back). Use the row's screen-reader "Actions"
      // button instead — the same menu, keyboard-activated.
      await row.locator("xpath=..").getByRole("button", { name: /^Actions: / }).focus();
      await this.page.keyboard.press("Enter");
    }
    const menu = this.page.getByTestId("article-context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: MENU_ITEM[action] }).tap();
    await expect(menu).toBeHidden();
  }
  /**
   * Logic-level toggle for tests that drive timing (fake clock, one batch
   * window): clicks the row's action button in the page. On touch that button
   * is hidden (display: none) but still runs the very same handler a mouse
   * click does; the touch INPUT path is covered by `toggle()` and the gesture specs.
   */
  async toggleDirect(num: number, action: RowToggle) {
    const label = MENU_ITEM[action];
    await this.row(num).evaluate((row, source) => {
      const re = new RegExp(source);
      const buttons = [...row.querySelectorAll("button")].filter((b) => re.test(b.getAttribute("aria-label") ?? ""));
      buttons[buttons.length - 1]!.click();
    }, label.source);
  }
  /** Row state from the row's data attributes; with a mouse the buttons' labels must agree. */
  async expectRow(num: number, state: { read?: boolean; starred?: boolean; later?: boolean }) {
    const host = this.rowHost(num);
    const flag = async (attr: string, on: boolean | undefined) => {
      if (on === undefined) return;
      if (on) await expect(host).toHaveAttribute(attr, "");
      else await expect(host).not.toHaveAttribute(attr, "");
    };
    await flag("data-unread", state.read === undefined ? undefined : !state.read);
    await flag("data-starred", state.starred);
    await flag("data-later", state.later);
    if (this.isMobile) return;
    const buttons = this.rowActions(num);
    if (state.read !== undefined) await expect(buttons.read).toHaveAccessibleName(state.read ? "Mark as unread" : "Mark as read");
    if (state.starred !== undefined) await expect(buttons.star).toHaveAccessibleName(state.starred ? "Remove star" : "Star");
    if (state.later !== undefined) await expect(buttons.later).toHaveAccessibleName(state.later ? "Remove from Read Later" : "Save to Read Later");
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
    // The muted count is omitted at 0 and reads "99+" above 99: the exact number is `data-unread-count`.
    const btn = this.sidebar().getByRole("button", { name: new RegExp(`^${name}(\\s*(\\d+|99\\+))?$`) }).first();
    await expect(btn).toBeVisible();
    const count = btn.locator("[data-unread-count]");
    const n = (await count.count()) ? Number(await count.first().getAttribute("data-unread-count")) : 0;
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

export const test = base.extend<{ app: App; gestureHint: boolean }>({
  /** `test.use({ gestureHint: true })`: keep the one-time gesture hint (off everywhere else). */
  gestureHint: [false, { option: true }],
  // Every test starts from the pristine seeded read/star/read-later state.
  app: async ({ page, isMobile, gestureHint }, provide, testInfo) => {
    const userKey = String(testInfo.project.metadata.user ?? "desktop");
    resetArticleState(userKey);
    // Headless Chromium shell crashes the renderer on the SW's Badge API call;
    // the SW is not under test here and would add cross-test caching.
    await page.context().addInitScript(
      ([key, hintKey, hint]) => {
        try {
          localStorage.setItem(key, "1");
          if (!hint) localStorage.setItem(hintKey, "done");
        } catch {
          /* ignore */
        }
      },
      [PWA_DISMISSED_KEY, GESTURE_HINT_KEY, gestureHint] as const,
    );
    await provide(new App(page, isMobile, manifest().users[userKey], userKey));
  },
});

export { expect };
