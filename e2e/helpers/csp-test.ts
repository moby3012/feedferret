import { test as base, expect } from "@playwright/test";
export type { Locator, Page } from "@playwright/test";

/** L3 CSP audit, auto-applied to every spec (all specs import `test` from here,
 * directly or via helpers/test.ts / greader-test.ts): collects
 * `securitypolicyviolation` events — enforced AND report-only — plus any report
 * the browser POSTs to /api/csp-report, and fails the test if there was one.
 * Active before the first document, persists across navigation and popups.
 * A Node binding retains violations even when a document/frame is destroyed. */
export const test = base.extend<{ cspAudit: void }>({
  cspAudit: [async ({ context }, use) => {
    const violations: unknown[] = [];
    await context.exposeBinding("__recordCspViolation", (_source, violation) => { violations.push(violation); });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        void (window as unknown as { __recordCspViolation: (value: unknown) => Promise<void> }).__recordCspViolation({
          directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition,
          document: location.pathname, source: event.sourceFile, line: event.lineNumber, sample: event.sample,
        });
      });
    });
    context.on("request", request => {
      if (new URL(request.url()).pathname === "/api/csp-report" && request.method() === "POST") {
        violations.push({ report: request.postData() });
      }
    });
    await use();
    expect(violations, "CSP violations across all navigations").toEqual([]);
  }, { auto: true }],
});
export { expect };
