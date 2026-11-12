import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getDatabaseProvider } from "@/lib/db-provider";

// Per-article user state (read / star / read-later) written WITHOUT touching `Article.updatedAt`.
//
// Prisma's `@updatedAt` stamps every row that `update` / `updateMany` touches, and `updatedAt` is the
// GReader `updated` / ot-nt clock that sync clients use to decide what to re-download. Read, star and
// read-later state are user state, not upstream content, so these writes go out as raw UPDATEs — the
// same approach as server/articles/bulk-read.ts (which covers the bulk paths).
//
// Each statement only touches the user's own rows that do NOT hold the target value yet, so repeating a
// toggle keeps `readAt` / `readLaterSavedAt` stable, and a row is counted only when it really changed.
// Field names are fixed literals below, never caller input.

export type UserStateField = "isRead" | "isStarred" | "isReadLater";
export type UserStatePatch = Partial<Record<UserStateField, boolean>>;

/** One boolean field set to `value` on `ids`. */
export interface UserStateGroup {
  field: UserStateField;
  value: boolean;
  ids: readonly string[];
}

/** Groups for one patch applied to the same ids (fields left undefined in `patch` are not touched). */
export function userStateGroups(ids: readonly string[], patch: UserStatePatch): UserStateGroup[] {
  const groups: UserStateGroup[] = [];
  for (const field of ["isRead", "isStarred", "isReadLater"] as const) {
    const value = patch[field];
    if (value !== undefined) groups.push({ field, value, ids });
  }
  return groups;
}

type StatementClient = Pick<Prisma.TransactionClient, "$executeRaw">;

function idFilter(ids: readonly string[]): Prisma.Sql {
  return getDatabaseProvider() === "postgresql"
    ? Prisma.sql`"id" = ANY(${[...ids]}::text[])`
    : Prisma.sql`"id" IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

function statement(client: StatementClient, userId: string, group: UserStateGroup, now: Date): Prisma.PrismaPromise<number> {
  const { field, value } = group;
  const ids = idFilter(group.ids);
  const sql = (() => {
    switch (field) {
      case "isRead":
        return Prisma.sql`UPDATE "Article" SET "isRead" = ${value}, "readAt" = ${value ? now : null} WHERE "userId" = ${userId} AND "isRead" = ${!value} AND ${ids}`;
      case "isStarred":
        return Prisma.sql`UPDATE "Article" SET "isStarred" = ${value} WHERE "userId" = ${userId} AND "isStarred" = ${!value} AND ${ids}`;
      case "isReadLater":
        return Prisma.sql`UPDATE "Article" SET "isReadLater" = ${value}, "readLaterSavedAt" = ${value ? now : null} WHERE "userId" = ${userId} AND "isReadLater" = ${!value} AND ${ids}`;
    }
  })();
  return client.$executeRaw(sql);
}

/**
 * Unrun statements for `groups` (empty groups are skipped). Batch them in `db.$transaction([...])`, or
 * await them in order inside an interactive transaction (`tx`).
 */
export function userStateStatements(client: StatementClient, userId: string, groups: readonly UserStateGroup[], now = new Date()): Prisma.PrismaPromise<number>[] {
  return groups.filter((group) => group.ids.length > 0).map((group) => statement(client, userId, group, now));
}

/** Applies `groups` for `userId` in one transaction; returns how many rows changed (summed over the groups). */
export async function writeUserState(userId: string, groups: readonly UserStateGroup[], now = new Date()): Promise<number> {
  const statements = userStateStatements(db, userId, groups, now);
  if (statements.length === 0) return 0;
  const counts = await db.$transaction(statements);
  return counts.reduce((sum, count) => sum + count, 0);
}
