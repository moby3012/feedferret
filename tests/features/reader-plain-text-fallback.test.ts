// A Markdown article whose rendering fell back to escaped plain text (HTML
// worker busy / unavailable) carries `htmlFallback` from the detail into the
// reader, which shows a short notice above the text (components/reader/reader-body.tsx).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDetail } from "@/features/articles/legacy-adapter";
import type { ArticleDetail } from "@/features/articles/types";
import type { Article } from "@/lib/rss-data";

const article = { id: "a1", content: "", contentFormat: "markdown" } as unknown as Article;
const detail = (extra: Partial<ArticleDetail>) =>
  ({ id: "a1", html: "<p>**text**</p>", contentFormat: "markdown", aiSummary: null, aiSummarizedAt: null, readAt: null, ...extra }) as ArticleDetail;

describe("reader plain-text fallback", () => {
  it("passes the fallback flag from the detail to the reader article", () => {
    expect(withDetail(article, detail({ htmlFallback: true })).htmlFallback).toBe(true);
    expect(withDetail(article, detail({})).htmlFallback).toBe(false);
  });

  it("the reader renders the notice from translated text (de + en)", () => {
    const body = readFileSync(join(process.cwd(), "components/reader/reader-body.tsx"), "utf8");
    expect(body).toMatch(/article\.htmlFallback && \(/);
    expect(body).toContain('t("plainTextFallback")');
    const de = JSON.parse(readFileSync(join(process.cwd(), "messages/de.json"), "utf8"));
    const en = JSON.parse(readFileSync(join(process.cwd(), "messages/en.json"), "utf8"));
    expect(de.articleReader.plainTextFallback).toBe("Als Klartext angezeigt (Darstellung vorübergehend nicht möglich)");
    expect(en.articleReader.plainTextFallback).toBe("Shown as plain text (formatting temporarily unavailable)");
  });
});


it("keeps the original link for sharing/icons while passing the private open destination", () => {
  const original = { ...article, link: "https://x.com/person/status/123" };
  const presented = withDetail(original, detail({ openLink: "https://social.private.example/person/status/123" }));
  expect(presented.link).toBe(original.link);
  expect(presented.openLink).toBe("https://social.private.example/person/status/123");
});
