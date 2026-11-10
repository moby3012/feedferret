/**
 * Minimal, bounded, read-only ZIP reader for untrusted uploads (FreshRSS export).
 *
 * No third-party dependency: only `node:zlib` raw inflate. The archive lives in
 * memory and is never extracted to disk, so classic zip-slip cannot write
 * anywhere; entry names are nevertheless validated and an archive with a
 * traversal/absolute path is rejected as a whole.
 *
 * Guards: entry count, per-entry and total uncompressed size (enforced on the
 * ACTUAL inflated output via `maxOutputLength`, never trusting declared sizes),
 * per-entry and whole-archive compression-ratio ceiling, entries must not overlap
 * (one deflate stream cannot be referenced by many entries), CRC32, no encryption,
 * no ZIP64, only stored/deflate.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /**
   * Largest allowed uncompressed/compressed ratio: per entry above `ratioFloorBytes`,
   * and always for the declared total against the size of the whole upload.
   */
  maxRatio: number;
  ratioFloorBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
};

export type ZipErrorCode =
  | "not-a-zip"
  | "truncated"
  | "zip64-unsupported"
  | "encrypted"
  | "unsupported-method"
  | "too-many-entries"
  | "entry-too-large"
  | "archive-too-large"
  | "ratio-exceeded"
  | "overlapping-entries"
  | "unsafe-path"
  | "duplicate-entry"
  | "size-mismatch"
  | "crc-mismatch"
  | "corrupt";

export class ZipError extends Error {
  constructor(public readonly code: ZipErrorCode, message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localOffset: number;
  /** Length of the file name as stored in the central directory (minimum local header size). */
  nameLength: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

let crcTable: Uint32Array | null = null;
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL;
}

function assertSafeName(name: string) {
  const segments = name.split(/[\\/]/);
  if (
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[A-Za-z]:/.test(name) ||
    segments.includes("..")
  ) {
    throw new ZipError("unsafe-path", `Archive contains an unsafe path: ${JSON.stringify(name.slice(0, 120))}`);
  }
}

export class ZipArchive {
  readonly entries: ZipEntry[] = [];
  private totalRead = 0;
  /** Exclusive upper bound of each entry's byte range (start of the next record). */
  private readonly rangeEnd = new Map<ZipEntry, number>();

  constructor(private readonly buffer: Buffer, private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS) {
    this.parseCentralDirectory();
  }

  private parseCentralDirectory() {
    const buf = this.buffer;
    if (buf.length < 22) throw new ZipError("not-a-zip", "File is too small to be a ZIP archive");

    let eocd = -1;
    const lowest = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= lowest; i--) {
      if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError("not-a-zip", "ZIP end-of-central-directory record not found");

    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError("zip64-unsupported", "ZIP64 archives are not supported");
    }
    if (count > this.limits.maxEntries) {
      throw new ZipError("too-many-entries", `Archive has ${count} entries (limit ${this.limits.maxEntries})`);
    }
    if (cdOffset + cdSize > eocd) throw new ZipError("truncated", "Central directory lies outside the file");

    const seen = new Set<string>();
    let pos = cdOffset;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
        throw new ZipError("corrupt", "Invalid central directory entry");
      }
      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      const crc = buf.readUInt32LE(pos + 16);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const size = buf.readUInt32LE(pos + 24);
      const nameLength = buf.readUInt16LE(pos + 28);
      const extraLength = buf.readUInt16LE(pos + 30);
      const commentLength = buf.readUInt16LE(pos + 32);
      const localOffset = buf.readUInt32LE(pos + 42);
      const nameEnd = pos + 46 + nameLength;
      if (nameEnd + extraLength + commentLength > buf.length) throw new ZipError("truncated", "Central directory entry exceeds the file");
      if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new ZipError("zip64-unsupported", "ZIP64 entries are not supported");
      }

      const name = buf.toString(flags & 0x0800 ? "utf8" : "latin1", pos + 46, nameEnd);
      assertSafeName(name);
      if (seen.has(name)) throw new ZipError("duplicate-entry", `Archive lists '${name}' more than once`);
      seen.add(name);

      const isDirectory = name.endsWith("/");
      if (!isDirectory) {
        if (flags & 0x0001) throw new ZipError("encrypted", `Entry '${name}' is encrypted`);
        if (method !== 0 && method !== 8) throw new ZipError("unsupported-method", `Entry '${name}' uses unsupported compression method ${method}`);
        if (size > this.limits.maxEntryBytes) throw new ZipError("entry-too-large", `Entry '${name}' is larger than ${this.limits.maxEntryBytes} bytes`);
        if (size > this.limits.ratioFloorBytes && size / Math.max(1, compressedSize) > this.limits.maxRatio) {
          throw new ZipError("ratio-exceeded", `Entry '${name}' has a suspicious compression ratio`);
        }
      }
      this.entries.push({ name, isDirectory, method, compressedSize, size, crc32: crc, localOffset, nameLength });
      pos = nameEnd + extraLength + commentLength;
    }

    const declaredTotal = this.entries.reduce((sum, entry) => sum + entry.size, 0);
    if (declaredTotal > this.limits.maxTotalBytes) {
      throw new ZipError("archive-too-large", `Archive would expand to more than ${this.limits.maxTotalBytes} bytes`);
    }
    // Per-entry ratios skip small entries; the total does not. Together with the overlap
    // check below this bounds the work by the real upload size, not by the entry count.
    if (declaredTotal / Math.max(1, buf.length) > this.limits.maxRatio) {
      throw new ZipError("ratio-exceeded", "Archive has a suspicious overall compression ratio");
    }

    // Every entry owns its own [local header + data) byte range. Entries pointing at the
    // same bytes would multiply one tiny deflate stream into many large files.
    const ordered = [...this.entries].sort((a, b) => a.localOffset - b.localOffset);
    for (let i = 0; i < ordered.length; i++) {
      const entry = ordered[i];
      const end = entry.localOffset + 30 + entry.nameLength + entry.compressedSize;
      const limit = i + 1 < ordered.length ? ordered[i + 1].localOffset : cdOffset;
      if (end > limit) throw new ZipError("overlapping-entries", `Entry '${entry.name}' overlaps another entry or the central directory`);
      this.rangeEnd.set(entry, limit);
    }
  }

  /** Inflates one entry, enforcing the real (not the declared) output size. */
  read(entry: ZipEntry): Buffer {
    if (entry.isDirectory) return Buffer.alloc(0);
    const buf = this.buffer;
    const at = entry.localOffset;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== SIG_LOCAL) throw new ZipError("corrupt", `Bad local header for '${entry.name}'`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipError("truncated", `Entry '${entry.name}' is truncated`);
    if (end > (this.rangeEnd.get(entry) ?? buf.length)) throw new ZipError("overlapping-entries", `Entry '${entry.name}' overlaps another entry`);

    if (this.totalRead + entry.size > this.limits.maxTotalBytes) {
      throw new ZipError("archive-too-large", `Archive would expand to more than ${this.limits.maxTotalBytes} bytes`);
    }

    const raw = buf.subarray(start, end);
    let data: Buffer;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new ZipError("size-mismatch", `Entry '${entry.name}' size mismatch`);
      data = Buffer.from(raw);
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) {
          throw new ZipError("size-mismatch", `Entry '${entry.name}' expands beyond its declared size`);
        }
        throw new ZipError("corrupt", `Entry '${entry.name}' could not be decompressed`);
      }
    }
    if (data.length !== entry.size) throw new ZipError("size-mismatch", `Entry '${entry.name}' size mismatch`);
    if (crc32(data) !== entry.crc32) throw new ZipError("crc-mismatch", `Entry '${entry.name}' failed its CRC check`);
    this.totalRead += data.length;
    return data;
  }
}
