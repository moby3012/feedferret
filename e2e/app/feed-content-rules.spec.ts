import { test, expect } from "../helpers/test";

test("content rules preview, reject invalid JSON and persist ordered configuration", async ({ app, page }) => {
  await app.open();
  await page.goto("/manage-feeds");
  const row = page.getByText(`http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}/feeds/solo-blog.xml`).locator("xpath=ancestor::*[.//button[normalize-space()='Settings']][1]");
  await app.activate(row.getByRole("button", { name: "Settings" }));
  const dialog = page.getByRole("dialog");
  await app.activate(dialog.getByRole("tab", { name: "Scout Studio" }));
  const editor = dialog.getByLabel("Clean content", { exact: true });
  await editor.fill("invalid");
  await expect(dialog.locator("pre")).toContainText("Invalid/unsafe rules");
  const config = JSON.stringify({ transforms: [{ type: "replace_regex", pattern: "[A-Za-z]", replacement: "Z", flags: "g" }], gates: [{ type: "title_exclude", pattern: ".*" }] });
  await editor.fill(config);
  await expect(dialog.locator("pre")).toContainText("Held back");
  await app.activate(dialog.getByRole("button", { name: "Save settings" }));
  await expect(dialog).toBeHidden();
  await app.activate(row.getByRole("button", { name: "Settings" }));
  await app.activate(dialog.getByRole("tab", { name: "Scout Studio" }));
  await expect(editor).toHaveValue(config);
  // Restore the shared seeded feed.
  await editor.fill("");
  await app.activate(dialog.getByRole("button", { name: "Save settings" }));
});
