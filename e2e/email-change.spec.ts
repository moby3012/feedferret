import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { createEmptyUser, manifest, userColumns } from "./helpers/db";

for (const cancel of [false, true]) {
  test(`email link GET is inert; POST ${cancel ? "cancels" : "confirms"} without login`, async ({ page }) => {
    const user = createEmptyUser("desktop", `email-${cancel ? "cancel" : "confirm"}`);
    const token = randomBytes(32).toString("hex");
    const cancelToken = randomBytes(32).toString("hex");
    const hash = (t: string) => createHash("sha256").update(t).digest("hex");
    const db = new Database(manifest().dbPath);
    try {
      const row = db.prepare('SELECT id FROM "User" WHERE email = ?').get(user.email) as { id: string };
      const next = `${row.id}-new@e2e.test`;
      db.prepare('INSERT INTO "EmailChangeRequest" (id, userId, oldEmail, newEmail, tokenHash, cancelHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.id, user.email, next, hash(token), hash(cancelToken), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
      await page.goto(`/account/confirm-email?${cancel ? "c=" + cancelToken : "t=" + token}`);
      const button = page.getByRole("button", { name: cancel ? "Cancel email change" : "Confirm email address", exact: true });
      await expect(button).toBeVisible();
      expect(userColumns({ email: user.email }, ["email"]).email).toBe(user.email);
      expect(db.prepare('SELECT count(*) AS n FROM "EmailChangeRequest" WHERE userId = ?').get(row.id)).toEqual({ n: 1 });
      await expect(page.locator('input[name="token"]')).toHaveValue(cancel ? cancelToken : token);
      await button.click();
      await expect(page.getByRole("status")).toContainText(cancel ? "cancelled" : "confirmed");
      expect(db.prepare('SELECT email FROM "User" WHERE id = ?').get(row.id)).toEqual({ email: cancel ? user.email : next });
      expect(db.prepare('SELECT count(*) AS n FROM "EmailChangeRequest" WHERE userId = ?').get(row.id)).toEqual({ n: 0 });
    } finally {
      db.close();
      // createEmptyUser cleanup uses the original id, including after confirmation.
      user.cleanup();
    }
  });
}

test("invalid links show the localized expired-link message", async ({ page, context }) => {
  await context.addCookies([{ name: "locale", value: "de", domain: "localhost", path: "/" }]);
  await page.goto("/account/confirm-email?t=invalid");
  await page.getByRole("button", { name: "E-Mail-Adresse bestätigen", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("ungültig oder abgelaufen");
});
