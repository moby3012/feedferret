import { describe, expect, it } from "vitest";
import { queryUsesAiDerivedOperators, ruleHasAiDeleteConflict } from "../../lib/rule-ai-operators";

describe("queryUsesAiDerivedOperators", () => {
  it.each([
    "is:sponsored",
    "-is:sponsored",
    "is:clickbait feed:foo",
    "status:ad",
    "is:Werbung",
    'is:"anzeige"',
    "entity:EZB",
    'foo entity:"Angela Merkel"',
    "(ent:NASA OR is:clickbait)",
    "-entities:OpenAI",
  ])("detects %s", (q) => expect(queryUsesAiDerivedOperators(q)).toBe(true));

  it.each(["is:unread", "is:starred", "title:entity", "tag:clickbait", "is:sponsoredish", "author:ent", "", null, undefined])(
    "ignores %s",
    (q) => expect(queryUsesAiDerivedOperators(q as string)).toBe(false),
  );
});

describe("ruleHasAiDeleteConflict", () => {
  it("flags AI operators combined with delete, in any action position", () => {
    expect(ruleHasAiDeleteConflict("is:sponsored", ["delete"])).toBe(true);
    expect(ruleHasAiDeleteConflict("entity:EZB", ["mark_read", "delete"])).toBe(true);
  });
  it("allows delete for ordinary queries and AI operators for non-destructive actions", () => {
    expect(ruleHasAiDeleteConflict("is:unread older:30d", ["delete"])).toBe(false);
    expect(ruleHasAiDeleteConflict("is:clickbait", ["mark_read", "notify_inapp"])).toBe(false);
  });
});
