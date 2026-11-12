import { describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn(async (_args: { data: { message: string; metadata: string | null } }) => ({})));
vi.mock("@/lib/db", () => ({ db: { systemLog: { create } } }));

import { redactLogMetadata, writeSystemLog } from "@/lib/system-log";

const TOKEN = "abcdefghijklmnopqrstuvwxyz";

describe("SystemLog never stores newsletter tokens (N1)", () => {
  it("redacts +ff-<token> in message and nested metadata", async () => {
    await writeSystemLog("info", "mail", `Email sent to box+ff-${TOKEN}@gmail.com`, { to: `box+ff-${TOKEN}@gmail.com`, list: [{ cc: `x+FF-${TOKEN}@a.de` }], n: 3 });
    const { data } = create.mock.calls[0][0];
    expect(data.message).toBe("Email sent to box+ff-[token]@gmail.com");
    expect(data.metadata).not.toContain(TOKEN);
    expect(JSON.parse(data.metadata!)).toEqual({ to: "box+ff-[token]@gmail.com", list: [{ cc: "x+ff-[token]@a.de" }], n: 3 });
  });

  it("also redacts the URL-encoded form", () => {
    expect(redactLogMetadata({ url: `mailto:box%2Bff-${TOKEN}%40gmail.com` })).toEqual({ url: "mailto:box+ff-[token]%40gmail.com" });
  });

  it("leaves other values alone", () => {
    expect(redactLogMetadata({ to: "me@example.org", subject: "Hi +ff" })).toEqual({ to: "me@example.org", subject: "Hi +ff" });
  });
});

describe("SystemLog masks credentials in free text and metadata", () => {
  it("masks authorization=…, Authorization headers and access_token pairs before storing", async () => {
    create.mockClear();
    await writeSystemLog("warn", "sync", "fetch failed: authorization=Bearer s3cr3tA https://h.test/f?access_token=s3cr3tB&x=1", {
      header: "Authorization: Basic c3VwZXJzZWNyZXQ=",
      nested: [{ apikey: "k", note: "api_key=s3cr3tC" }],
    });
    const { data } = create.mock.calls[0][0];
    expect(data.message).toBe("fetch failed: authorization=Bearer *** https://h.test/f?access_token=***&x=1");
    expect(data.metadata).not.toMatch(/s3cr3t/);
    expect(JSON.parse(data.metadata!)).toEqual({ header: "Authorization: Basic ***", nested: [{ apikey: "***", note: "api_key=***" }] });
  });
});
