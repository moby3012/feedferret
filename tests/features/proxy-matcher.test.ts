import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Next vendors path-to-regexp (the matcher compiler) without types
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";

// The matcher decides which paths sit behind the auth gate. The exclusions are for public static files only.
// (Read from the source: importing proxy.ts would pull in the whole auth stack.)
const literal = /matcher:\s*\[\s*("(?:[^"\\]|\\.)*")/.exec(readFileSync("proxy.ts", "utf8"))![1];
const gate = pathToRegexp(JSON.parse(literal) as string);
const gated = (path: string) => gate.test(path);

describe("proxy matcher", () => {
  it.each([
    "/sw.js",
    "/offline.html",
    "/offline-reader.js",
    "/manifest.json",
    "/logo.svg",
    "/favicon.ico",
    "/icon-192.png",
    "/icon-512-maskable.png",
    "/api/app/counts",
    "/api",
    "/_next/static/chunks/a.js",
    "/_next/image",
  ])("%s is public", (path) => expect(gated(path)).toBe(false));

  it.each([
    "/",
    "/settings",
    "/login",
    "/swxjs",
    "/sw.json",
    "/sw.js/extra",
    "/offline-html",
    "/offlinexhtml",
    "/offline.html.bak",
    "/favicon-ico",
    "/favicon.icon",
    "/logo.svgx",
    "/logoxsvg",
    "/manifest.jsonp",
    "/manifestxjson",
    "/icon-192.png.html",
    "/apifoo",
    "/api-docs",
    "/_next/staticfoo",
    "/_nextXstatic/a",
    "/_next/imagefoo",
  ])("%s stays behind the gate", (path) => expect(gated(path)).toBe(true));
});
