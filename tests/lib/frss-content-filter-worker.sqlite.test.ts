// #280 after #281: a feed's remove-selectors (FreshRSS `cssContentFilter`) run on the
// feed's own content inside the HTML worker's sanitize task — never on the main thread.
// Worker failures keep the pool's semantics: busy / unavailable defer the sync (no
// failure streak, nothing stored), timeout / memory store the affected item empty.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  body: "",
  fail: null as null | "busy" | "unavailable" | "timeout",
  calls: [] as Array<{ task: string; removeSelectors: unknown }>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ssrf")>();
  return {
    ...actual,
    fetchWithSsrfProtection: vi.fn(async () => ({ notModified: false, text: state.body, etag: null, lastModified: null, headers: new Headers() })),
  };
});
vi.mock("@/lib/html-worker/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/html-worker/pool")>();
  return {
    ...actual,
    runHtmlTask: vi.fn(async (task: string, input: { removeSelectors?: unknown }, opts?: unknown) => {
      if (task === "sanitizeFeedItems") {
        state.calls.push({ task, removeSelectors: input.removeSelectors });
        if (state.fail) throw new actual.HtmlWorkerError(state.fail, `test ${state.fail}`);
      }
      return (actual.runHtmlTask as (...args: unknown[]) => Promise<unknown>)(task, input, opts);
    }),
  };
});

import { syncFeed } from "../../lib/rss-sync";

const dir = mkdtempSync(join(tmpdir(), "feedferret-frss-filter-"));
let userId = "";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rss = (bodies: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>${bodies
    .map((body, i) => `<item><title>Item ${i}</title><link>https://f.example/${i}</link><guid>g-${i}</guid><description>${esc(body)}</description></item>`)
    .join("")}</channel></rss>`;

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  userId = (await state.db.user.create({ data: { email: "filter@test", name: "Filter" } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  state.fail = null;
  state.calls = [];
  await state.db.feed.deleteMany({ where: { userId } });
});

const newFeed = (url: string) =>
  state.db.feed.create({ data: { userId, name: "F", url, fullTextRemoveSelectors: ".ad, :is(.related, footer)" } });

describe("cssContentFilter on feed content runs in the worker sanitize task", () => {
  it("removes the selectors from stored content, in one task for the feed batch", async () => {
    state.body = rss(['<p>Keep A</p><div class="ad">Ad</div>', '<p>Keep B</p><aside class="related">R</aside><footer>F</footer>']);
    const feed = await newFeed("https://f.example/ok");
    await syncFeed(userId, feed.id);
    const rows = await state.db.article.findMany({ where: { feedId: feed.id }, orderBy: { link: "asc" }, select: { content: true } });
    expect(rows.map((r) => r.content)).toEqual(["<p>Keep A</p>", "<p>Keep B</p>"]);
    expect(state.calls).toEqual([{ task: "sanitizeFeedItems", removeSelectors: ".ad, :is(.related, footer)" }]);
  });

  it.each(["busy", "unavailable"] as const)("worker %s: sync deferred, no failure streak, nothing stored", async (reason) => {
    state.body = rss(["<p>x</p>"]);
    const feed = await newFeed(`https://f.example/${reason}`);
    state.fail = reason;
    const result = await syncFeed(userId, feed.id);
    expect(result).toMatchObject({ deferred: true });
    const after = await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(after).toMatchObject({ consecutiveFailureCount: 0, lastStatus: null, autoMuted: false });
    expect(await state.db.article.count({ where: { feedId: feed.id } })).toBe(0);
  });

  it("worker timeout (too complex): the item is stored empty, the feed sync succeeds", async () => {
    state.body = rss(["<p>x</p>"]);
    const feed = await newFeed("https://f.example/timeout");
    state.fail = "timeout";
    await syncFeed(userId, feed.id);
    const after = await state.db.feed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(after).toMatchObject({ lastStatus: "ok", consecutiveFailureCount: 0 });
    expect((await state.db.article.findMany({ where: { feedId: feed.id }, select: { content: true } })).map((r) => r.content)).toEqual([""]);
  });
});
