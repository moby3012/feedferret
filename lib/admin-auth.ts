import { auth } from "@/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Admin gate for server actions: active ADMIN session, plus 2FA when the
 * instance requires it for admins. Throws otherwise. Not a server action
 * itself (lives outside a "use server" module on purpose).
 */
export async function requireAdmin() {
  const session = await auth();
  const currentUser = session?.user?.id
    ? await db.user.findUnique({ where: { id: session.user.id }, select: { role: true, isActive: true } })
    : null;
  if (!session?.user?.id || !currentUser?.isActive || currentUser.role !== "ADMIN") {
    throw new Error("Unauthorized: Admin access required");
  }
  const settings = await db.globalSettings.findUnique({ where: { id: "global" }, select: { require2FAForAdmins: true } });
  if (settings?.require2FAForAdmins) {
    const user = await db.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });
    if (!user?.twoFactorEnabled) {
      throw new Error("This instance requires admins to have 2FA enabled. Please enable it in Settings → Security.");
    }
  }
  return { ...session, user: { ...session.user, id: session.user.id } };
}

export async function logAdminAction(actorId: string, action: string, metadata?: Record<string, unknown>) {
  try {
    await db.adminAuditLog.create({
      data: { actorId, action, targetId: null, targetEmail: null, metadata: metadata ? JSON.stringify(metadata) : null },
    });
  } catch (err) {
    logger.error("[audit]", err);
  }
}
