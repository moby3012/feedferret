import { beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlWorkerError } from "@/lib/html-worker/pool";
const mocks = vi.hoisted(() => ({ run: vi.fn(), sanitize: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/html-worker/pool", async original => ({ ...await original<typeof import("@/lib/html-worker/pool")>(), runHtmlTask: mocks.run }));
vi.mock("@/lib/feed-item-sanitize-client", () => ({ sanitizeFeedItemBodies: mocks.sanitize }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));
import { applyFeedContentRules } from "@/lib/feed-content-rules-client";

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.run.mockReset(); mocks.sanitize.mockReset(); mocks.warn.mockClear();
  mocks.sanitize.mockImplementation(async (items: string[]) => items.map(html => ({ html: `sanitized:${html}`, excerpt: "safe" })));
});
describe("content rule worker fallback", () => {
  it("batches healthy items into one worker call", async () => {
    mocks.run.mockImplementation(async (_, input) => input.items.map(() => ({ html: "clean", excerpt: "clean", allowed: true })));
    const out = await applyFeedContentRules(Array.from({ length: 50 }, () => ({ title: "T", html: "body" })), "{}");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(out.every(x => x.html === "clean" && x.defaultHtml === "sanitized:body")).toBe(true);
  });
  it("isolates a hostile item and preserves order with default sanitization", async () => {
    mocks.run.mockImplementation(async (_, input) => {
      if (input.items.some((x: { html: string }) => x.html === "hostile")) throw new HtmlWorkerError("timeout", "budget");
      return input.items.map(() => ({ html: "clean", excerpt: "clean", allowed: false }));
    });
    const out = await applyFeedContentRules(["healthy", "hostile", "healthy"].map(html => ({ title: "T", html })), "{}");
    expect(out.map(x => x.html)).toEqual(["clean", "sanitized:hostile", "clean"]);
    expect(out[1]).toMatchObject({ allowed: true, rulesSkipped: "timeout" });
    expect(mocks.warn).toHaveBeenCalled();
  });
  it("stops running rules after the per-feed budget and defaults the remainder", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mocks.run.mockImplementation(async () => { now += 8001; throw new HtmlWorkerError("timeout", "budget"); });
    const out = await applyFeedContentRules(Array.from({ length: 100 }, () => ({ title: "", html: "body" })), "{}");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(out.every(x => x.html === "sanitized:body" && x.rulesSkipped === "feed_budget")).toBe(true);
  });
  it("keeps unavailable workers retryable rather than admitting unsanitized input", async () => {
    mocks.run.mockRejectedValue(new HtmlWorkerError("unavailable", "missing worker"));
    await expect(applyFeedContentRules([{ title: "", html: "body" }], "{}")).rejects.toMatchObject({ reason: "unavailable" });
  });
});
