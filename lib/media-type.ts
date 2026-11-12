/** Accept a single raster MIME type, with at most one harmless charset parameter. */
export function mediaType(raw: string | null): string | null {
  const match = /^(image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon))(?:\s*;\s*charset=(?:[a-z0-9_-]+|"[a-z0-9_-]+"))?$/i.exec(raw?.trim() ?? "");
  return match?.[1].toLowerCase() ?? null;
}

/** Header check only, not a full decoder. Read up to 32 bytes before serving. */
export function matchesMediaMagic(type: string, bytes: Uint8Array): boolean {
  const at = (offset: number, value: number[]) => value.every((byte, i) => bytes[offset + i] === byte);
  const ascii = (offset: number, value: string) => at(offset, [...value].map(c => c.charCodeAt(0)));
  switch (type) {
    case "image/png": return at(0, [137, 80, 78, 71, 13, 10, 26, 10]);
    case "image/jpeg": return at(0, [255, 216, 255]);
    case "image/gif": return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/avif": {
      if (!ascii(4, "ftyp")) return false;
      const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      if (size < 16) return false;
      return [8, 16, 20, 24, 28].some(offset => offset + 4 <= Math.min(size, bytes.length) && (ascii(offset, "avif") || ascii(offset, "avis")));
    }
    case "image/bmp": return ascii(0, "BM");
    case "image/x-icon":
    case "image/vnd.microsoft.icon": return at(0, [0, 0, 1, 0]);
    default: return false;
  }
}
