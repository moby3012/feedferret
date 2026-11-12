#!/usr/bin/env node
// Account recovery for operators (shipped in the Docker image, plain ESM).
//
//   node scripts/auth-cli.mjs unlock-user <email>        (also: pnpm cli unlock-user --user <email>)
//
// Clears the per-account sign-in lockout (User.failedLoginCount / failedLoginWindowEnd and the
// GReader/Fever counter) so password sign-in works again immediately instead of after the 15-minute
// window. Needed when the owner is locked out and has no magic-link/OAuth sign-in to fall back on.
// Docker: docker compose exec feedferret node scripts/auth-cli.mjs unlock-user owner@example.com
import { createPrisma } from "./secrets-cli.mjs";

// Keep in sync with CLEAR_LOGIN_LOCKOUT in lib/account-lockout.ts.
export const CLEAR_LOGIN_LOCKOUT = {
  failedLoginCount: 0, failedLoginWindowEnd: null, failedApiLoginCount: 0, failedApiLoginWindowEnd: null,
};

export async function main(argv = process.argv.slice(2)) {
  const [cmd = "help", ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
  if (cmd === "unlock-user") {
    const flag = rest.indexOf("--user");
    const email = (flag >= 0 ? rest[flag + 1] : rest.find((value) => !value.startsWith("--")))?.trim();
    if (!email) {
      console.error("Usage: unlock-user <email>");
      return 1;
    }
    const prisma = await createPrisma();
    try {
      const result = await prisma.user.updateMany({
        where: { email: { in: [...new Set([email, email.toLowerCase()])] } },
        data: CLEAR_LOGIN_LOCKOUT,
      });
      if (result.count === 0) {
        console.error(`User not found: ${email}`);
        return 1;
      }
      console.log(`Sign-in lockout cleared for ${email}.`);
      return 0;
    } finally {
      await prisma.$disconnect();
    }
  }
  console.log("FeedFerret auth CLI\n\nCommands:\n  unlock-user <email>   clear the per-account sign-in lockout\n");
  return cmd === "help" ? 0 : 1;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/auth-cli.mjs");
if (invokedDirectly) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
