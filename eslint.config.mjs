import coreWebVitals from "eslint-config-next/core-web-vitals";
import noRawDesignValues from "./eslint-rules/no-raw-design-values.mjs";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  { ignores: [".claude/**", ".next/**"] },
  ...coreWebVitals,
  {
    files: ["lib/**/*.{ts,tsx}", "app/api/**/*.{ts,tsx}"],
    ignores: ["lib/ssrf.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='fetch']",
        message: "Outbound requests must use safeFetch/fetchWithSsrfProtection from lib/ssrf (socket DNS pinning).",
      }],
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
