import coreWebVitals from "eslint-config-next/core-web-vitals";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  ...coreWebVitals,
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
];

export default config;
