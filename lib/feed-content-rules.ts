import { RegExpParser, visitRegExpAST } from "@eslint-community/regexpp";
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

/** Conservative AST policy supplements safe-regex's star-height heuristic.
 * Reject backrefs, quantified alternations/nested repetition and chains of
 * more than two unbounded quantifiers, including lookbehind repetition.
 */
function assertConservativeRegex(re: RegExp) {
  const ast = new RegExpParser().parsePattern(re.source, 0, re.source.length, { unicode: re.unicode });
  let unbounded = 0;
  let quantified = 0;
  let lookbehind = 0;
  let unsafe = false;
  visitRegExpAST(ast, {
    onBackreferenceEnter() { unsafe = true; },
    onAssertionEnter(node) { if (node.kind === "lookbehind") lookbehind++; },
    onAssertionLeave(node) { if (node.kind === "lookbehind") lookbehind--; },
    onQuantifierEnter(node) {
      if (node.max === Infinity) unbounded++;
      if (quantified > 0 || lookbehind > 0) unsafe = true;
      quantified++;
    },
    onQuantifierLeave() { quantified--; },
    onGroupEnter(group) { if (quantified && group.alternatives.length > 1) unsafe = true; },
    onCapturingGroupEnter(group) { if (quantified && group.alternatives.length > 1) unsafe = true; },
  });
  if (unsafe || unbounded > 2) throw new Error("Unsafe regular expression");
}

/** Validate on every write, including imports. Execution is additionally worker bounded. */
export function parseFeedContentRules(raw: unknown): FeedContentRules {
  if (raw == null || raw === "") return { transforms: [], gates: [] };
  if (typeof raw !== "string" || raw.length > 32_000) throw new Error("Invalid content rules JSON (maximum 32 KB)");
  const config = schema.parse(JSON.parse(raw));
  for (const rule of [...config.transforms, ...config.gates]) {
    if (!("pattern" in rule)) continue;
    const re = new RegExp(rule.pattern, rule.flags);
    assertConservativeRegex(re);
    if (!safeRegex(re)) throw new Error("Unsafe regular expression");
  }
  return config;
}
