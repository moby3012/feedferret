import safeRegex from "safe-regex";
import { z } from "zod";

const text = z.string().min(1).max(1000);
const regex = { pattern: text, flags: z.string().regex(/^[gimsu]*$/).default("") };
const transform = z.discriminatedUnion("type", [
  z.object({ type: z.literal("strip_selector"), css: text }),
  z.object({ type: z.literal("replace_regex"), ...regex, replacement: z.string().max(4000) }),
  z.object({ type: z.literal("strip_text_before"), marker: text }),
  z.object({ type: z.literal("strip_text_after"), marker: text }),
]);
const gate = z.discriminatedUnion("type", [
  z.object({ type: z.literal("title_include"), ...regex }),
  z.object({ type: z.literal("title_exclude"), ...regex }),
  z.object({ type: z.literal("numeric_min"), ...regex, minimum: z.number().finite() }),
]);
const schema = z.object({ transforms: z.array(transform).max(20).default([]), gates: z.array(gate).max(10).default([]) }).strict();
export type FeedContentRules = z.infer<typeof schema>;

/** Validate on every write, including imports. Execution is additionally worker bounded. */
export function parseFeedContentRules(raw: unknown): FeedContentRules {
  if (raw == null || raw === "") return { transforms: [], gates: [] };
  if (typeof raw !== "string" || raw.length > 32_000) throw new Error("Invalid content rules JSON (maximum 32 KB)");
  const config = schema.parse(JSON.parse(raw));
  for (const rule of [...config.transforms, ...config.gates]) {
    if (!("pattern" in rule)) continue;
    const re = new RegExp(rule.pattern, rule.flags);
    if (!safeRegex(re)) throw new Error("Unsafe regular expression");
  }
  return config;
}
