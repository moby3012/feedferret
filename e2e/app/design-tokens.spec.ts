import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/test";
import { setAccentColor } from "../helpers/db";

/**
 * Design-token foundation (spec §4 / PR 3): hit targets, motion ceiling,
 * reduced motion, token resolution and the user accent system.
 */

const firstRow = (page: Page) => page.locator('[role="button"][aria-label*="(#001)"]');

/** Effective hit box = border box ∪ the `.hit-slop::after` box (coarse pointers only). */
async function undersizedBarButtons(page: Page) {
  return page.evaluate(() => {
    const MIN = 43.5; // sub-pixel rounding tolerance for 44
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("header button, nav button, [role=toolbar] button")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[inert],[aria-hidden=true]")) continue;
      const after = getComputedStyle(el, "::after");
      const hasSlop = after.content !== "none" && after.position === "absolute";
      const w = Math.max(r.width, hasSlop ? parseFloat(after.width) || 0 : 0);
      const h = Math.max(r.height, hasSlop ? parseFloat(after.height) || 0 : 0);
      if (w < MIN || h < MIN) {
        out.push(`${el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 24) ?? "?"} ${Math.round(w)}x${Math.round(h)}`);
      }
    }
    return out;
  });
}

/** In-flight animations/transitions that move things, or outlast the 320 ms ceiling. */
async function motionOffenders(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => {
        const eff = a.effect as KeyframeEffect | null;
        if (!eff) return null;
        const t = eff.getComputedTiming();
        const infinite = t.iterations === Infinity;
        const props = new Set<string>();
        for (const k of eff.getKeyframes()) for (const p of Object.keys(k)) props.add(p);
        const moves = ["transform", "translate", "scale", "rotate"].some((p) => props.has(p));
        const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "?";
        // delay is deliberately excluded: the stagger helpers (.animation-delay-*) go away with the list/reader PRs
        return { name, moves, infinite, duration: Number(t.duration), target: (eff.target as HTMLElement | null)?.className?.toString().slice(0, 60) };
      })
      .filter(Boolean),
  );
}

test.describe("hit targets", () => {
  test("every button in the bars has a ≥44×44 hit box on coarse pointers", async ({ app, page, isMobile }) => {
    test.skip(!isMobile, "coarse pointer only");
    await app.open();
    expect(await undersizedBarButtons(page), "list bars").toEqual([]);
    await firstRow(page).tap();
    await expect(page.locator("article").first()).toBeVisible();
    expect(await undersizedBarButtons(page), "reader bars").toEqual([]);
  });
});

test.describe("motion", () => {
  test("nothing animates or transitions longer than 320 ms", async ({ app, page }) => {
    await app.open();
    await app.activate(firstRow(page));
    await expect(page.locator("article").first()).toBeVisible();
    for (let i = 0; i < 4; i++) {
      const slow = (await motionOffenders(page)).filter((o) => o && !o.infinite && o.duration > 321);
      expect(slow, JSON.stringify(slow)).toEqual([]);
      await page.waitForTimeout(40);
    }
  });

  test("prefers-reduced-motion: zero transform animations", async ({ app, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.open();
    await app.openSidebar();
    await app.closeSidebar();
    await app.activate(firstRow(page));
    await expect(page.locator("article").first()).toBeVisible();
    for (let i = 0; i < 6; i++) {
      const moving = (await motionOffenders(page)).filter((o) => o && o.moves && o.duration > 1.01);
      expect(moving, JSON.stringify(moving)).toEqual([]);
      await page.waitForTimeout(30);
    }
  });

  test("html does not opt into smooth scrolling", async ({ app, page }) => {
    await app.open();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  });
});

test.describe("tokens", () => {
  test("radius pins, z-scale, safe-area vars and viewport meta resolve", async ({ app, page }) => {
    await app.open();
    const r = await page.evaluate(() => {
      const probe = (cls: string) => {
        const el = document.createElement("div");
        el.className = cls;
        document.body.appendChild(el);
        const v = getComputedStyle(el).borderTopLeftRadius;
        el.remove();
        return v;
      };
      const root = getComputedStyle(document.documentElement);
      const sizes = ["sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map((k) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--radius-${k}`)));
      return {
        sizes,
        zOverlay: root.getPropertyValue("--z-overlay").trim(),
        hit: root.getPropertyValue("--hit-min").trim(),
        dur: root.getPropertyValue("--dur-slow").trim(),
        safeB: root.getPropertyValue("--safe-b").trim(),
        xl2: probe("rounded-2xl"),
        xl3: probe("rounded-3xl"),
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
      };
    });
    for (let i = 1; i < r.sizes.length; i++) expect(r.sizes[i], `radius scale step ${i}`).toBeGreaterThanOrEqual(r.sizes[i - 1]);
    expect(r.xl2).toBe("20px");
    expect(r.xl3).toBe("28px");
    expect(r.zOverlay).toBe("50");
    expect(r.hit).toBe("44px");
    expect(r.dur === "320ms" || r.dur === ".32s" || r.dur === "0.32s").toBe(true); // minifier may rewrite ms → s
    expect(r.safeB).toMatch(/^\d+(\.\d+)?px$/); // env() resolved (0px without a notch)
    expect(r.viewport).toContain("interactive-widget=resizes-content");
  });

  test("user accent colour still drives the brand-derived roles", async ({ app, page }) => {
    const user = app.userKey;
    setAccentColor(user, "#ff0000");
    try {
      await page.goto("/");
      await expect(firstRow(page)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--brand")), { timeout: 15_000 }).toBe("#ff0000");
      const tint = await page.evaluate(() => {
        const el = document.createElement("div");
        el.style.background = "var(--accent-subtle)";
        document.body.appendChild(el);
        const bg = getComputedStyle(el).backgroundColor;
        el.remove();
        return bg;
      });
      // 14 %/20 % mix of the *user's* red, i.e. a translucent colour whose red channel dominates.
      const nums = (tint.match(/-?\d*\.?\d+/g) ?? []).map(Number);
      expect(tint).not.toBe("rgba(0, 0, 0, 0)");
      expect(nums.length).toBeGreaterThanOrEqual(3);
      if (/^rgba?\(/.test(tint)) expect(nums[0]).toBeGreaterThan(nums[1]);
    } finally {
      setAccentColor(user, "#5BA4CF");
    }
  });
});
