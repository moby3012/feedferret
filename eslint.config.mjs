import coreWebVitals from "eslint-config-next/core-web-vitals";
import regexp from "eslint-plugin-regexp";
import noRawDesignValues from "./eslint-rules/no-raw-design-values.mjs";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  { ignores: [".claude/**", ".next/**"] },
  ...coreWebVitals,
  {
    files: ["lib/**/*.{ts,tsx}", "app/api/**/*.{ts,tsx}", "app/actions/**/*.{ts,tsx}", "auth.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "Use safeFetch from lib/ssrf for outbound requests." }],
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='fetch']",
        message: "Outbound requests must use safeFetch/fetchWithSsrfProtection from lib/ssrf (socket DNS pinning).",
      }, {
        selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='globalThis'][callee.property.name='fetch']",
        message: "Use safeFetch from lib/ssrf, including instead of globalThis.fetch.",
      }, {
        selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='globalThis'][callee.computed=true][callee.property.value='fetch']",
        message: "Use safeFetch from lib/ssrf, including instead of globalThis['fetch'].",
      }],
      "no-restricted-imports": ["error", {
        paths: ["node:http", "node:https", "http", "https", "undici", "imapflow"].map(name => ({ name, message: "Use lib/ssrf; raw transports require a documented exception in eslint.config.mjs." })),
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
    rules: { "no-restricted-imports": "off" },
  },
  {
    // N1 newsletter IMAP: the poller pins the IMAP host itself (pinImapHost:
    // resolve once, refuse private answers, connect to the IP, SNI/cert on the
    // name) and is the only module allowed to open an IMAP socket.
    files: ["lib/inbound-email-poller.ts"],
    rules: { "no-restricted-imports": ["error", {
      paths: ["node:http", "node:https", "http", "https", "undici"].map(name => ({ name, message: "Use lib/ssrf; raw transports require a documented exception in eslint.config.mjs." })),
    }] },
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
