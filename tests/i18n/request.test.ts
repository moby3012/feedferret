import { describe, it, expect } from "vitest";
import { pickLocaleFromAcceptLanguage } from "../../i18n/request";

describe("pickLocaleFromAcceptLanguage", () => {
  it("returns null for a missing header", () => {
    expect(pickLocaleFromAcceptLanguage(null)).toBeNull();
  });

  it("picks the highest-weighted supported locale", () => {
    expect(pickLocaleFromAcceptLanguage("de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("de");
  });

  it("respects explicit q-values out of header order", () => {
    expect(pickLocaleFromAcceptLanguage("en;q=0.5,de;q=0.9")).toBe("de");
  });

  it("normalizes region subtags to the primary language", () => {
    expect(pickLocaleFromAcceptLanguage("en-GB")).toBe("en");
  });

  it("skips unsupported locales and falls through to a supported one", () => {
    expect(pickLocaleFromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.8")).toBe("de");
  });

  it("returns null when nothing is supported", () => {
    expect(pickLocaleFromAcceptLanguage("fr-FR,es-ES")).toBeNull();
  });
});
