import { Prisma, type PrismaClient } from "@prisma/client";
import { storedExternalId } from "./external-ids";

export async function allocateExternalIds(client: PrismaClient, count: number): Promise<string[]> {
  if (!count) return [];
  // The atomic increment reserves disjoint ranges across concurrent processes.
  const row = await client.externalIdSequence.upsert({
    where: { name: "global" },
    create: { name: "global", value: BigInt(Date.now()) * BigInt(1000) + BigInt(count) },
    update: { value: { increment: BigInt(count) } },
  });
  return Array.from({ length: count }, (_, i) => storedExternalId(row.value - BigInt(count - i - 1)));
}

// NOTE: allocation runs on the base client, not on a caller's interactive
// transaction. Never create Article/Feed/Category/Label via `tx.*.create` inside
// `db.$transaction(async (tx) => …)`: on SQLite (single connection) that would
// wait on itself until the transaction times out.
export function withExternalIds(client: PrismaClient) {
  return client.$extends({ query: { $allModels: {
    async $allOperations({ model, operation, args, query }) {
      if (!["Article", "Feed", "Category", "Label"].includes(model)) return query(args);
      // Avoid reserving a range for the usual upsert update path. A concurrent
      // insert can still leave a harmless gap; query() retains native upsert semantics.
      if (operation === "upsert") {
        const delegate = client[model.toLowerCase() as "article"];
        if (await delegate.findUnique({ where: (args as { where: Prisma.ArticleWhereUniqueInput }).where, select: { id: true } })) return query(args);
      }
      // Covers create, upsert and both bulk insert operations used by ingestion.
      const input = args as { data?: unknown; create?: unknown };
      const data = operation === "upsert" ? input.create :
        ["create", "createMany", "createManyAndReturn"].includes(operation) ? input.data : undefined;
      if (data) {
        const rows = (Array.isArray(data) ? data : [data]) as { extId?: string }[];
        const missing = rows.filter((row) => !row.extId);
        const ids = await allocateExternalIds(client, missing.length);
        missing.forEach((row, i) => { row.extId = ids[i]; });
      }
      return query(args);
    },
  } } });
}

export async function backfillExternalIds(client: PrismaClient, batchSize = 500) {
  for (const model of ["category", "feed", "label", "article"] as const) {
    // Delegate types have different overloads; all four share this small contract.
    const delegate = client[model] as unknown as {
      findMany(args: object): Promise<{ id: string }[]>;
    };
    for (;;) {
      const rows = await delegate.findMany({ where: { extId: null }, select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: batchSize });
      if (!rows.length) break;
      const ids = await allocateExternalIds(client, rows.length);
      const table = Prisma.raw(`"${model[0].toUpperCase()}${model.slice(1)}"`);
      const values = Prisma.join(rows.map((row, i) => Prisma.sql`(${row.id}, ${ids[i]})`));
      // Both supported engines accept a VALUES CTE and UPDATE FROM. Names are
      // constants; values remain bound parameters. CAS preserves existing IDs.
      // Concatenating the empty string preserves the null test but prevents
      // SQLite choosing extId=null as the join index (quadratic for large backfills).
      await client.$executeRaw(Prisma.sql`
        WITH batch(id, ext_id) AS (VALUES ${values})
        UPDATE ${table} SET "extId" = batch.ext_id FROM batch
        WHERE ${table}."id" = batch.id AND (${table}."extId" || '') IS NULL
      `);
    }
  }
}
