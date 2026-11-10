import { deflateRawSync } from "node:zlib";

/** Test-only ZIP writer. Every header field can be overridden to build hostile archives. */
export interface TestZipEntry {
  name: string;
  data?: Buffer | string;
  method?: 0 | 8;
  flags?: number;
  crc?: number;
  declaredSize?: number;
  declaredCompressedSize?: number;
  /** Write these bytes as the compressed payload instead of deflating `data`. */
  rawPayload?: Buffer;
}

let table: Uint32Array | null = null;
export function crc32(buf: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: TestZipEntry[], options: { eocdEntryCount?: number; truncateTo?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 8;
    const payload = entry.rawPayload ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.from(entry.name, "utf8");
    const crc = entry.crc ?? crc32(data);
    const size = entry.declaredSize ?? data.length;
    const csize = entry.declaredCompressedSize ?? payload.length;
    const flags = (entry.flags ?? 0) | 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = options.eocdEntryCount ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...locals, cd, eocd]);
  return options.truncateTo !== undefined ? zip.subarray(0, options.truncateTo) : zip;
}
