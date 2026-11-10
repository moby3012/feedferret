import { defineConfig } from "prisma/config";
import { buildPrismaCliConfig } from "./prisma/cli-config.mjs";

// Local dev config. The production runner uses prisma/startup.config.mjs instead
// (this file needs the `prisma/config` package, which the runner image does not have).
export default defineConfig(buildPrismaCliConfig({ schema: "prisma/schema.generated.prisma" }));
