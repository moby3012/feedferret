import { describe, expect, it } from "vitest";
import { groupStories } from "@/components/list/group-stories";
import { MAX_MARK_IDS, MAX_RANGE_IDS, displayOrder, planMarkUpToHere, type UpToHereInput } from "@/components/list/mark-up-to-here";
import { MAX_RANGE_IDS as SERVER_MAX_RANGE_IDS } from "@/server/articles/mark-range";
import { MAX_MARK_IDS as SERVER_MAX_MARK_IDS } from "@/server/articles/state";
import type { LegacyArticle } from "@/features/articles/legacy-adapter";

const SNAP = 1_000_000;

const row = (id: string, o: { cluster?: { id: string; size: number; lead: string }; read?: boolean; createdAt?: number } = {}): LegacyArticle =>
  ({
    id,
    title: id,
    isRead: o.read ?? false,
    createdAtRaw: o.createdAt ?? SNAP - 1000,
    clusterId: o.cluster?.id ?? null,
    clusterSize: o.cluster?.size ?? 0,
    clusterLeadId: o.cluster?.lead ?? null,
  }) as unknown as LegacyArticle;

const input = (flat: LegacyArticle[], targetId: string, o: Partial<UpToHereInput> = {}): UpToHereInput => ({
  rows: groupStories(flat),
  flat,
  expandedMembers: () => null,
  targetId,
  cutoff: SNAP,
  ...o,
});

describe("planMarkUpToHere (\"Alles bis hier\" over the displayed order)", () => {
  it("client limits match the server bounds", () => {
    expect(MAX_RANGE_IDS).toBe(SERVER_MAX_RANGE_IDS);
    expect(MAX_MARK_IDS).toBe(SERVER_MAX_MARK_IDS);
  });

  it("plain list: one range from the first row to the target, no extras", () => {
    const flat = ["a", "b", "c", "d"].map((id) => row(id));
    expect(planMarkUpToHere(input(flat, "c"))).toEqual({ kind: "range", fromId: "a", toId: "c", extraIds: [], unread: 3 });
  });

  it("includes the members an EXPANDED card shows even when they were fetched outside the list", () => {
    const c = { id: "c1", size: 4, lead: "m1" };
    const flat = [row("m1", { cluster: c }), row("x"), row("m2", { cluster: c }), row("y")];
    const fetched = [row("m1", { cluster: c }), row("far-1", { cluster: c }), row("m2", { cluster: c }), row("far-2", { cluster: c })];
    const expandedMembers = (id: string) => (id === "c1" ? fetched : null);
    expect(displayOrder(groupStories(flat), expandedMembers).map((a) => a.id)).toEqual(["m1", "far-1", "m2", "far-2", "x", "y"]);
    // Up to "x": the range covers the fully displayed flat prefix m1, x, m2; the members fetched outside the list go as ids.
    expect(planMarkUpToHere(input(flat, "x", { expandedMembers }))).toEqual({ kind: "range", fromId: "m1", toId: "m2", extraIds: ["far-1", "far-2"], unread: 5 });
    // Collapsed: the card stands for its loaded siblings only.
    expect(planMarkUpToHere(input(flat, "x"))).toEqual({ kind: "range", fromId: "m1", toId: "m2", extraIds: [], unread: 3 });
  });

  it("menu on a fetched member row of an expanded card: everything displayed down to that member", () => {
    const c = { id: "c1", size: 3, lead: "lead" };
    const flat = [row("p"), row("lead", { cluster: c }), row("q")];
    const fetched = [row("lead", { cluster: c }), row("far-1", { cluster: c }), row("far-2", { cluster: c })];
    const plan = planMarkUpToHere(input(flat, "far-1", { expandedMembers: (id) => (id === "c1" ? fetched : null) }));
    expect(plan).toEqual({ kind: "range", fromId: "p", toId: "lead", extraIds: ["far-1"], unread: 3 });
  });

  it("the range stops before a flat row that is displayed BELOW the target (story card sits at its first member)", () => {
    const c = { id: "c1", size: 2, lead: "m2" };
    const flat = [row("m1", { cluster: c }), row("m2", { cluster: c }), row("z")];
    // Expanded: display order m2 (card), m1 (member), z. Up to the card = only m2.
    const fetched = [row("m2", { cluster: c }), row("m1", { cluster: c })];
    const plan = planMarkUpToHere(input(flat, "m2", { expandedMembers: (id) => (id === "c1" ? fetched : null) }));
    // flat[0] = m1 is not covered: no prefix, explicit ids.
    expect(plan).toEqual({ kind: "ids", ids: ["m2"] });
  });

  it("rows newer than the snapshot are never in the range; displayed ones go along as explicit ids", () => {
    const flat = [row("a"), row("late", { createdAt: SNAP + 5 }), row("b")];
    expect(planMarkUpToHere(input(flat, "b"))).toEqual({ kind: "range", fromId: "a", toId: "b", extraIds: ["late"], unread: 3 });
  });

  it("read rows are skipped; nothing unread = none", () => {
    const flat = [row("a", { read: true }), row("b")];
    expect(planMarkUpToHere(input(flat, "b"))).toEqual({ kind: "range", fromId: "a", toId: "b", extraIds: [], unread: 1 });
    expect(planMarkUpToHere(input(flat, "a"))).toEqual({ kind: "none" });
  });

  it("no snapshot / no bound list: explicit ids, refused (never partial) above the id bound", () => {
    const flat = Array.from({ length: MAX_MARK_IDS + 1 }, (_, i) => row(`r${i}`));
    expect(planMarkUpToHere(input(flat, "r2", { cutoff: null }))).toEqual({ kind: "ids", ids: ["r0", "r1", "r2"] });
    expect(planMarkUpToHere(input(flat, `r${MAX_MARK_IDS}`, { cutoff: null }))).toEqual({ kind: "too-many", limit: MAX_MARK_IDS });
  });

  it("more than 1000 extras are sent whole (server bound), above MAX_RANGE_IDS refused", () => {
    const c = { id: "c1", size: 3000, lead: "lead" };
    const flat = [row("lead", { cluster: c }), row("x")];
    const many = Array.from({ length: 1500 }, (_, i) => row(`f${i}`, { cluster: c }));
    const plan = planMarkUpToHere(input(flat, "x", { expandedMembers: () => many }));
    expect(plan.kind).toBe("range");
    expect(plan.kind === "range" && plan.extraIds.length).toBe(1500);
    const tooMany = Array.from({ length: MAX_RANGE_IDS + 1 }, (_, i) => row(`f${i}`, { cluster: c }));
    expect(planMarkUpToHere(input(flat, "x", { expandedMembers: () => tooMany }))).toEqual({ kind: "too-many", limit: MAX_RANGE_IDS });
  });
});
