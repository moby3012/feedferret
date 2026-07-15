import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory fake `db.article` ──────────────────────────────────────────────
// upsertArticleBatch (lib/rss-sync.ts) replaced a per-article
// findUnique -> upsert -> cross-feed findFirst -> update loop with a small,
// fixed number of batched queries. This fake mimics just enough of Prisma's
// `article` delegate (findMany / createManyAndReturn / update / upsert) to
// exercise that batching against realistic data, without a real database.

type FakeArticle = {
  id: string;
  feedId: string;
  userId: string;
  title: string;
  link: string;
  externalId: string | null;
  dedupeKey: string | null;
  contentHash: string | null;
  content: string;
  excerpt: string | null;
  author: string | null;
  publishedAt: Date;
  imageUrl: string | null;
  isDuplicate: boolean;
  duplicateOf: string | null;
  createdAt: Date;
};

let store: FakeArticle[] = [];
let idCounter = 0;
let createdAtCounter = 0;

function nextId() {
  idCounter += 1;
  return `article-${idCounter}`;
}

// Monotonically increasing timestamps so `orderBy: { createdAt: "asc" }` behaves
// deterministically even for rows inserted in the same `createManyAndReturn` call
// (a real DB's `now()` default could tie within one statement).
function nextCreatedAt() {
  createdAtCounter += 1;
  return new Date(2024, 0, 1, 0, 0, 0, createdAtCounter);
}

function matchesWhere(row: FakeArticle, where: any): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.feedId !== undefined && row.feedId !== where.feedId) return false;
  if (where.isDuplicate !== undefined && row.isDuplicate !== where.isDuplicate) return false;
  if (where.dedupeKey?.in && !where.dedupeKey.in.includes(row.dedupeKey)) return false;
  if (where.contentHash?.in && !where.contentHash.in.includes(row.contentHash)) return false;
  return true;
}

function select(row: FakeArticle, fields?: Record<string, boolean>) {
  if (!fields) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (fields[key]) out[key] = (row as any)[key];
  }
  return out;
}

const db = {
  article: {
    findMany: vi.fn(async ({ where, select: sel, orderBy }: any) => {
      let rows = store.filter((row) => matchesWhere(row, where));
      if (orderBy?.createdAt === "asc") rows = rows.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return rows.map((row) => select(row, sel));
    }),
    createManyAndReturn: vi.fn(async ({ data, select: sel }: any) => {
      const created: FakeArticle[] = data.map((d: any) => ({
        id: nextId(),
        feedId: d.feedId,
        userId: d.userId,
        title: d.title,
        link: d.link,
        externalId: d.externalId ?? null,
        dedupeKey: d.dedupeKey ?? null,
        contentHash: d.contentHash ?? null,
        content: d.content,
        excerpt: d.excerpt ?? null,
        author: d.author ?? null,
        publishedAt: d.publishedAt,
        imageUrl: d.imageUrl ?? null,
        isDuplicate: false,
        duplicateOf: null,
        createdAt: nextCreatedAt(),
      }));
      store.push(...created);
      return created.map((row) => select(row, sel));
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.find((r) => r.id === where.id);
      if (!row) throw new Error(`row not found: ${where.id}`);
      Object.assign(row, data);
      return { ...row };
    }),
    upsert: vi.fn(async ({ where, update, create, select: sel }: any) => {
      const key = where.userId_feedId_dedupeKey;
      const existing = store.find(
        (r) => r.userId === key.userId && r.feedId === key.feedId && r.dedupeKey === key.dedupeKey,
      );
      if (existing) {
        Object.assign(existing, update);
        return select(existing, sel);
      }
      const row: FakeArticle = {
        id: nextId(),
        feedId: create.feedId,
        userId: create.userId,
        title: create.title,
        link: create.link,
        externalId: create.externalId ?? null,
        dedupeKey: create.dedupeKey ?? null,
        contentHash: create.contentHash ?? null,
        content: create.content,
        excerpt: create.excerpt ?? null,
        author: create.author ?? null,
        publishedAt: create.publishedAt,
        imageUrl: create.imageUrl ?? null,
        isDuplicate: false,
        duplicateOf: null,
        createdAt: nextCreatedAt(),
      };
      store.push(row);
      return select(row, sel);
    }),
  },
};

vi.mock("../../lib/db", () => ({ db }));

function seedExisting(row: Partial<FakeArticle> & { userId: string; feedId: string; dedupeKey: string }) {
  const article: FakeArticle = {
    id: nextId(),
    title: "Existing title",
    link: "https://example.com/existing",
    externalId: null,
    contentHash: "hash-existing",
    content: "existing content",
    excerpt: "existing excerpt",
    author: null,
    publishedAt: new Date(2023, 0, 1),
    imageUrl: null,
    isDuplicate: false,
    duplicateOf: null,
    createdAt: nextCreatedAt(),
    ...row,
  };
  store.push(article);
  return article;
}

type ArticleSyncInput = {
  feedId: string;
  userId: string;
  title: string;
  link: string;
  externalId: string | null;
  dedupeKey: string;
  contentHash: string | null;
  content: string;
  excerpt: string;
  author: string | null;
  publishedAt: Date;
  imageUrl?: string | null;
};

function makeInput(overrides: Partial<ArticleSyncInput> = {}): ArticleSyncInput {
  return {
    feedId: "feed-1",
    userId: "user-1",
    title: "A title",
    link: "https://example.com/a",
    externalId: null,
    dedupeKey: "dedupe-a",
    contentHash: "hash-a",
    content: "<p>content</p>",
    excerpt: "content",
    author: null,
    publishedAt: new Date(2024, 5, 1),
    imageUrl: null,
    ...overrides,
  };
}

describe("upsertArticleBatch", () => {
  beforeEach(() => {
    store = [];
    idCounter = 0;
    createdAtCounter = 0;
    vi.clearAllMocks();
  });

  it("inserts genuinely-new articles and reports them as created", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const result = await upsertArticleBatch([
      makeInput({ dedupeKey: "k1", contentHash: "h1", link: "https://example.com/1", title: "One" }),
      makeInput({ dedupeKey: "k2", contentHash: "h2", link: "https://example.com/2", title: "Two" }),
    ]);

    expect(result.createdArticleIds).toHaveLength(2);
    expect(result.upsertedIds).toHaveLength(2);
    expect(store).toHaveLength(2);
    expect(store.map((a) => a.title).sort()).toEqual(["One", "Two"]);
  });

  it("skips writing to an existing row when nothing actually changed", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const existing = seedExisting({
      userId: "user-1",
      feedId: "feed-1",
      dedupeKey: "k1",
      title: "Same title",
      link: "https://example.com/1",
      content: "same content",
      excerpt: "same content",
      publishedAt: new Date(2024, 5, 1),
      imageUrl: null,
    });

    const result = await upsertArticleBatch([
      makeInput({
        dedupeKey: "k1",
        title: "Same title",
        link: "https://example.com/1",
        content: "same content",
        excerpt: "same content",
        publishedAt: new Date(2024, 5, 1),
        imageUrl: null,
      }),
    ]);

    expect(result.createdArticleIds).toHaveLength(0);
    expect(result.upsertedIds).toEqual([existing.id]);
    // No update should have been issued for an unchanged row.
    expect(db.article.update).not.toHaveBeenCalled();
  });

  it("updates an existing row whose fetched content actually changed", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const existing = seedExisting({
      userId: "user-1",
      feedId: "feed-1",
      dedupeKey: "k1",
      title: "Old title",
      content: "old content",
      excerpt: "old",
    });

    const result = await upsertArticleBatch([
      makeInput({ dedupeKey: "k1", title: "New title", content: "new content", excerpt: "new" }),
    ]);

    expect(result.createdArticleIds).toHaveLength(0);
    expect(result.upsertedIds).toEqual([existing.id]);
    expect(db.article.update).toHaveBeenCalledTimes(1);
    const updated = store.find((a) => a.id === existing.id)!;
    expect(updated.title).toBe("New title");
    expect(updated.content).toBe("new content");
  });

  it("links a newly-created article to an existing cross-feed duplicate by contentHash", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const canonical = seedExisting({
      userId: "user-1",
      feedId: "other-feed",
      dedupeKey: "other-key",
      contentHash: "shared-hash",
      title: "Canonical article",
    });

    const result = await upsertArticleBatch([
      makeInput({ dedupeKey: "k1", contentHash: "shared-hash", title: "Synced elsewhere" }),
    ]);

    expect(result.createdArticleIds).toHaveLength(1);
    const created = store.find((a) => a.id === result.createdArticleIds[0])!;
    expect(created.isDuplicate).toBe(true);
    expect(created.duplicateOf).toBe(canonical.id);
  });

  it("resolves two new articles sharing a contentHash within the same batch: first stays canonical, second becomes its duplicate", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const result = await upsertArticleBatch([
      makeInput({ dedupeKey: "k1", contentHash: "same-hash", title: "First (canonical)" }),
      makeInput({ dedupeKey: "k2", contentHash: "same-hash", title: "Second (duplicate)" }),
    ]);

    expect(result.createdArticleIds).toHaveLength(2);
    const first = store.find((a) => a.title === "First (canonical)")!;
    const second = store.find((a) => a.title === "Second (duplicate)")!;

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.duplicateOf).toBe(first.id);
  });

  it("does not mark an article as its own duplicate when it is the only match for its hash", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const result = await upsertArticleBatch([
      makeInput({ dedupeKey: "k1", contentHash: "unique-hash", title: "Solo" }),
    ]);

    const created = store.find((a) => a.id === result.createdArticleIds[0])!;
    expect(created.isDuplicate).toBe(false);
    expect(created.duplicateOf).toBeNull();
  });

  it("folds duplicate dedupe keys within one batch (loose unicityCriteria) so the last values win without a unique-constraint crash", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const result = await upsertArticleBatch([
      makeInput({ dedupeKey: "same-key", contentHash: "h1", title: "First pass" }),
      makeInput({ dedupeKey: "same-key", contentHash: "h1", title: "Second pass (wins)" }),
    ]);

    expect(store).toHaveLength(1);
    expect(result.createdArticleIds).toHaveLength(1);
    expect(store[0].title).toBe("Second pass (wins)");
  });

  it("returns empty results for an empty batch without querying the db", async () => {
    const { upsertArticleBatch } = await import("../../lib/rss-sync");

    const result = await upsertArticleBatch([]);

    expect(result).toEqual({ upsertedIds: [], createdArticleIds: [] });
    expect(db.article.findMany).not.toHaveBeenCalled();
  });
});
