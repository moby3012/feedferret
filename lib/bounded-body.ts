/** Bound bytes while streaming, including requests without Content-Length. */
export async function readGReaderBody(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error("Request too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
