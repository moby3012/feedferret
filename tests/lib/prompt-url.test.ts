import { describe, expect, it } from "vitest";
import { redactUrlForPrompt, redactUrlsInPromptText } from "../../lib/prompt-url";
import { buildPageDigest } from "../../lib/page-digest";
import { buildFeedConfigPrompt, reduceHtmlForPrompt } from "../../lib/ai-feed-config";
import { buildExtractionPrompt } from "../../lib/ai-extraction";

const SECRETS = ["hunter2", "s3cr3t", "tok_ABC", "SIGVALUE", "sess-777", "AKIA0000", "jwtpart", "magic123", "user@example.com"];
const OPAQUE = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";

describe("redactUrlForPrompt", () => {
  it("drops userinfo and fragments, masks sensitive params by name and opaque values by shape", () => {
    expect(redactUrlForPrompt("https://bob:hunter2@x.example/a?page=2&api_key=AKIA0000&access_token=tok_ABC#frag"))
      .toBe("https://x.example/a?page=2&api_key=***&access_token=***");
    expect(redactUrlForPrompt("https://x.example/feed.xml?zeitlinie=retail&feed=rss2")).toBe("https://x.example/feed.xml?zeitlinie=retail&feed=rss2");
    expect(redactUrlForPrompt(`https://cdn.example/i.jpg?X-Amz-Signature=SIGVALUE&w=200&v=${OPAQUE}`))
      .toBe("https://cdn.example/i.jpg?X-Amz-Signature=***&w=200&v=***");
    expect(redactUrlForPrompt("https://x.example/?sessionid=sess-777&PHPSESSID=abc&sid=1&code=magic123&state=x&email=user@example.com"))
      .toBe("https://x.example/?sessionid=***&PHPSESSID=***&sid=***&code=***&state=***&email=***");
    expect(redactUrlForPrompt("/login?token=tok_ABC", "https://x.example/")).toBe("https://x.example/login?token=***");
  });
});

describe("prompts never carry credentials from the page", () => {
  const html = `<!doctype html><html><head><title>T</title>
    <link rel="alternate" type="application/rss+xml" href="/feed.xml?key=s3cr3t"></head><body><main>
    <ul class="posts">${[1, 2, 3, 4].map((i) => `<li class="post"><a href="https://bob:hunter2@x.example/p/${i}?utm_source=a&token=tok_ABC">Post ${i}</a><img src="https://cdn.example/${i}.jpg?Signature=SIGVALUE" alt="p"></li>`).join("")}</ul>
    <a href="/account?session=sess-777&jwt=jwtpart">Account</a><a href="/rss?auth=magic123" title="RSS">RSS</a>
    </main></body></html>`;
  const pageUrl = "https://alice:hunter2@x.example/list?access_token=tok_ABC&email=user@example.com&page=1";

  it.each([
    ["page digest", () => buildPageDigest(html, pageUrl)],
    ["feed-config prompt", () => buildFeedConfigPrompt(html, pageUrl)],
    ["extraction prompt", () => buildExtractionPrompt(html, pageUrl)],
    ["reduced html", () => reduceHtmlForPrompt(html)],
  ])("%s", (_l, build) => {
    const out = build();
    for (const secret of SECRETS) expect(out, secret).not.toContain(secret);
    expect(out).not.toMatch(/alice|bob:/);
  });

  it("keeps harmless structure for the model", () => {
    const digest = buildPageDigest(html, pageUrl);
    expect(digest).toContain("URL: https://x.example/list?access_token=***&email=***&page=1");
    expect(digest).toContain("utm_source=a&token=***");
    expect(redactUrlsInPromptText('<a href="/p?page=3&token=x">')).toBe('<a href="/p?page=3&token=***">');
  });
});
