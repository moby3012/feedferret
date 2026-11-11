/**
 * Design-token guard (spec §4, PR 3). Rejects NEW raw design values in app
 * code — class strings and inline styles — so radius, type, colour roles,
 * elevation, z-index, motion and safe areas stay defined in exactly one place:
 * app/styles/tokens.css + app/styles/motion.css.
 *
 * Use instead:
 *   rounded-[…]            → rounded-chip | control | row | panel | sheet | full
 *   z-[…] / z-10 / zIndex  → z-(--z-sticky|bar|reader|overlay|toast|skip)
 *   text-[10px] …          → text-caption | footnote | body-sm | body | row-title | title-sm | title | headline | display
 *   rounded-lg / text-sm / shadow-md (legacy named scale) → the role tokens above
 *   tracking-[…]           → tracking-title | tracking-subtitle | tracking-overline
 *   bg-amber-500/10 …      → bg-warning/10 · success · danger · info (+ -subtle)
 *   backdrop-blur-xl …     → backdrop-blur-bar | backdrop-blur-overlay
 *   env(safe-area-inset-*) → var(--safe-t|r|b|l)
 *   duration-300 …         → duration-(--dur-press|fast|base|slow)
 */
const P = String.raw`(?<![\w-])`;
const PREFIX = String.raw`(?:[\w\[\]&>*.=()-]+:)*`;

const RULES = [
  {
    re: new RegExp(P + String.raw`rounded-(?:(?:s|e|t|b|l|r|ss|se|ee|es|tl|tr|bl|br)-)?\[`),
    msg: "Arbitrary radius. Use a role token: rounded-chip | rounded-control | rounded-row | rounded-panel | rounded-sheet | rounded-full.",
  },
  {
    re: new RegExp(P + String.raw`-?z-(?:\[|\d)`),
    msg: "Raw z-index. Use z-(--z-sticky|bar|reader|overlay|toast|skip) from tokens.css.",
  },
  {
    re: new RegExp(P + String.raw`text-\[[\d.]+(?:px|rem|em)\]`),
    msg: "Arbitrary font size. Use the type scale: text-caption | footnote | body-sm | body | row-title | title-sm | title | headline | display.",
  },
  {
    re: new RegExp(P + String.raw`tracking-\[`),
    msg: "Arbitrary tracking. Use tracking-title | tracking-subtitle | tracking-overline (or the tracking built into the type token).",
  },
  {
    re: new RegExp(
      P +
        String.raw`(?:bg|text|border|ring|ring-offset|from|via|to|fill|stroke|outline|divide|decoration|shadow|accent|caret|placeholder)-(?:amber|yellow|orange|lime|emerald|green|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|red)-\d`,
    ),
    msg: "Palette status colour. Use the role tokens: warning | success | danger | info (+ -subtle), destructive, brand.",
  },
  {
    re: new RegExp(P + String.raw`backdrop-blur(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|\[[^\]]*\]))?(?![\w-])`),
    msg: "Raw backdrop blur. Only two levels exist: backdrop-blur-bar | backdrop-blur-overlay (rows, cards and list panels never blur).",
  },
  {
    // Legacy named scale (UX wave 2b, audit A-12): the role tokens replaced it.
    re: new RegExp(P + PREFIX + String.raw`rounded(?:-(?:s|e|t|b|l|r|ss|se|ee|es|tl|tr|bl|br))?-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)(?![\w-])`),
    msg: "Legacy radius scale. Use a role token: rounded-chip (6) | control (10) | row (14) | panel (20) | sheet (28) | full.",
  },
  {
    re: new RegExp(P + PREFIX + String.raw`text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])`),
    msg: "Legacy type scale. Use text-caption | footnote | body-sm | body | row-title | title-sm | title | headline | display.",
  },
  {
    re: new RegExp(P + PREFIX + String.raw`shadow-(?:xs|sm|md|lg|xl|2xl)(?![\w-])`),
    msg: "Legacy shadow. Two elevations only: shadow-bar | shadow-overlay (or elev-bar / elev-overlay); everything else is flat.",
  },
  {
    re: /env\(safe-area-inset/,
    msg: "Raw env(safe-area-inset-*). Use var(--safe-t|r|b|l) from tokens.css.",
  },
  {
    re: new RegExp(P + String.raw`duration-(?:\d|\[)`),
    msg: "Raw duration. Use duration-(--dur-press|fast|base|slow); nothing runs longer than --dur-slow (320 ms).",
  },
];

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow raw design values outside the token files." },
    schema: [],
  },
  create(context) {
    function check(node, text) {
      for (const { re, msg } of RULES) {
        const m = re.exec(text);
        if (m) context.report({ node, message: `${msg} (found "${m[0]}")` });
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
      Property(node) {
        const k = node.key;
        const name = k.type === "Identifier" ? k.name : k.type === "Literal" ? String(k.value) : "";
        if (name === "zIndex" || name === "z-index") {
          // Catch literals also inside `cond ? 50 : undefined` / `a && 10`.
          const hasRawNumber = (n) =>
            !!n &&
            ((n.type === "Literal" && typeof n.value === "number") ||
              (n.type === "ConditionalExpression" && (hasRawNumber(n.consequent) || hasRawNumber(n.alternate))) ||
              (n.type === "LogicalExpression" && (hasRawNumber(n.left) || hasRawNumber(n.right))));
          if (hasRawNumber(node.value)) {
            context.report({ node, message: "Raw zIndex. Use \"var(--z-…)\" from tokens.css." });
          }
        }
      },
    };
  },
};

export { RULES };
export default rule;
