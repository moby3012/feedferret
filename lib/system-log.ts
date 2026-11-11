import { redact, redactValue } from "./redact";
import { db } from "@/lib/db"

// N1: newsletter address tokens (`box+ff-<token>@…`, `<token>@domain`) are
// secrets — whoever knows one can post into that user's library. They never
// belong in SystemLog, whatever code path logs an address.
// Plain and URL-encoded (`%2Bff-`); other encodings are an accepted residual
// risk (no code path logs addresses in another form).
const NEWSLETTER_TOKEN_RE = /(?:\+|%2B)ff-[a-z2-7]{6,}/gi

/** Metadata with `+ff-<token>` replaced by `+ff-[token]` in every string value (deep). */
export function redactLogMetadata(value: unknown): unknown {
  if (typeof value === "string") return value.replace(NEWSLETTER_TOKEN_RE, "+ff-[token]")
  if (Array.isArray(value)) return value.map(redactLogMetadata)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactLogMetadata(v)]))
  }
  return value
}

export async function writeSystemLog(
  level: "info" | "warn" | "error",
  category: "mail" | "digest" | "sync" | "security",
  message: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await db.systemLog.create({
      data: {
        level,
        category,
        message: redactLogMetadata(redact(String(message))) as string,
        metadata: metadata ? JSON.stringify(redactLogMetadata(redactValue(metadata))) : null,
      },
    })
  } catch {
    // never let logging break the caller
  }
}
