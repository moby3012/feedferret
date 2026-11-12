// Worker-only evaluator: never run publisher HTML or user regex on the request thread.
import { parseFeedContentRules } from "./feed-content-rules";
import { removeSelectorsFromFragments } from "./selector-extract";
import { getSanitizer } from "./sanitize-html";

export async function evaluateFeedContentRules(input: { rules?: string | null; items: { title: string; html: string }[]; removeSelectors?: string | null }) {
  const config = parseFeedContentRules(input.rules);
  const sanitizer = await getSanitizer();
  return input.items.map(({ title, html }) => {
    // Gates inspect original visible content; cleaning a footer must not remove its score.
    const plain = sanitizer.sanitize(html, { ALLOWED_TAGS: [] });
    const allowed = config.gates.every(rule => {
      const re = new RegExp(rule.pattern, rule.flags);
      if (rule.type === "title_include") return re.test(title);
      if (rule.type === "title_exclude") return !re.test(title);
      const match = re.exec(plain);
      return !!match?.[1]?.trim() && Number.isFinite(Number(match[1])) && Number(match[1]) >= rule.minimum;
    });
    html = removeSelectorsFromFragments({ items: [html], selectors: input.removeSelectors })[0];
    for (const rule of config.transforms) {
      if (rule.type === "strip_selector") html = removeSelectorsFromFragments({ items: [html], selectors: rule.css })[0];
      else if (rule.type === "replace_regex") html = html.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
      else {
        const index = html.indexOf(rule.marker);
        if (index >= 0) html = rule.type === "strip_text_before" ? html.slice(index + rule.marker.length) : html.slice(0, index);
      }
    }
    html = sanitizer.sanitize(html);
    return { html, allowed, excerpt: sanitizer.sanitize(html, { ALLOWED_TAGS: [] }).slice(0, 200) };
  });
}
