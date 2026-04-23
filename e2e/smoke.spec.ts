import { test, expect } from "@playwright/test";

test("home screen renders with Open repository button", async ({ page }) => {
  await page.goto("/");

  // The Home route renders an "Open repository" CTA when no workspace is
  // open. If the bootstrap worked (Tauri IPC stub installed, `list_recent`
  // returns null, Home doesn't crash), the button is visible.
  await expect(page.getByRole("button", { name: /open repository/i })).toBeVisible();
});
