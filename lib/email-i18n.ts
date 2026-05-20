import en from "../messages/en.json";
import de from "../messages/de.json";

const MESSAGES: Record<string, Record<string, unknown>> = { en, de };
const SUPPORTED = new Set(Object.keys(MESSAGES));

function get(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

function resolvePlural(
  template: string,
  count: number,
  params: Record<string, string | number>,
): string {
  // ICU plural: {count, plural, one {# text} other {# text}}
  const match = template.match(/^\{(\w+),\s*plural,\s*([\s\S]*)\}$/);
  if (!match) return interpolate(template, params);
  const cases: Record<string, string> = {};
  let rest = match[2];
  const caseRe = /(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(rest)) !== null) {
    cases[m[1]] = m[2];
  }
  const form = count === 1 ? (cases["one"] ?? cases["other"]) : (cases["other"] ?? cases["one"]);
  if (!form) return String(count);
  return interpolate(form.replace(/#/g, String(count)), params);
}

export function createEmailTranslator(locale: string) {
  const resolvedLocale = SUPPORTED.has(locale) ? locale : "en";
  const messages = MESSAGES[resolvedLocale];

  return function t(key: string, params: Record<string, string | number> = {}): string {
    const template = get(messages, key) ?? get(MESSAGES.en, key) ?? key;
    const count = typeof params.count === "number" ? params.count : undefined;
    if (count !== undefined) return resolvePlural(template, count, params);
    return interpolate(template, params);
  };
}
