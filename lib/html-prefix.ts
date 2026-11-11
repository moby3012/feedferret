/**
 * Bounded, HTML-aware reading of a page's leading bytes (feed discovery on
 * large pages). Transport-agnostic: it consumes whatever response body the
 * SSRF-guarded fetch loop returns (plain fetch, impit or a pinned dispatcher).
 *
 * - The byte budget is enforced BEFORE anything is decoded or kept: a chunk
 *   that crosses the budget is cut to the remaining bytes, so the result never
 *   exceeds `maxBytes` no matter how the transport chunks the body.
 * - The end of `<head>` is found with a small tokenizer that skips comments
 *   and raw-text/RCDATA elements (`<script>`, `<style>`, `<title>`, …), so a
 *   literal "</head>" inside them does not end the head early. An implied head
 *   end (the first `<body>` start tag) also counts.
 * - The charset follows the HTML sniffing order: BOM, Content-Type `charset`,
 *   `<meta charset>` / `http-equiv` in the first 1024 bytes, else UTF-8.
 */

export const DEFAULT_HTML_PREFIX_BYTES = 1024 * 1024;

export type HtmlPrefixOptions = {
  /** Byte budget; reading stops (without error) once it is reached. */
  maxBytes?: number;
  /** Response Content-Type (for its `charset` parameter). */
  contentType?: string | null;
  /**
   * Called once the head is complete. Return true to stop there (only the
   * head is returned); false keeps reading (up to the budget) so the body's
   * anchors are available too. Default: stop at the head end.
   */
  stopAtHead?: boolean | ((headHtml: string) => boolean);
};

type BodyLike = { body: ReadableStream<Uint8Array> | null; text(): Promise<string> };

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);

/** Index of the first `>` that closes the tag starting at `start`, honouring quoted attribute values. */
function tagEnd(s: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Resumable scan for the end of the document head over a lower-cased latin1
 * view of the bytes (all markup is ASCII in ASCII-compatible encodings).
 * `end`: byte offset just past `</head>`, or of the first `<body` start tag;
 * -1 if not (yet) found. `resume`: where to continue once more bytes arrived
 * (the start of an incomplete construct).
 */
function scanHead(lower: string, from: number): { end: number; resume: number } {
  let i = from;
  while (i < lower.length) {
    const lt = lower.indexOf("<", i);
    if (lt < 0) return { end: -1, resume: lower.length };
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end < 0) return { end: -1, resume: lt };
      i = end + 3;
      continue;
    }
    if (lower.length - lt < 12 && !lower.includes(">", lt)) return { end: -1, resume: lt };
    const m = /^<(\/?)([a-z][a-z0-9-]*)/.exec(lower.slice(lt, lt + 40));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const [, closing, name] = m;
    if (!closing && name === "body") return { end: lt, resume: lt };
    const gt = tagEnd(lower, lt);
    if (gt < 0) return { end: -1, resume: lt };
    if (closing && name === "head") return { end: gt + 1, resume: gt + 1 };
    if (!closing && RAW_TEXT_ELEMENTS.has(name) && lower[gt - 1] !== "/") {
      const close = new RegExp(`</${name}[\\s/>]`, "g");
      close.lastIndex = gt + 1;
      const hit = close.exec(lower);
      if (!hit) return { end: -1, resume: lt };
      i = hit.index;
      continue;
    }
    i = gt + 1;
  }
  return { end: -1, resume: lower.length };
}

/** Byte offset where the document head ends (see scanHead), or -1. */
export function findHtmlHeadEnd(html: string): number {
  return scanHead(html.toLowerCase(), 0).end;
}

function charsetFromContentType(contentType?: string | null): string | null {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return m ? m[1] : null;
}

function charsetFromMeta(latin1Prefix: string): string | null {
  const direct = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([a-z0-9_:.()-]+)/i.exec(latin1Prefix);
  if (direct) return direct[1];
  for (const tag of latin1Prefix.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']?\s*content-type/i.test(tag)) continue;
    const m = /charset\s*=\s*["']?\s*([a-z0-9_:.()-]+)/i.exec(tag);
    if (m) return m[1];
  }
  return null;
}

function decoderFor(label: string | null): TextDecoder {
  if (label) {
    try {
      const decoder = new TextDecoder(label.trim().toLowerCase());
      // Per the HTML standard a UTF-16 meta declaration means UTF-8.
      if (!decoder.encoding.startsWith("utf-16")) return decoder;
    } catch {
      // unknown label → default
    }
  }
  return new TextDecoder("utf-8");
}

/** Decodes page bytes with the charset an HTML parser would pick. */
export function decodeHtmlBytes(bytes: Uint8Array, contentType?: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  const label = charsetFromContentType(contentType)
    ?? charsetFromMeta(Buffer.from(bytes.subarray(0, 1024)).toString("latin1"));
  return decoderFor(label).decode(bytes);
}

export async function readHtmlPrefix(response: BodyLike, options: HtmlPrefixOptions = {}): Promise<string> {
  const budget = Math.max(0, options.maxBytes ?? DEFAULT_HTML_PREFIX_BYTES);
  const stopAtHead = options.stopAtHead ?? true;
  if (!response.body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    return bytes.byteLength <= budget ? text : decodeHtmlBytes(bytes.subarray(0, budget), "text/html; charset=utf-8");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let headSeen = false;
  let lower = "";
  let resume = 0;
  try {
    while (received < budget) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      // Enforce the remaining budget before keeping/decoding anything.
      const chunk = value.byteLength > budget - received ? value.subarray(0, budget - received) : value;
      chunks.push(chunk);
      received += chunk.byteLength;

      if (!headSeen) {
        lower += Buffer.from(chunk).toString("latin1").toLowerCase();
        const scan = scanHead(lower, resume);
        resume = scan.resume;
        const end = scan.end;
        if (end >= 0) {
          headSeen = true;
          const head = decodeHtmlBytes(Buffer.concat(chunks).subarray(0, end), options.contentType);
          if (stopAtHead === true || (typeof stopAtHead === "function" && stopAtHead(head))) return head;
          lower = "";
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return decodeHtmlBytes(Buffer.concat(chunks), options.contentType);
}
