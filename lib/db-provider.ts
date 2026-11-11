const aliases: Record<string, "sqlite" | "postgresql"> = {
  sqlite: "sqlite",
  file: "sqlite",
  postgres: "postgresql",
  postgresql: "postgresql",
};

// Shared provider resolution so other modules (e.g. lib/search.ts, lib/search-indexes.ts,
// server/articles/bulk-read.ts) agree with the adapter on whether we're running against
// SQLite or PostgreSQL.
export function getDatabaseProvider(): "sqlite" | "postgresql" {
  return aliases[(process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase()] ?? "sqlite";
}
