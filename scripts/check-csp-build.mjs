// L3: the nonce CSP needs per-request HTML. Fails `pnpm build` if an app route got prerendered.
import { readFileSync } from "node:fs";
const { routes, dynamicRoutes } = JSON.parse(readFileSync(".next/prerender-manifest.json", "utf8"));
// Next 16.4 always generates the synthetic catastrophic-error fallback, even
// with a dynamic root layout. It is not an ordinary app route (see security.md).
const allowed = new Set(["/robots.txt", "/sitemap.xml", "/_global-error"]);
const unexpected = [...Object.keys(routes), ...Object.keys(dynamicRoutes)].filter(route => !allowed.has(route));
if (unexpected.length) throw new Error(`Nonce CSP cannot use prerendered application HTML: ${unexpected.join(", ")}`);
console.log("CSP build: application HTML is dynamic; metadata and Next's synthetic fatal-error artifact only.");
