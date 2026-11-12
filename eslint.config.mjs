import coreWebVitals from "eslint-config-next/core-web-vitals";
import regexp from "eslint-plugin-regexp";
import noRawDesignValues from "./eslint-rules/no-raw-design-values.mjs";

const TRANSPORT_MESSAGE = "Use lib/ssrf; raw transports require a documented exception in eslint.config.mjs.";
const transportPaths = (names) => names.map((name) => ({ name, message: TRANSPORT_MESSAGE }));
const TRANSPORTS = ["node:http", "node:https", "http", "https", "undici"];

// HTML parsing boundary (#281): untrusted markup is parsed ONLY in the HTML
// worker pool (lib/html-worker). Main-thread code reaches parsers through
// runInHtmlWorker / runHtmlTask; it may import TYPES from the worker-only
// modules, never values. The worker-only modules are the ones bundled from
// lib/html-worker/tasks.ts (scripts/build-html-worker.mjs).
const PARSE_MESSAGE =
  "Untrusted HTML/XML is parsed only in the HTML worker pool: call runInHtmlWorker / runHtmlTask (lib/html-worker), " +
  "or import a parse-free helper module instead (type imports are fine).";
export const PARSER_PACKAGES = [
  "jsdom", "isomorphic-dompurify", "dompurify", "linkedom", "defuddle", "@mozilla/readability", "@extractus/article-extractor",
  "turndown", "parse5", "cheerio", "@xmldom/xmldom", "xpath",
];
export const WORKER_ONLY_MODULES = [
  "readability-core", "extraction-trim-core", "extraction-shell-core", "ftr-site-config", "lazy-media", "html-to-markdown", "sanitize-html",
  "feed-parse-core", "page-feed-suggest-core", "page-digest", "selector-extract", "newsletter-html", "feed-item-sanitize",
  "opml-parse-core", "catalog-opml-core", "markdown-render-core", "html-worker/tasks",
];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, (ch) => (ch === "/" ? "\\x2F" : `\\${ch}`));
// A worker-only module by any spelling: "@/lib/x", "./x", "../lib/x", with or
// without an extension (".ts", ".js", ".mjs", ".tsx", …), plus the task
// registry imported relatively from inside lib/html-worker ("./tasks").
// Slashes are written as \x2F so the same source also works inside an
// esquery attribute regex (no-restricted-syntax), which cannot contain "/".
const WORKER_ONLY_SPECIFIER = `(^|\\x2F)(${WORKER_ONLY_MODULES.map(escapeRe).join("|")})(\\.[cm]?[jt]sx?)?$|^\\.\\x2Ftasks(\\.[cm]?[jt]sx?)?$`;
// A parser package or one of its subpaths ("cheerio/lib/…", "dompurify/dist/…").
const PARSER_SPECIFIER = `^(${PARSER_PACKAGES.map(escapeRe).join("|")})(\\x2F.*)?$`;
const parsePaths = PARSER_PACKAGES.map((name) => ({ name, message: PARSE_MESSAGE, allowTypeImports: true }));
const parsePatterns = [
  { regex: WORKER_ONLY_SPECIFIER, message: PARSE_MESSAGE, allowTypeImports: true },
  // Subpaths only ("cheerio/slim"): the bare names are covered by `parsePaths`.
  { regex: `^(${PARSER_PACKAGES.map(escapeRe).join("|")})\\x2F.+$`, message: PARSE_MESSAGE, allowTypeImports: true },
];
// no-restricted-imports does not see `await import(…)` or `require(…)`.
const parseSyntax = [WORKER_ONLY_SPECIFIER, PARSER_SPECIFIER].flatMap((re) => [
  { selector: `ImportExpression[source.value=/${re}/]`, message: PARSE_MESSAGE },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/${re}/]`, message: PARSE_MESSAGE },
  { selector: `CallExpression[callee.property.name='resolve'][callee.object.name='require'][arguments.0.value=/${re}/]`, message: PARSE_MESSAGE },
]);
const FETCH_SYNTAX = [{
  selector: "CallExpression[callee.name='fetch']",
  message: "Outbound requests must use safeFetch/fetchWithSsrfProtection from lib/ssrf (socket DNS pinning).",
}, {
  selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='globalThis'][callee.property.name='fetch']",
  message: "Use safeFetch from lib/ssrf, including instead of globalThis.fetch.",
}, {
  selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='globalThis'][callee.computed=true][callee.property.value='fetch']",
  message: "Use safeFetch from lib/ssrf, including instead of globalThis['fetch'].",
}];
const MAIN_THREAD_FILES = [
  "lib/**/*.{ts,tsx}", "app/**/*.{ts,tsx}", "server/**/*.{ts,tsx}", "features/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}", "auth.ts", "auth.config.ts", "proxy.ts", "instrumentation.ts",
];
// The worker graph: the modules above plus the worker entry. They may import
// each other and the parsers, but never a network transport.
const WORKER_FILES = [
  ...WORKER_ONLY_MODULES.map((m) => `lib/${m}.ts`),
  "lib/html-worker/worker-entry.ts",
];

/** @type {import("eslint").Linter.Config[]} */
const config = [
  { ignores: [".claude/**", ".next/**"] },
  ...coreWebVitals,
  {
    // HTML parsing boundary for all main-thread code (the lib/app-api config
    // below repeats it next to the transport rule: options do not merge).
    files: MAIN_THREAD_FILES,
    rules: {
      "no-restricted-imports": ["error", { paths: parsePaths, patterns: parsePatterns }],
      "no-restricted-syntax": ["error", ...parseSyntax],
    },
  },
  {
    files: ["lib/**/*.{ts,tsx}", "app/api/**/*.{ts,tsx}", "app/actions/**/*.{ts,tsx}", "auth.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Use safeFetch from lib/ssrf for outbound requests." }],
      "no-restricted-syntax": ["error", ...FETCH_SYNTAX, ...parseSyntax],
      "no-restricted-imports": ["error", {
        paths: [...transportPaths([...TRANSPORTS, "imapflow"]), ...parsePaths],
        patterns: parsePatterns,
      }],
    },
  },
  {
    // ReDoS guard: Node runs everything on one event loop, so a super-linear
    // regex over untrusted text (feed XML/HTML, fetched pages, mail headers,
    // OPML, AI output, user input) freezes the whole instance. These two rules
    // flag the polynomial/exponential shapes (`<[^>]*>`, `\s+x`, `X+$`, …).
    // Fix by using lib/linear-text.ts, a DOM parser, or a bounded pattern; if the
    // input is provably small/trusted, disable the line WITH a reason.
    files: ["lib/**/*.{ts,tsx}", "app/**/*.{ts,tsx}", "server/**/*.{ts,tsx}", "features/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "auth.ts", "auth.config.ts", "proxy.ts", "instrumentation.ts"],
    plugins: { regexp },
    rules: {
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-super-linear-move": "error",
    },
  },
  {
    // The transport boundary owns undici dispatchers and the authenticated
    // loopback CONNECT server. Push needs an HTTPS Agent for web-push's own
    // https.request; its shared agent uses safeLookup and checks IP literals.
    files: ["lib/ssrf.ts", "lib/safe-dispatcher.ts", "lib/egress-proxy.ts", "lib/push.ts"],
    rules: { "no-restricted-imports": ["error", { paths: parsePaths, patterns: parsePatterns }] },
  },
  {
    // N1 newsletter IMAP: the poller pins the IMAP host itself (pinImapHost:
    // resolve once, refuse private answers, connect to the IP, SNI/cert on the
    // name) and is the only module allowed to open an IMAP socket.
    files: ["lib/inbound-email-poller.ts"],
    rules: { "no-restricted-imports": ["error", {
      paths: [...transportPaths(TRANSPORTS), ...parsePaths],
      patterns: parsePatterns,
    }] },
  },
  {
    files: WORKER_FILES,
    rules: {
      "no-restricted-imports": ["error", { paths: transportPaths([...TRANSPORTS, "imapflow"]) }],
      "no-restricted-syntax": ["error", ...FETCH_SYNTAX],
    },
  },
  {
    rules: {
      // react-hooks v5 (shipped with eslint-config-next 16) introduces stricter rules.
      // These patterns are used throughout the codebase for data-driven state initialization
      // and ref mutation in effects. Disabling until a dedicated refactor session addresses them.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    // Design-token guard: raw radius / z-index / type size / tracking / palette
    // status colour / blur / safe-area / duration values belong in
    // app/styles/{tokens,motion}.css only. See eslint-rules/no-raw-design-values.mjs.
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "features/**/*.{ts,tsx}"],
    plugins: { ff: { rules: { "no-raw-design-values": noRawDesignValues } } },
    rules: { "ff/no-raw-design-values": "error" },
  },
];

export default config;
