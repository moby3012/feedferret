import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
vi.mock("next-auth", () => ({ default: () => ({ auth: (handler: (request: NextRequest) => Response) => async (request: NextRequest) => request.nextUrl.pathname === "/private" ? NextResponse.redirect(new URL("/login", request.url)) : handler(request) }) }));
import proxy from "../../proxy";

const event = {} as Parameters<typeof proxy>[1];
const spoofed = () => new NextRequest("http://localhost/login", { headers: { "x-nonce": "spoofed", "content-security-policy": "script-src 'nonce-c3Bvb2Zl'", "content-security-policy-report-only": "spoofed" } });
const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];

afterEach(() => { vi.unstubAllEnvs(); });

describe("CSP proxy", () => {
  it("report mode (default): adds the nonce policy as report-only, never an enforced header", async () => {
    vi.stubEnv("FEEDFERRET_CSP", "");
    const first = await proxy(spoofed(), event);
    const second = await proxy(spoofed(), event);
    const policy = first.headers.get("content-security-policy-report-only")!;
    const nonce = nonceOf(policy)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(nonce).not.toBe("c3Bvb2Zl");
    expect(policy).toContain("'strict-dynamic'");
    // The enforced (legacy) policy comes from next.config.mjs: a proxy response header
    // would be copied onto the request and replace the nonce policy Next reads.
    expect(first.headers.get("content-security-policy")).toBeNull();
    expect(first.headers.get("reporting-endpoints")).toBe('csp="/api/csp-report"');
    // Forwarded to the renderer (Next stamps this nonce on its scripts), incoming values replaced.
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(first.headers.get("x-middleware-request-content-security-policy-report-only")).toBeNull();
    expect(nonceOf(second.headers.get("content-security-policy-report-only"))).not.toBe(nonce);
  });

  it("auth redirects carry the report-only policy", async () => {
    vi.stubEnv("FEEDFERRET_CSP", "report");
    const response = await proxy(new NextRequest("http://localhost/private"), event);
    expect(response.status).toBe(307);
    expect(response.headers.get("content-security-policy-report-only")).toContain("'nonce-");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("legacy rollback: no nonce, no report-only policy, spoofed values dropped", async () => {
    vi.stubEnv("FEEDFERRET_CSP", "legacy");
    const legacy = await proxy(spoofed(), event);
    expect(legacy.headers.get("content-security-policy")).toBeNull();
    expect(legacy.headers.get("content-security-policy-report-only")).toBeNull();
    expect(legacy.headers.get("reporting-endpoints")).toBeNull();
    expect(legacy.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(legacy.headers.get("x-middleware-request-content-security-policy")).toBeNull();
    expect(legacy.headers.get("x-middleware-override-headers")).not.toMatch(/content-security-policy|x-nonce/);
  });
});
