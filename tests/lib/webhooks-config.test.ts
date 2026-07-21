import { describe, it, expect } from "vitest";
import { sanitizeWebhookConfigs, actionsReferenceConfigs, redactWebhookConfigs } from "../../lib/webhooks";

describe("sanitizeWebhookConfigs", () => {
  it("accepts valid http(s) configs and defaults the method to POST", () => {
    const { configs, valid } = sanitizeWebhookConfigs([{ url: "https://example.com/hook" }]);
    expect(valid).toBe(true);
    expect(configs).toEqual([{ url: "https://example.com/hook", method: "POST", headers: undefined, bodyTemplate: undefined, secret: undefined }]);
  });

  it("rejects a non-http(s) URL", () => {
    expect(sanitizeWebhookConfigs([{ url: "ftp://example.com" }]).valid).toBe(false);
    expect(sanitizeWebhookConfigs([{ url: "not a url" }]).valid).toBe(false);
    expect(sanitizeWebhookConfigs([{ url: "" }]).valid).toBe(false);
  });

  it("uppercases and validates the method, dropping unknown ones to POST", () => {
    expect(sanitizeWebhookConfigs([{ url: "https://e.com", method: "put" }]).configs[0].method).toBe("PUT");
    expect(sanitizeWebhookConfigs([{ url: "https://e.com", method: "TRACE" }]).configs[0].method).toBe("POST");
  });

  it("treats a non-array as an empty, valid set", () => {
    expect(sanitizeWebhookConfigs(undefined)).toEqual({ configs: [], valid: true });
  });
});

describe("actionsReferenceConfigs", () => {
  it("passes when every webhook_call index is in range", () => {
    expect(actionsReferenceConfigs(["mark_read", "webhook_call:0", "webhook_call:1"], 2)).toBe(true);
  });

  it("fails when a webhook_call index is out of range", () => {
    expect(actionsReferenceConfigs(["webhook_call:2"], 2)).toBe(false);
    expect(actionsReferenceConfigs(["webhook_call:0"], 0)).toBe(false);
  });

  it("ignores non-webhook actions", () => {
    expect(actionsReferenceConfigs(["mark_read", "notify_inapp"], 0)).toBe(true);
  });
});

describe("redactWebhookConfigs", () => {
  it("replaces the secret with a hasSecret flag and never leaks the value", () => {
    const raw = JSON.stringify([
      { url: "https://e.com/a", method: "POST", secret: "supersecret" },
      { url: "https://e.com/b", method: "GET" },
    ]);
    const redacted = redactWebhookConfigs(raw);
    expect(redacted).toEqual([
      { url: "https://e.com/a", method: "POST", headers: undefined, bodyTemplate: undefined, hasSecret: true },
      { url: "https://e.com/b", method: "GET", headers: undefined, bodyTemplate: undefined, hasSecret: false },
    ]);
    expect(JSON.stringify(redacted)).not.toContain("supersecret");
  });

  it("returns an empty array for null/garbage input", () => {
    expect(redactWebhookConfigs(null)).toEqual([]);
    expect(redactWebhookConfigs("not json")).toEqual([]);
  });
});
