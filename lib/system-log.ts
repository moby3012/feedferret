import { redact, redactValue } from "./redact";
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
        message: redact(String(message)),
        metadata: metadata ? JSON.stringify(redactValue(metadata)) : null,
      },
    })
  } catch {
    // never let logging break the caller
  }
}
