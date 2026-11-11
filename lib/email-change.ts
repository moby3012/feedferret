import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { sendSystemEmail } from "@/lib/mail";

export const hashEmailChangeToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const EMAIL_CHANGE_TTL = 24 * 60 * 60 * 1000;

export async function requestEmailChange(userId: string, oldEmail: string | null, newEmail: string, locale: string | null, sessionVersion?: number) {
  const token = randomBytes(32).toString("hex");
  const cancel = randomBytes(32).toString("hex");
  const values = { oldEmail, newEmail, tokenHash: hashEmailChangeToken(token), cancelHash: hashEmailChangeToken(cancel), expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL) };
  const configuredBase = process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configuredBase && process.env.NODE_ENV === "production") throw new Error("AUTH_URL or NEXT_PUBLIC_APP_URL is required for email changes");
  const base = (configuredBase || "http://localhost:3000").replace(/\/$/, "");
  const de = locale === "de";
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const send = (to: string, subject: string, text: string) => {
    const url = text.slice(text.lastIndexOf(" ") + 1);
    return sendSystemEmail({ to, subject, text, html: `<p>${escape(text)}</p><p><a href="${escape(url)}">${escape(subject)}</a></p>` });
  };
  // Deliver the security notice first. A failed old-address notice must never
  // activate a confirmation token (or replace an existing pending request).
  if (oldEmail) {
    const masked = `${newEmail.slice(0, 1)}***@${newEmail.slice(newEmail.lastIndexOf("@") + 1)}`;
    try {
      await send(oldEmail, de ? "Änderung deiner E-Mail-Adresse angefordert" : "Email change requested", `${de ? `Eine Änderung auf ${masked} wurde angefordert. Abbrechen:` : `A change to ${masked} was requested. Cancel:`} ${base}/account/confirm-email?c=${cancel}`);
    } catch {
      throw new EmailChangeNoticeError();
    }
  }
  await db.$transaction(async tx => {
    // Lock against confirmation/security mutations before replacing a request.
    const locked = await tx.user.updateMany({ where: { id: userId, email: oldEmail, isActive: true, ...(sessionVersion === undefined ? {} : { sessionVersion }) }, data: { sessionVersion: { increment: 0 } } });
    if (!locked.count) throw new Error("Account changed; sign in again");
    await tx.emailChangeRequest.upsert({ where: { userId }, create: { userId, ...values }, update: values });
  });
  try {
    await send(newEmail, de ? "E-Mail-Adresse bestätigen" : "Confirm email address", `${de ? "Bestätige deine neue E-Mail-Adresse innerhalb von 24 Stunden:" : "Confirm your new email address within 24 hours:"} ${base}/account/confirm-email?t=${token}`);
    return true;
  } catch {
    return false;
  }
}

export class EmailChangeNoticeError extends Error {
  constructor() { super("The old-address security notice could not be delivered"); }
}

export async function consumeEmailChange(token: string, cancel = false): Promise<"confirmed" | "cancelled" | "invalid" | "emailTaken"> {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return "invalid";
  const hash = hashEmailChangeToken(token);
  try {
    const result = await db.$transaction(async tx => {
      const request = await tx.emailChangeRequest.findUnique({ where: cancel ? { cancelHash: hash } : { tokenHash: hash } });
      if (!request || request.expiresAt.getTime() <= Date.now()) return { status: "invalid" as const };
      const locked = await tx.user.updateMany({ where: { id: request.userId, email: request.oldEmail, isActive: true }, data: { sessionVersion: { increment: 0 } } });
      if (!locked.count) return { status: "invalid" as const };
      // Claim by hash, not id: a concurrent resend must not be consumed by an old link.
      const claimed = await tx.emailChangeRequest.deleteMany({ where: { id: request.id, tokenHash: request.tokenHash, cancelHash: request.cancelHash, expiresAt: { gt: new Date() } } });
      if (!claimed.count) return { status: "invalid" as const };
      if (cancel) {
        await tx.user.update({ where: { id: request.userId }, data: { sessionVersion: { increment: 1 }, apiTokenVersion: { increment: 1 }, apiFeverKey: null } });
        await tx.apiToken.updateMany({ where: { userId: request.userId }, data: { feverKey: null } });
        return { status: "cancelled" as const };
      }
      const taken = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE lower(email) = ${request.newEmail} AND id <> ${request.userId} LIMIT 1`;
      if (taken.length) return { status: "emailTaken" as const };
      await tx.user.update({ where: { id: request.userId }, data: { email: request.newEmail, emailVerified: new Date(), sessionVersion: { increment: 1 }, apiTokenVersion: { increment: 1 }, apiFeverKey: null } });
      await tx.apiToken.updateMany({ where: { userId: request.userId }, data: { feverKey: null } });
      return { status: "confirmed" as const, oldEmail: request.oldEmail };
    });
    if (result.status === "confirmed" && result.oldEmail) {
      await sendSystemEmail({ to: result.oldEmail, subject: "FeedFerret: E-Mail-Adresse geändert / Email changed", text: "Die E-Mail-Adresse deines Kontos wurde geändert. / Your account email address was changed. Nicht du? Ändere sofort dein Passwort oder kontaktiere den Admin. / Not you? Change your password immediately or contact the administrator.", html: "<p>Die E-Mail-Adresse deines Kontos wurde geändert. / Your account email address was changed. Nicht du? Ändere sofort dein Passwort oder kontaktiere den Admin. / Not you? Change your password immediately or contact the administrator.</p>" }).catch(() => undefined);
    }
    return result.status;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return "emailTaken";
    throw error;
  }
}
