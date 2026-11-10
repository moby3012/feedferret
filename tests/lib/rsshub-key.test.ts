import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({ db: {} }));

import { applyRsshubKeyWith, buildRsshubPublicRouteUrl } from "../../lib/rsshub";

const config = { baseUrl: "http://rsshub.internal:1200", apiKey: "k3y" };

describe("RSSHub key handling", () => {
  it("public route URLs never carry the key", () => {
    expect(buildRsshubPublicRouteUrl(config, "github/issue/a/b")).toBe("http://rsshub.internal:1200/github/issue/a/b");
  });

  it("adds the key only to keyless URLs on the configured instance", () => {
    expect(applyRsshubKeyWith(config, "http://rsshub.internal:1200/github/issue/a/b")).toBe(
      "http://rsshub.internal:1200/github/issue/a/b?key=k3y",
    );
    expect(applyRsshubKeyWith(config, "http://rsshub.internal:1200/x?key=other")).toBe("http://rsshub.internal:1200/x?key=other");
    expect(applyRsshubKeyWith(config, "https://example.com/feed.xml")).toBe("https://example.com/feed.xml");
    expect(applyRsshubKeyWith(config, "http://rsshub.internal:1201/x")).toBe("http://rsshub.internal:1201/x");
    expect(applyRsshubKeyWith({ ...config, apiKey: null }, "http://rsshub.internal:1200/x")).toBe("http://rsshub.internal:1200/x");
    expect(applyRsshubKeyWith(null, "not a url")).toBe("not a url");
  });
});
