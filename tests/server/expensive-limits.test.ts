vi.mock("@/lib/media-proxy", () => ({ presentMedia: async (items: unknown[]) => items }));
// N13: per-user limits on the expensive reads and writes (search list, count,
// "mark up to here" range, hot-toggle batches) and the Postgres statement
// timeout around search reads. The data layer is mocked: these tests pin the
// limiter wiring, not the queries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: "alice",
  provider: "sqlite" as "sqlite" | "postgresql",
  executed: [] as string[],
  listCalls: [] as unknown[],
  markRangeCalls: 0,
  applyCalls: 0,
}));

vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: h.userId } })) }));
vi.mock("@/lib/db", () => {
  const tx = {
    article: { count: vi.fn(async () => 7) },
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      h.executed.push(sql);
      return 0;
    }),
  };
  return {
    getDatabaseProvider: () => h.provider,
    db: {
      user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, email: `${where.id}@test`, name: null, role: "user", isActive: true })) },
      article: { count: vi.fn(async () => 7) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock("@/server/articles/list", () => ({
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  InvalidCursorError: class extends Error {},
  listArticles: vi.fn(async (_userId: string, params: unknown) => {
    h.listCalls.push(params);
    return { items: [], nextCursor: null, snapshotAt: 1 };
  }),
}));
vi.mock("@/server/articles/view-scope", () => ({ buildViewScope: vi.fn(async () => ({ where: { userId: h.userId }, keyset: ["publishedAt", "id"] })) }));
vi.mock("@/server/articles/state", () => ({
  parseStateOps: (ops: unknown) => ({ ok: true, ops }),
  parseMarkIds: (ids: unknown) => ({ ok: true, ids }),
  markIdsRead: vi.fn(async () => ({ ids: [], complete: true, remaining: [] })),
  applyArticleStateOps: vi.fn(async () => {
    h.applyCalls++;
    return { failed: [], affected: [], cascades: [] };
  }),
}));
vi.mock("@/server/articles/mark-range", () => ({
  RangeTooLargeError: class extends Error {},
  parseMarkRange: (input: unknown) => ({ ok: true, range: input }),
  markRangeRead: vi.fn(async () => {
    h.markRangeCalls++;
    return { ids: ["a1"], complete: true, remaining: [] };
  }),
}));

import { GET as listGET } from "../../app/api/app/articles/route";
import { GET as countGET } from "../../app/api/app/articles/count/route";
import { applyArticleStateOps, markListRangeRead } from "../../app/actions/article-state";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { isStatementTimeout, SEARCH_STATEMENT_TIMEOUT_MS } from "../../lib/statement-timeout";

let n = 0;
beforeEach(() => {
  // A fresh user per test: the in-memory limiter keeps its windows between tests.
  h.userId = `user-${++n}`;
  h.provider = "sqlite";
  h.executed = [];
  h.listCalls = [];
  h.markRangeCalls = 0;
  h.applyCalls = 0;
});

const list = (qs: string) => listGET(new Request(`https://ff.test/api/app/articles?${qs}`));
const count = (qs: string) => countGET(new Request(`https://ff.test/api/app/articles/count?${qs}`));

describe("GET /api/app/articles (N13)", () => {
  it("limits ad-hoc search per user: the 61st query in a minute is 429", async () => {
    for (let i = 0; i < RATE_LIMITS.articleSearch.limit; i++) expect((await list(`q=term${i}`)).status).toBe(200);
    const limited = await list("q=one-more");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(h.listCalls).toHaveLength(RATE_LIMITS.articleSearch.limit);
    // Another user is unaffected.
    h.userId = `${h.userId}-other`;
    expect((await list("q=term")).status).toBe(200);
  });

  it("never limits plain list paging (no q)", async () => {
    for (let i = 0; i < RATE_LIMITS.articleSearch.limit + 5; i++) expect((await list("show=unread")).status).toBe(200);
  });

  it("runs search under SET LOCAL statement_timeout on Postgres only", async () => {
    await list("q=term");
    expect(h.executed).toEqual([]);
    h.provider = "postgresql";
    await list("q=term");
    expect(h.executed).toEqual([`SET LOCAL statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`]);
    h.executed = [];
    await list("feed=f1");
    expect(h.executed).toEqual([]);
  });
});

describe("GET /api/app/articles/count (N13)", () => {
  it("limits counts per user: the 121st in a minute is 429", async () => {
    for (let i = 0; i < RATE_LIMITS.articleCount.limit; i++) expect((await count("q=x")).status).toBe(200);
    expect((await count("q=x")).status).toBe(429);
  });

  it("counts on Postgres inside the statement timeout", async () => {
    h.provider = "postgresql";
    const res = await count("ss=s1");
    expect(await res.json()).toEqual({ unread: 7 });
    expect(h.executed).toHaveLength(1);
  });
});

describe("article state actions (N13)", () => {
  const range = { listKey: "/?feed=f1", sort: "new", fromId: "a1", toId: "a9", maxCreatedAt: 1, extraIds: [] };

  it("markListRangeRead returns rateLimited after 20 calls a minute and changes nothing", async () => {
    for (let i = 0; i < RATE_LIMITS.rangeMark.limit; i++) expect((await markListRangeRead(range)).rateLimited).toBeUndefined();
    expect(await markListRangeRead(range)).toEqual({ ids: [], undoToken: null, rateLimited: true });
    expect(h.markRangeCalls).toBe(RATE_LIMITS.rangeMark.limit);
  });

  it("applyArticleStateOps fails every op (rolled back by the client) above the limit", async () => {
    const ops = [{ id: "a1", isRead: true }, { id: "a2", isStarred: true }];
    for (let i = 0; i < RATE_LIMITS.stateOps.limit; i++) await applyArticleStateOps(ops);
    const result = await applyArticleStateOps(ops);
    expect(result).toEqual({ failed: ["a1", "a2"], affected: [], cascades: [], rateLimited: true });
    expect(h.applyCalls).toBe(RATE_LIMITS.stateOps.limit);
  });
});

describe("isStatementTimeout", () => {
  it("recognises the Postgres cancel however it is wrapped", () => {
    expect(isStatementTimeout(new Error("canceling statement due to statement timeout"))).toBe(true);
    expect(isStatementTimeout(Object.assign(new Error("db error"), { code: "57014" }))).toBe(true);
    expect(isStatementTimeout(new Error("unique constraint"))).toBe(false);
  });
});
