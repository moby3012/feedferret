// Prisma CLI config for the production runner (start.sh -> scripts/db-sync.sh).
// No `prisma/config` import on purpose, see prisma/cli-config.mjs.
import { buildPrismaCliConfig } from "./cli-config.mjs";

export default buildPrismaCliConfig({ schema: "schema.generated.prisma" });
