// Offline regression corpus for the full-text quality gate (diagnosis §10).
// Each case in tests/fixtures/fulltext/<case>/ is a synthetic page modeled on a
// real failure class (consent wall, members-only stub, teaser-only page, lazy
// images, good article with boilerplate tail, rich feed vs. thin JS page) plus
// the feed item and the expected outcome. Runs the real extraction ensemble;
// no network.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractReadableContent } from "@/lib/readability-extract";
import { decideFullText } from "@/lib/extraction-quality";

type Expect = {
  url: string;
  verdict?: string;
  accept: boolean;
  reasonIn?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  minImages?: number;
};

const ROOT = join(process.cwd(), "tests/fixtures/fulltext");
const cases = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("full-text quality corpus", () => {
  it("has the expected fixture classes", () => {
    expect(cases).toEqual(
      expect.arrayContaining([
        "consent-wall",
        "paywall-stub",
        "teaser-only",
        "lazy-images",
        "good-boilerplate-tail",
        "rich-feed-thin-page",
        "good-article",
      ]),
    );
  });

  for (const name of cases) {
    it(name, async () => {
      const dir = join(ROOT, name);
      const page = readFileSync(join(dir, "page.html"), "utf8");
      const feed = readFileSync(join(dir, "feed.html"), "utf8");
      const exp = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as Expect;

      const result = await extractReadableContent(page, exp.url);
      const decision = decideFullText(result.quality, feed, "auto");

      if (exp.verdict) expect(result.quality?.verdict, `${name} verdict (${result.quality?.reason})`).toBe(exp.verdict);
      expect(decision.accept, `${name} decision ${JSON.stringify(decision)}`).toBe(exp.accept);
      if (exp.reasonIn && !decision.accept) expect(exp.reasonIn).toContain(decision.reason);

      const html = result.html ?? "";
      for (const needle of exp.mustContain ?? []) expect(html, `${name} must contain ${needle}`).toContain(needle);
      for (const needle of exp.mustNotContain ?? []) expect(html, `${name} must not contain ${needle}`).not.toContain(needle);
      if (exp.minImages) {
        const images = html.match(/<img\b/g) ?? [];
        expect(images.length, `${name} images`).toBeGreaterThanOrEqual(exp.minImages);
      }
    });
  }
});
