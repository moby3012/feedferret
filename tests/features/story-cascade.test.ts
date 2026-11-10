import { describe, expect, it } from "vitest";
import { planStoryCascade } from "../../features/articles/story-cascade";

describe("planStoryCascade", () => {
  const none = () => undefined;

  it("keeps the server's grouping: two stories in one flush, Undo covers both, each under its own origin", () => {
    const plan = planStoryCascade(
      [
        { origin: "lead-a", ids: ["a1", "a2"] },
        { origin: "card-b", ids: ["b1"] },
      ],
      none,
      () => true,
    );
    expect(plan.groups).toEqual([
      { origin: "lead-a", ids: ["a1", "a2"] },
      { origin: "card-b", ids: ["b1"] },
    ]);
    expect(plan.undo).toEqual(["lead-a", "card-b"]);
    expect(plan.total).toBe(3);
    expect(plan.restore).toEqual([]);
  });

  it("never overwrites a newer pending / in-flight toggle of a cascaded id", () => {
    const pending = new Map([["a2", false], ["b1", true]]);
    const plan = planStoryCascade(
      [
        { origin: "lead-a", ids: ["a1", "a2"] },
        { origin: "card-b", ids: ["b1"] },
      ],
      (id) => pending.get(id),
      () => true,
    );
    expect(plan.groups).toEqual([{ origin: "lead-a", ids: ["a1"] }]);
    expect(plan.undo).toEqual(["lead-a"]);
    expect(plan.total).toBe(1);
  });

  it("a story taken back (origin unread) while the call was in flight is restored at once, without an Undo toast", () => {
    const plan = planStoryCascade([{ origin: "lead-a", ids: ["a1"] }], none, (origin) => (origin === "lead-a" ? false : true));
    expect(plan.groups).toEqual([{ origin: "lead-a", ids: ["a1"] }]);
    expect(plan.restore).toEqual(["lead-a"]);
    expect(plan.undo).toEqual([]);
  });
});
