import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.generated.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  },
});
