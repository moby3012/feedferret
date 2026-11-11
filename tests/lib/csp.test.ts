import { describe, expect, it, vi } from "vitest";
import { cspMode, nonceCsp, legacyCsp } from "../../lib/csp";

vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { logger } from "../../lib/logger";
import { recordCspReports } from "../../lib/csp-reports";
import { POST } from "../../app/api/csp-report/route";

it("uses strict dynamic and permits eval only in development", () => {
  expect(nonceCsp("test")).toContain("script-src 'self' 'nonce-test' 'strict-dynamic';");
  expect(nonceCsp("test")).not.toMatch(/unsafe-eval|worker-src 'self' blob/);
  expect(nonceCsp("test", true)).toContain("'unsafe-eval'");
  expect(legacyCsp).toContain("'unsafe-inline' 'unsafe-eval'");
});

it("defaults unknown FEEDFERRET_CSP values to report mode", () => {
  expect([undefined, "", "REPORT", "off", "report"].map(cspMode)).toEqual(Array(5).fill("report"));
  expect(cspMode("legacy")).toBe("legacy");
  expect(cspMode("enforce")).toBe("report"); // enforcement is PR 7
});

it("aggregates only allowlisted directives, never secret-bearing fields", () => {
  recordCspReports({ "csp-report": { "effective-directive": "script-src-elem", "document-uri": "https://user:password@host/shared/secret?token=secret", "script-sample": "secret", "original-policy": "nonce-secret" } });
  expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { "script-src-elem": 1 });
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("secret");
});

describe("report ingestion", () => {
  let ip = 0;
  const request = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://localhost/api/csp-report", { method: "POST", body, headers: { "x-real-ip": `test-${++ip}`, ...headers }, duplex: "half" } as RequestInit);
  it("accepts legacy and Reporting API payloads without auth", async () => {
    for (const payload of [{ "csp-report": { "effective-directive": "script-src" } }, [{ type: "csp-violation", body: { effectiveDirective: "script-src" } }]]) {
      expect((await POST(request(JSON.stringify(payload)))).status).toBe(204);
    }
  });
  it("rejects malformed JSON", async () => { expect((await POST(request("{"))).status).toBe(400); });
  it("caps declared and chunked bodies", async () => {
    expect((await POST(request("{}", { "content-length": "16385" }))).status).toBe(413);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16384)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
    expect((await POST(request(stream))).status).toBe(413);
  });
  it("rate limits before reading a body", async () => {
    for (let i = 0; i < 30; i++) expect((await POST(request("{}", { "x-real-ip": "limited-test" }))).status).toBe(204);
    const response = await POST(request("{}", { "x-real-ip": "limited-test" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });
});
