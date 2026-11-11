import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../helpers/test";
import { buildZip } from "../../tests/helpers/zip-builder";

/**
 * "Move from FreshRSS" flow in Manage feeds → Import/Export. Only the dry-run
 * preview and the error paths are exercised here: confirming would write rows into
 * the shared seeded DB and shift other specs' counts (the write path, idempotency
 * and rollback are covered against a real SQLite DB in
 * tests/lib/freshrss-migration.sqlite.test.ts).
 */

const fixture = (name: string) => fs.readFileSync(path.resolve("tests", "fixtures", "freshrss", name));

async function openImportTab(page: Page, isMobile: boolean) {
  await page.goto("/manage-feeds");
  const tab = page.getByRole("tab", { name: "Import/Export" });
  // Narrow screens: the tab row scrolls horizontally (no <select> any more).
  await tab.scrollIntoViewIfNeeded();
  await (isMobile ? tab.tap() : tab.click());
  const card = page.getByTestId("freshrss-migration");
  await expect(card.getByRole("heading", { name: "Move from FreshRSS" })).toBeVisible({ timeout: 30_000 });
  return card;
}

test("FreshRSS export ZIP: dry-run preview lists counts and unsupported items, cancel writes nothing", async ({ page, isMobile }) => {
  const card = await openImportTab(page, isMobile);

  const zip = buildZip([
    { name: "freshrss_alice_2026-11-09_export/feeds_2026-11-09.opml.xml", data: fixture("feeds_2026-11-09.opml.xml") },
    { name: "freshrss_alice_2026-11-09_export/starred_2026-11-09.json", data: fixture("starred_2026-11-09.json") },
    { name: "freshrss_alice_2026-11-09_export/feed_2026-11-09_3_12.json", data: fixture("feed_2026-11-09_3_12.json") },
  ]);
  await card.getByTestId("freshrss-file").setInputFiles({ name: "freshrss_alice_2026-11-09_export.zip", mimeType: "application/zip", buffer: zip });

  await expect(card.getByText("Preview – nothing has been imported yet")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("New subscriptions").locator("xpath=..")).toContainText("11");
  await expect(card.getByText("New articles").locator("xpath=..")).toContainText("5");
  await expect(card.getByRole("region", { name: "Not supported – not imported" })).toContainText("Hacker News");
  await expect(card.getByRole("region", { name: "Imported with changes" })).toBeVisible();
  await expect(card.getByRole("region", { name: "Stored, but inactive" })).toContainText("frss:futureFlag");
  await expect(card.getByRole("region", { name: "Files in the export" })).toContainText("starred_2026-11-09.json");
  await expect(card.getByTestId("freshrss-confirm")).toBeVisible();

  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByTestId("freshrss-confirm")).toBeHidden();
  await expect(card.getByRole("button", { name: "Choose export file" })).toBeVisible();
});

test("FreshRSS migration reports unreadable and hostile uploads instead of importing them", async ({ page, isMobile }) => {
  const card = await openImportTab(page, isMobile);

  await card.getByTestId("freshrss-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello there") });
  await expect(card.getByRole("alert")).toContainText("Unrecognised file", { timeout: 30_000 });

  await card.getByTestId("freshrss-file").setInputFiles({
    name: "evil.zip",
    mimeType: "application/zip",
    buffer: buildZip([{ name: "../../etc/evil.json", data: "{}" }]),
  });
  await expect(card.getByRole("alert")).toContainText("unsafe path", { timeout: 30_000 });
  await expect(card.getByTestId("freshrss-confirm")).toBeHidden();
});

test("FreshRSS OPML with scraping, full-text and unicity attributes previews cleanly (nothing unsupported)", async ({ page, isMobile }) => {
  const card = await openImportTab(page, isMobile);

  await card.getByTestId("freshrss-file").setInputFiles({
    name: "freshrss_feeds_2026-11-11.opml.xml",
    mimeType: "text/xml",
    buffer: fixture("synthetic-export.opml.xml"),
  });

  await expect(card.getByText("Preview – nothing has been imported yet")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("New subscriptions").locator("xpath=..")).toContainText("13");
  // Every frss: attribute of a real export maps to a FeedFerret setting.
  await expect(card.getByRole("region", { name: "Not supported – not imported" })).toHaveCount(0);
  await expect(card.getByRole("region", { name: "Stored, but inactive" })).toHaveCount(0);
  await expect(card.getByTestId("freshrss-confirm")).toBeVisible();

  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByTestId("freshrss-confirm")).toBeHidden();
});

test("OPML export is credential-free by default; credentials only via the explicit, warned opt-in", async ({ page, isMobile }) => {
  await openImportTab(page, isMobile);
  const optIn = page.getByTestId("export-include-credentials");
  await optIn.scrollIntoViewIfNeeded();
  await expect(optIn).not.toBeChecked();
  await expect(page.getByText("Include credentials (FreshRSS-compatible)")).toBeVisible();
  await expect(page.getByText(/Contains cookies, HTTP headers/)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export all feeds" }).click(),
  ]);
  const xml = fs.readFileSync((await download.path())!, "utf8");
  expect(xml).toContain('xmlns:frss="https://freshrss.org/opml"');
  expect(xml).not.toMatch(/frss:CURLOPT_(COOKIE|HTTPHEADER|POSTFIELDS|PROXY)=/);
  expect(xml).not.toMatch(/(xmlUrl|htmlUrl)="https?:\/\/[^"/@]+@/);
});
