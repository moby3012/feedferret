import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB before importing the module under test.
const findUnique = vi.fn();
vi.mock("../../lib/db", () => ({
  db: { globalSettings: { findUnique: () => findUnique() } },
}));

const ORIGINAL_ENV = { ...process.env };

async function load() {
  vi.resetModules();
  return import("../../lib/connector-hosts");
}

describe("connector-hosts", () => {
  beforeEach(() => {
    findUnique.mockReset();
    findUnique.mockResolvedValue(null);
    delete process.env.FEEDFERRET_RSSHUB_URL;
    delete process.env.FEEDFERRET_CHANGEDETECTION_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("includes ENV connector hosts (with port) regardless of DB", async () => {
    process.env.FEEDFERRET_RSSHUB_URL = "http://rsshub:3000/";
    const { getTrustedConnectorHosts, isTrustedConnectorUrl } = await load();
    const hosts = await getTrustedConnectorHosts();
    expect(hosts.has("rsshub:3000")).toBe(true);
    expect(await isTrustedConnectorUrl("http://rsshub:3000/youtube/user/x")).toBe(true);
  });

  it("includes DB-configured connector hosts only when enabled", async () => {
    findUnique.mockResolvedValue({
      rsshubEnabled: true,
      rsshubBaseUrl: "http://rsshub:3000",
      changedetectionEnabled: false,
      changedetectionBaseUrl: "http://changedetection:3000",
    });
    const { isTrustedConnectorUrl } = await load();
    expect(await isTrustedConnectorUrl("http://rsshub:3000/x")).toBe(true);
    // changedetection is present in the row but not enabled → not trusted
    expect(await isTrustedConnectorUrl("http://changedetection:3000/rss/watch/abc")).toBe(false);
  });

  it("does not trust arbitrary internal hosts", async () => {
    process.env.FEEDFERRET_RSSHUB_URL = "http://rsshub:3000/";
    const { isTrustedConnectorUrl } = await load();
    expect(await isTrustedConnectorUrl("http://postgres:5432/")).toBe(false);
    expect(await isTrustedConnectorUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("returns false for empty/invalid URLs and survives a DB error", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    const { isTrustedConnectorUrl } = await load();
    expect(await isTrustedConnectorUrl("")).toBe(false);
    expect(await isTrustedConnectorUrl("not a url")).toBe(false);
  });
});
