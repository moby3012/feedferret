// Untrusted HTML (fetched pages, feed item bodies, newsletter mails, OPML,
// imports, rendered Markdown) is parsed only inside the HTML worker pool
// (lib/html-worker). The boundary is enforced by ESLint (`no-restricted-imports`
// in eslint.config.mjs): main-thread code may not import a DOM parser package or
// a VALUE from a worker-only module (types are fine). These tests prove the rule
// bites (synthetic files linted at virtual paths), that its module list covers
// every parser-importing module of the worker graph, and that no main-thread
// file sneaks a parser in through a dynamic import.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";
import { PARSER_PACKAGES, WORKER_ONLY_MODULES } from "../../eslint.config.mjs";

const ROOT = process.cwd();
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PACKAGES = PARSER_PACKAGES.map(escapeRe).join("|");
const MODULES = WORKER_ONLY_MODULES.map(escapeRe).join("|");
// Any static import, re-export, dynamic import(), require() or require.resolve()
// of a parser package (or subpath) …
const PARSER_IMPORT = new RegExp(
  `(?:from\\s+|import\\s*\\(\\s*|require(?:\\.resolve)?\\s*\\(\\s*)["'](?:${PACKAGES})(?:/[^"']*)?["']|\\bgetSanitizer\\s*\\(`,
);
// … and any dynamic import() / require() of a worker-only module (static value
// imports are the ESLint rule's job; type-only `import("…")` types are fine).
const DYNAMIC_WORKER_IMPORT = new RegExp(
  `(?<!typeof )(?:\\bimport\\s*\\(\\s*|require(?:\\.resolve)?\\s*\\(\\s*)["'][^"']*(?:^|/)(?:${MODULES})(?:\\.[cm]?[jt]sx?)?["']`,
);
const WORKER_FILES = new Set([...WORKER_ONLY_MODULES.map((m) => `lib/${m}.ts`), "lib/html-worker/worker-entry.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function boundaryErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  return result.messages
    .filter((m) => (m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax") && /worker pool|lib\/ssrf/.test(m.message))
    .map((m) => m.message);
}

describe("HTML parsing boundary (ESLint no-restricted-imports)", () => {
  it("rejects a route importing a worker-only parse function (negative fixture)", async () => {
    const errors = await boundaryErrors(
      "app/api/boundary-fixture/route.ts",
      'import { parseOpmlInProcess } from "@/lib/opml-parse-core";\nimport { renderMarkdownToHtmlInProcess } from "@/lib/markdown-render-core";\nexport const f = [parseOpmlInProcess, renderMarkdownToHtmlInProcess];\n',
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("HTML worker pool");
  }, 60_000);

  it("rejects relative imports of worker-only modules and parser packages in lib/ and components/", async () => {
    expect(await boundaryErrors("lib/boundary-fixture.ts", 'import { buildPageDigest } from "./page-digest";\nexport const f = buildPageDigest;\n')).toHaveLength(1);
    expect(await boundaryErrors("lib/boundary-fixture.ts", 'import { JSDOM } from "jsdom";\nexport const f = JSDOM;\n')).toHaveLength(1);
    expect(await boundaryErrors("server/boundary-fixture.ts", 'import { getSanitizer } from "@/lib/sanitize-html";\nexport const f = getSanitizer;\n')).toHaveLength(1);
    expect(await boundaryErrors("components/boundary-fixture.tsx", 'import { htmlTasks } from "@/lib/html-worker/tasks";\nexport const f = htmlTasks;\n')).toHaveLength(1);
  }, 60_000);

  it("allows type imports, the worker task registry and worker modules among themselves", async () => {
    expect(await boundaryErrors("app/api/boundary-fixture/route.ts", 'import type { ExtractionResult } from "@/lib/readability-core";\nexport type T = ExtractionResult;\n')).toEqual([]);
    expect(await boundaryErrors("lib/html-worker/tasks.ts", 'import { parseOpmlInProcess } from "@/lib/opml-parse-core";\nexport const f = parseOpmlInProcess;\n')).toEqual([]);
    expect(await boundaryErrors("lib/page-digest.ts", 'import { JSDOM } from "jsdom";\nimport { suggestFeedCandidates } from "./page-feed-suggest-core";\nexport const f = [JSDOM, suggestFeedCandidates];\n')).toEqual([]);
  }, 60_000);

  it("rejects the review's bypasses: extensions, dynamic import(), require(), more parser packages", async () => {
    const route = "app/api/boundary-fixture/route.ts";
    const lib = "lib/boundary-fixture.ts";
    const cases: Array<[string, string]> = [
      [lib, 'import { buildPageDigest } from "./page-digest.ts";\nexport const f = buildPageDigest;\n'],
      [lib, 'import { buildPageDigest } from "./page-digest.js";\nexport const f = buildPageDigest;\n'],
      [route, 'import { parseOpmlInProcess } from "@/lib/opml-parse-core.mjs";\nexport const f = parseOpmlInProcess;\n'],
      [route, 'export async function GET() { const m = await import("@/lib/page-digest"); return m.buildPageDigest; }\n'],
      [route, 'export async function GET() { return (await import("defuddle")).default; }\n'],
      [lib, 'export function f() { return require("jsdom"); }\n'],
      [lib, 'export function f() { return require.resolve("jsdom"); }\n'],
      [lib, 'export function f() { return require("@/lib/sanitize-html.ts"); }\n'],
      [lib, 'import { load } from "cheerio";\nexport const f = load;\n'],
      [lib, 'import { load } from "cheerio/slim";\nexport const f = load;\n'],
      [lib, 'import { DOMParser } from "@xmldom/xmldom";\nexport const f = DOMParser;\n'],
      [lib, 'import xpath from "xpath";\nexport const f = xpath;\n'],
      ["lib/html-worker/pool.ts", 'import { htmlTasks } from "./tasks";\nexport const f = htmlTasks;\n'],
      ["lib/html-worker/index.ts", 'export async function f() { return (await import("./tasks")).htmlTasks; }\n'],
    ];
    for (const [file, code] of cases) expect(await boundaryErrors(file, code), `${file}: ${code}`).toHaveLength(1);
    // Type-only references stay allowed.
    expect(await boundaryErrors("lib/html-worker/pool.ts", 'import type { HtmlTaskName } from "./tasks";\nexport type T = HtmlTaskName;\n')).toEqual([]);
    // Worker modules may load parsers lazily themselves.
    expect(await boundaryErrors("lib/sanitize-html.ts", 'export async function f() { return (await import("isomorphic-dompurify")).default; }\n')).toEqual([]);
  }, 120_000);

  it("worker modules may not open network transports", async () => {
    expect(await boundaryErrors("lib/selector-extract.ts", 'import { fetch } from "undici";\nexport const f = fetch;\n')).toHaveLength(1);
  }, 60_000);

  it("the real tree passes the rule", async () => {
    const results = await eslint.lintFiles(["lib", "app", "server", "components", "features", "hooks", "instrumentation.ts"]);
    const violations = results.flatMap((r) =>
      r.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => `${relative(ROOT, r.filePath)}:${m.line} ${m.message}`),
    );
    expect(violations).toEqual([]);
  }, 300_000);
});

describe("HTML parsing boundary (module list and dynamic imports)", () => {
  it("every module of the worker bundle that imports a parser is on the worker-only list", async () => {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: ["lib/html-worker/worker-entry.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      packages: "external",
      logLevel: "silent",
      tsconfig: join(ROOT, "tsconfig.json"),
    });
    const parserModules = Object.keys(result.metafile.inputs)
      .filter((file) => file.startsWith("lib/") && !file.includes("node_modules"))
      .filter((file) => PARSER_IMPORT.test(readFileSync(join(ROOT, file), "utf8")));
    expect(parserModules.length).toBeGreaterThan(5);
    expect(parserModules.filter((file) => !WORKER_FILES.has(file))).toEqual([]);
  }, 60_000);

  it("no main-thread module reaches a parser or a worker-only module by any other route (dynamic import, require, getSanitizer)", () => {
    const offenders = [...sources("lib"), ...sources("app"), ...sources("server"), ...sources("features"), ...sources("components"), ...sources("hooks")]
      .filter((file) => !WORKER_FILES.has(file))
      .filter((file) => {
        const text = readFileSync(join(ROOT, file), "utf8");
        return PARSER_IMPORT.test(text) || DYNAMIC_WORKER_IMPORT.test(text);
      });
    expect(offenders).toEqual([]);
  });

  it("the scan itself catches every spelling (self-test)", () => {
    for (const text of ['await import("@/lib/page-digest")', "require('./opml-parse-core.ts')", 'import("defuddle")', 'require.resolve("jsdom")', 'from "cheerio/slim"']) {
      expect(PARSER_IMPORT.test(text) || DYNAMIC_WORKER_IMPORT.test(text), text).toBe(true);
    }
    expect(DYNAMIC_WORKER_IMPORT.test('typeof import("./tasks")')).toBe(false);
  });

  it("the pool fails closed: no in-process fallback outside the test-only flag", () => {
    const pool = readFileSync(join(ROOT, "lib/html-worker/pool.ts"), "utf8");
    expect(pool).toMatch(/FEEDFERRET_HTML_WORKER_INLINE/);
    expect(pool).toMatch(/new HtmlWorkerError\("unavailable"/);
    expect(pool).not.toMatch(/if \(!pool\) return runInline/);
  });
});
