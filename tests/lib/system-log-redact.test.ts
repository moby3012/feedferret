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

  it("leaves other values alone", () => {
    expect(redactLogMetadata({ to: "me@example.org", subject: "Hi +ff" })).toEqual({ to: "me@example.org", subject: "Hi +ff" });
  });
});
