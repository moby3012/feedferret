/** Fixed-width storage gives lossless numeric range ordering on both providers. */
export function storedExternalId(value: string | bigint): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error("Invalid numeric external ID");
  const id = BigInt(text);
  if (id > BigInt("9223372036854775807")) throw new Error("External ID out of range");
  return id.toString().padStart(19, "0");
}

export function decimalExternalId(value: string | null | undefined): string {
  if (!value) throw new Error("External identity backfill required");
  return BigInt(value).toString();
}

export function externalItemWhere(ids: string[]) {
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  return { OR: [
    { extId: { in: numeric.map(storedExternalId) } },
    { id: { in: ids.filter((id) => !/^\d+$/.test(id)) } },
  ] };
}
