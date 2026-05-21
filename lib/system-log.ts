import { db } from "@/lib/db"

export async function writeSystemLog(
  level: "info" | "warn" | "error",
  category: "mail" | "digest" | "sync",
  message: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await db.systemLog.create({
      data: {
        level,
        category,
        message,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    })
  } catch {
    // never let logging break the caller
  }
}
