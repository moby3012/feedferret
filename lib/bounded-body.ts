/** Thrown when a request body exceeds its byte cap (map to HTTP 413). */
export class RequestTooLargeError extends Error {
  constructor() {
    super("Request too large");
    this.name = "RequestTooLargeError";
  }
}

/** Bound bytes while streaming, including requests without Content-Length. */
export async function readBoundedBytes(request: Request, max: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new RequestTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new RequestTooLargeError(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Bound bytes while streaming, including requests without Content-Length. */
export async function readGReaderBody(request: Request, max: number) {
  return (await readBoundedBytes(request, max)).toString("utf8");
}
