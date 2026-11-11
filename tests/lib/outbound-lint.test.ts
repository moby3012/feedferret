import { expect, it } from "vitest";
import { ESLint } from "eslint";
const eslint = new ESLint();
it.each(["lib/untrusted.ts", "app/api/test/route.ts", "app/actions/test.ts", "auth.ts"])("guards outbound calls and transport imports in %s", async filePath => {
  const [result] = await eslint.lintText(`
    fetch("https://example.com");
    const indirect = fetch;
    globalThis.fetch("https://example.com");
    globalThis["fetch"]("https://example.com");
    import { fetch as unsafe } from "undici";
    import http from "node:http";
    import https from "node:https";
    import oldHttp from "http";
    import oldHttps from "https";
  `, { filePath });
  expect(result.messages.filter(m => m.ruleId === "no-restricted-syntax")).toHaveLength(3);
  expect(result.messages.filter(m => m.ruleId === "no-restricted-globals").length).toBeGreaterThanOrEqual(2);
  expect(result.messages.filter(m => m.ruleId === "no-restricted-imports")).toHaveLength(5);
});
it.each(["lib/ssrf.ts", "lib/safe-dispatcher.ts", "lib/egress-proxy.ts", "lib/push.ts"])("documents transport import exceptions for %s", async filePath => {
  const [result] = await eslint.lintText('import https from "node:https";', { filePath });
  expect(result.messages.filter(m => m.ruleId === "no-restricted-imports")).toEqual([]);
});
