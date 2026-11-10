import { describe, expect, it } from "vitest";
import { groupStories } from "@/components/list/group-stories";
import type { LegacyArticle } from "@/features/articles/legacy-adapter";

const row = (id: string, cluster?: { id: string; size: number; lead: string }): LegacyArticle =>
  ({
    id,
    title: id,
    isRead: false,
    clusterId: cluster?.id ?? null,
    clusterSize: cluster?.size ?? 0,
    clusterLeadId: cluster?.lead ?? null,
  }) as unknown as LegacyArticle;

describe("groupStories (one row per story)", () => {
  it("passes unclustered rows through in order", () => {
    const rows = groupStories([row("a"), row("b")]);
    expect(rows.map((r) => r.article.id)).toEqual(["a", "b"]);
    expect(rows.every((r) => r.story === null)).toBe(true);
  });

  it("collapses later members under the first occurrence and shows the lead when it is loaded", () => {
    const c = { id: "c1", size: 3, lead: "m2" };
    const rows = groupStories([row("m1", c), row("x"), row("m2", c), row("m3", c)]);
    expect(rows.map((r) => r.article.id)).toEqual(["m2", "x"]);
    const story = rows[0].story!;
    expect(story.clusterId).toBe("c1");
    expect(story.rep.id).toBe("m2");
    expect(story.siblings.map((s) => s.id)).toEqual(["m1", "m3"]);
    expect(story.more).toBe(2);
  });

  it("falls back to the first loaded member when the lead is not in the list", () => {
    const c = { id: "c1", size: 5, lead: "elsewhere" };
    const rows = groupStories([row("m1", c), row("m2", c)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].article.id).toBe("m1");
    expect(rows[0].story!.more).toBe(4); // server size − 1, not just the loaded ones
  });

  it("a single loaded member of a story still gets the card (+N other sources)", () => {
    const rows = groupStories([row("m1", { id: "c1", size: 2, lead: "m9" })]);
    expect(rows[0].story).toMatchObject({ clusterId: "c1", more: 1, siblings: [] });
  });

  it("ignores degenerate clusters (size < 2)", () => {
    const rows = groupStories([row("m1", { id: "c1", size: 1, lead: "m1" })]);
    expect(rows[0].story).toBeNull();
  });
});
