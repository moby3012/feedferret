import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_ONLY_NAMESPACES, shellMessages } from "../../i18n/client-messages";
import en from "../../messages/en.json";

// The root layout ships every namespace except ROUTE_ONLY_NAMESPACES to the
// client; the routes that use them wrap themselves in <FullMessagesProvider>.
// Guard: a client file outside those routes that names one of the namespaces
// would show raw keys — fail here instead.

const root = path.resolve(__dirname, "../..");

/** Client-side files whose route gets the full messages (app/<route>/layout.tsx wraps it). */
const ROUTE_SCOPED_FILES = new Set([
  "app/settings/page.tsx",
  "components/settings-form.tsx",
  "components/gesture-settings.tsx", // rendered only by settings-form (swipe mapping + haptics)
  "components/app-badge-setting.tsx", // rendered only by settings-form (notifications tab)
  "components/api-password-settings.tsx",
  "components/offline-storage-controls.tsx",
  "app/manage-feeds/page.tsx",
  "components/feed-management.tsx",
  "components/feed-edit-dialog.tsx",
  "components/freshrss-migration.tsx",
  "app/server-settings/client.tsx",
  "components/server-management-dialog.tsx",
  "app/setup/page.tsx",
]);
const WRAPPED_ROUTES = ["settings", "manage-feeds", "server-settings", "setup"];

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      // Server-only code (route handlers, server actions) translates through the request config, not the provider.
      if (entry.name === "node_modules" || entry.name === "api" || entry.name === "actions" || entry.name.startsWith(".")) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel.split(path.sep).join("/"));
    }
  };
  ["app", "components", "hooks", "features"].forEach(walk);
  return out;
}

describe("client messages (perf audit C15)", () => {
  it("shellMessages drops exactly the route-only namespaces", () => {
    const shell = shellMessages(en);
    for (const ns of ROUTE_ONLY_NAMESPACES) {
      expect(en).toHaveProperty(ns);
      expect(shell).not.toHaveProperty(ns);
    }
    expect(Object.keys(shell).length).toBe(Object.keys(en).length - ROUTE_ONLY_NAMESPACES.length);
    // The point of it: most of the payload stays on the server.
    expect(JSON.stringify(shell).length).toBeLessThan(JSON.stringify(en).length / 2);
  });

  it("no client file outside the wrapped routes uses a route-only namespace", () => {
    const offenders: string[] = [];
    for (const file of clientFiles()) {
      if (ROUTE_SCOPED_FILES.has(file)) continue;
      const src = fs.readFileSync(path.join(root, file), "utf8");
      for (const ns of ROUTE_ONLY_NAMESPACES) {
        // useTranslations("ns") · getTranslations("ns") · t("ns.key") · `ns.${…}` · namespace: "ns"
        // (a bare "ns" string is not a namespace use: e.g. the briefing's `mode === "ai"`)
        const q = `["'\`]`;
        const use = new RegExp(`(?:Translations\\(\\s*|namespace:\\s*)${q}${ns}${q}|${q}${ns}\\.`);
        if (use.test(src)) offenders.push(`${file}: ${ns}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every route that renders a route-only component gets the full messages", () => {
    for (const route of WRAPPED_ROUTES) {
      const layout = fs.readFileSync(path.join(root, "app", route, "layout.tsx"), "utf8");
      expect(layout).toContain("FullMessagesProvider");
    }
  });
});
