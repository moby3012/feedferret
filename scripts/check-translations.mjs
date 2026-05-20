#!/usr/bin/env node
/**
 * Checks that every key present in messages/en.json also exists in every
 * other locale file. Exits with code 1 if any locale has missing or extra
 * keys so this can run in CI.
 *
 * Usage:  node scripts/check-translations.mjs
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const messagesDir = join(root, "messages");

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

const files = readdirSync(messagesDir).filter((f) => f.endsWith(".json"));
const canonical = JSON.parse(readFileSync(join(messagesDir, "en.json"), "utf8"));
const canonicalKeys = new Set(flattenKeys(canonical));

let exitCode = 0;

for (const file of files) {
  if (file === "en.json") continue;
  const locale = file.replace(".json", "");
  const data = JSON.parse(readFileSync(join(messagesDir, file), "utf8"));
  const localeKeys = new Set(flattenKeys(data));

  const missing = [...canonicalKeys].filter((k) => !localeKeys.has(k));
  const extra = [...localeKeys].filter((k) => !canonicalKeys.has(k));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✅  ${locale}: ${canonicalKeys.size} keys — OK`);
    continue;
  }

  exitCode = 1;
  console.log(`❌  ${locale}: ${localeKeys.size}/${canonicalKeys.size} keys`);
  if (missing.length) {
    console.log(`    Missing (${missing.length}):`);
    for (const k of missing.slice(0, 20)) console.log(`      - ${k}`);
    if (missing.length > 20) console.log(`      … and ${missing.length - 20} more`);
  }
  if (extra.length) {
    console.log(`    Extra (${extra.length}) — key exists in ${locale} but not in en.json:`);
    for (const k of extra.slice(0, 10)) console.log(`      + ${k}`);
    if (extra.length > 10) console.log(`      … and ${extra.length - 10} more`);
  }
}

process.exit(exitCode);
