"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";

export async function deleteOwnAccount(): Promise<{ success: true } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated" };
  }

  const userId = session.user.id;

  if (session.user.role === "ADMIN") {
    const adminCount = await db.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return { error: "Cannot delete the last admin account. Assign another admin first." };
    }
  }

  await db.user.delete({ where: { id: userId } });
  // All related data (feeds, articles, labels, categories, etc.) cascade-deleted by Prisma

  return { success: true };
}
