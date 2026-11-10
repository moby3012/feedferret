import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

// Shell spec PR 1: Markdown rendering and HTML sanitizing are server-only.
// The production client bundle must not ship markdown-it or DOMPurify.
test("client chunks contain no markdown-it / DOMPurify", () => {
  const dir = path.resolve(".next", "static");
  test.skip(!fs.existsSync(dir), "needs a production build");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) {
        const src = fs.readFileSync(p, "utf8");
        if (/markdown-it|DOMPurify|uponSanitizeAttribute/.test(src)) offenders.push(path.relative(dir, p));
      }
    }
  };
  walk(dir);
  expect(offenders).toEqual([]);
});
