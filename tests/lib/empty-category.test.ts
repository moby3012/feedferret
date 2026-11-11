import { describe, expect, it } from "vitest";
import { isDeletableEmptyCategory } from "../../lib/empty-category";

const cats = [
  { id: "empty", parentId: null, children: [] },
  { id: "full", parentId: null, children: [] },
  { id: "parent", parentId: null, children: [{ id: "kid" }] },
  { id: "kid", parentId: "parent", children: [] },
  { id: "flat-parent", parentId: null },
  { id: "flat-kid", parentId: "flat-parent" },
];
const feeds = [{ categoryId: "full" }, { categoryId: null }, {}];

describe("isDeletableEmptyCategory", () => {
  it("offers an empty leaf category", () => {
    expect(isDeletableEmptyCategory("empty", feeds, cats)).toBe(true);
    expect(isDeletableEmptyCategory("kid", feeds, cats)).toBe(true);
  });
  it("never offers a category that has feeds", () => {
    expect(isDeletableEmptyCategory("full", feeds, cats)).toBe(false);
  });
  it("never offers a category that has subcategories (loaded as children or by parentId)", () => {
    expect(isDeletableEmptyCategory("parent", feeds, cats)).toBe(false);
    expect(isDeletableEmptyCategory("flat-parent", feeds, cats)).toBe(false);
  });
  it("never offers an unknown id", () => {
    expect(isDeletableEmptyCategory("ghost", feeds, cats)).toBe(false);
  });
});
