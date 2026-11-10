import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, getDatabaseProvider: () => "sqlite" }));

import { keysetWhere } from "../../server/articles/list";

describe("keysetWhere", () => {
  const t = Date.UTC(2026, 0, 1);

  it("adds a sargable bound on the leading column before the row-value OR (desc)", () => {
    expect(keysetWhere(["publishedAt", "createdAt", "id"], [t, t + 1, "x"], "desc")).toEqual({
      AND: [
        { publishedAt: { lte: new Date(t) } },
        {
          OR: [
            { publishedAt: { lt: new Date(t) } },
            { publishedAt: new Date(t), createdAt: { lt: new Date(t + 1) } },
            { publishedAt: new Date(t), createdAt: new Date(t + 1), id: { lt: "x" } },
          ],
        },
      ],
    });
  });

  it("uses gte/gt ascending and works for the readAt keyset", () => {
    expect(keysetWhere(["readAt", "id"], [t, "y"], "asc")).toEqual({
      AND: [{ readAt: { gte: new Date(t) } }, { OR: [{ readAt: { gt: new Date(t) } }, { readAt: new Date(t), id: { gt: "y" } }] }],
    });
  });
});
