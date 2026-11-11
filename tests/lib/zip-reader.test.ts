import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { DEFAULT_ZIP_LIMITS, isZipBuffer, ZipArchive, ZipError, type ZipLimits } from "../../lib/import/zip-reader";
import { buildZip, crc32 } from "../helpers/zip-builder";

const small: ZipLimits = { maxEntries: 5, maxEntryBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxRatio: 100, ratioFloorBytes: 64 * 1024 };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return "no-error";
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return "no-error";
}

describe("ZipArchive — happy path", () => {
  it("lists and reads stored and deflated entries, skipping directories", async () => {
    const zip = buildZip([
      { name: "export/", data: "", method: 0 },
      { name: "export/feeds.opml.xml", data: "<opml/>" },
      { name: "export/starred.json", data: '{"items":[]}', method: 0 },
    ]);
    expect(isZipBuffer(zip)).toBe(true);
    const archive = new ZipArchive(zip);
    expect(archive.entries.map((e) => [e.name, e.isDirectory])).toEqual([
      ["export/", true],
      ["export/feeds.opml.xml", false],
      ["export/starred.json", false],
    ]);
    expect((await archive.read(archive.entries[1])).toString()).toBe("<opml/>");
    expect((await archive.read(archive.entries[2])).toString()).toBe('{"items":[]}');
  });

  it("is not fooled by a non-zip file", () => {
    expect(isZipBuffer(Buffer.from("<opml/>"))).toBe(false);
    expect(codeOf(() => new ZipArchive(Buffer.from("PK\u0003\u0004 definitely not a zip file, just text")))).toBe("not-a-zip");
  });
});

describe("ZipArchive — hostile archives", () => {
  it.each([
    ["relative traversal", "../../etc/cron.d/evil"],
    ["nested traversal", "export/../../evil.json"],
    ["absolute path", "/etc/passwd"],
    ["windows drive", "C:\\Windows\\win.ini"],
    ["backslash traversal", "..\\..\\evil.json"],
    ["NUL byte", "ok.json\0.png"],
  ])("rejects zip-slip: %s", (_label, name) => {
    expect(codeOf(() => new ZipArchive(buildZip([{ name, data: "{}" }])))).toBe("unsafe-path");
  });

  it("rejects duplicate entry names", () => {
    expect(codeOf(() => new ZipArchive(buildZip([{ name: "a.json", data: "{}" }, { name: "a.json", data: "{}" }])))).toBe("duplicate-entry");
  });

  it("rejects archives with too many entries before reading any", () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.json`, data: "{}" }));
    expect(codeOf(() => new ZipArchive(buildZip(entries), small))).toBe("too-many-entries");
  });

  it("rejects a lying EOCD entry count that exceeds the limit", () => {
    expect(codeOf(() => new ZipArchive(buildZip([{ name: "a.json", data: "{}" }], { eocdEntryCount: 60_000 }), small))).toBe("too-many-entries");
  });

  it("rejects entries declared larger than the per-entry limit", () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    expect(codeOf(() => new ZipArchive(buildZip([{ name: "big.json", data: big }]), small))).toBe("entry-too-large");
  });

  it("rejects a decompression bomb by compression ratio", () => {
    const zeros = Buffer.alloc(900 * 1024);
    const limits = { ...small, maxEntryBytes: 4 * 1024 * 1024 };
    expect(deflateRawSync(zeros).length * limits.maxRatio).toBeLessThan(zeros.length);
    expect(codeOf(() => new ZipArchive(buildZip([{ name: "bomb.json", data: zeros }]), limits))).toBe("ratio-exceeded");
  });

  it("enforces the real output size when the header lies about it", async () => {
    const real = Buffer.alloc(512 * 1024, 0x62);
    const zip = buildZip([{ name: "liar.json", data: real, declaredSize: 10, crc: crc32(real) }]);
    const archive = new ZipArchive(zip, small);
    expect(await codeOfAsync(() => archive.read(archive.entries[0]))).toBe("size-mismatch");
  });

  it("enforces the total uncompressed budget across entries (declared sizes sum)", () => {
    const chunk = Buffer.from("x".repeat(900 * 1024));
    const entries = [1, 2, 3].map((i) => ({ name: `f${i}.json`, data: Buffer.concat([chunk, Buffer.from(String(i))]), method: 0 as const }));
    expect(codeOf(() => new ZipArchive(buildZip(entries), small))).toBe("archive-too-large");
  });

  it("enforces the total budget while reading even when declared sizes are small", async () => {
    const limits: ZipLimits = { ...small, maxTotalBytes: 100 };
    const data = Buffer.from("y".repeat(60));
    const archive = new ZipArchive(buildZip([{ name: "a.json", data, method: 0 }, { name: "b.json", data, method: 0 }]), { ...limits, maxTotalBytes: 130 });
    await archive.read(archive.entries[0]);
    await archive.read(archive.entries[1]);
    const tight = new ZipArchive(buildZip([{ name: "a.json", data, method: 0 }]), { ...limits, maxTotalBytes: 60 });
    await tight.read(tight.entries[0]);
    expect(await codeOfAsync(() => tight.read(tight.entries[0]))).toBe("archive-too-large");
  });

  it("rejects encrypted entries, unsupported methods and ZIP64 markers", () => {
    expect(codeOf(() => new ZipArchive(buildZip([{ name: "s.json", data: "{}", flags: 0x1 }])))).toBe("encrypted");
    const bzip = buildZip([{ name: "b.json", data: "{}" }]);
    bzip.writeUInt16LE(12, bzip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(codeOf(() => new ZipArchive(bzip))).toBe("unsupported-method");
    const z64 = buildZip([{ name: "z.json", data: "{}", declaredSize: 0xffffffff }]);
    expect(codeOf(() => new ZipArchive(z64))).toBe("zip64-unsupported");
  });

  it("detects corrupted data via CRC and truncated archives", async () => {
    const data = Buffer.from('{"items":[]}');
    const bad = new ZipArchive(buildZip([{ name: "c.json", data, method: 0, crc: 1234 }]));
    expect(await codeOfAsync(() => bad.read(bad.entries[0]))).toBe("crc-mismatch");
    const zip = buildZip([{ name: "t.json", data: "x".repeat(2000) }]);
    expect(codeOf(() => new ZipArchive(zip.subarray(0, zip.length - 30)))).toMatch(/not-a-zip|truncated|corrupt/);
  });

  it("reports garbage deflate streams as corrupt, not as a crash", async () => {
    const archive = new ZipArchive(buildZip([{ name: "g.json", data: "abcdef", rawPayload: Buffer.from([0xff, 0xff, 0xff, 0xff]), declaredSize: 6 }]));
    expect(await codeOfAsync(() => archive.read(archive.entries[0]))).toMatch(/corrupt|size-mismatch/);
  });

  it("rejects entries that share bytes (one deflate stream referenced by many entries)", () => {
    const zip = buildZip([{ name: "a.json", data: "x".repeat(2000) }, { name: "b.json", data: "y" }]);
    // Point b.json's central record at a.json's local header.
    const second = zip.indexOf(Buffer.from("b.json"), zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 46) - 46;
    expect(zip.readUInt32LE(second)).toBe(0x02014b50);
    zip.writeUInt32LE(0, second + 42);
    expect(codeOf(() => new ZipArchive(zip))).toBe("overlapping-entries");
  });

  it("rejects a data range that runs into the next entry", () => {
    const zip = buildZip([{ name: "a.json", data: "x".repeat(2000) }, { name: "b.json", data: "y" }]);
    const a = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(zip.readUInt32LE(a + 20) + 20, a + 20);
    expect(codeOf(() => new ZipArchive(zip))).toBe("overlapping-entries");
  });

  it("caps the declared total against the real upload size even when every entry is below the ratio floor", () => {
    // 300 entries x 1 MB declared, all pointing at one tiny deflate stream would be caught by the
    // overlap rule; here distinct tiny entries still claim far more than the archive could hold.
    const zeros = Buffer.alloc(1024 * 1024);
    const entries = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.json`, data: zeros }));
    const limits: ZipLimits = { ...small, maxEntries: 100, maxEntryBytes: 2 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, ratioFloorBytes: 2 * 1024 * 1024 };
    expect(codeOf(() => new ZipArchive(buildZip(entries), limits))).toBe("ratio-exceeded");
  });

  it("ships sane defaults", () => {
    expect(DEFAULT_ZIP_LIMITS.maxEntries).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_ZIP_LIMITS.maxTotalBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
  });
});

describe("ZipArchive — N9 resource limits", () => {
  it("caps the expanded archive at 128 MB by default", () => {
    expect(DEFAULT_ZIP_LIMITS.maxTotalBytes).toBe(128 * 1024 * 1024);
  });

  it("inflates without blocking the event loop", async () => {
    const data = Buffer.alloc(8 * 1024 * 1024, 0x61);
    // A plain 8 MB entry of one byte compresses far beyond the ratio limit; relax it for this test.
    const archive = new ZipArchive(buildZip([{ name: "big.json", data }]), { ...DEFAULT_ZIP_LIMITS, maxRatio: 100_000 });
    let ticked = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => { ticked = true; resolve(); }));
    const reading = archive.read(archive.entries[0]);
    // A sync inflate would finish before any other callback could run.
    await tick;
    const out = await reading;
    expect(ticked).toBe(true);
    expect(out.length).toBe(data.length);
  });

  it("reserves the total budget before inflating, so overlapping reads cannot both pass it", async () => {
    const data = Buffer.from("z".repeat(60));
    const archive = new ZipArchive(buildZip([{ name: "a.json", data }]), { ...small, maxTotalBytes: 100 });
    // The same entry twice at once (60 + 60 > 100): only one read may pass the budget.
    const results = await Promise.allSettled([archive.read(archive.entries[0]), archive.read(archive.entries[0])]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ZipError).code).toBe("archive-too-large");
  });
});
