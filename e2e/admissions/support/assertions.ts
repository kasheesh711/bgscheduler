import { expect, type Page } from "@playwright/test";

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(
    widths.content,
    `page content width ${widths.content}px exceeds viewport ${widths.viewport}px`,
  ).toBeLessThanOrEqual(widths.viewport + 1);
}

export async function expectAuthenticatedAdmissionsPage(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
  await expect(page.locator("body")).not.toContainText("Application error");
}

export async function expectNoParentMutationControls(page: Page): Promise<void> {
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.locator("input, select, textarea")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /add|save|edit|delete|remove|submit|confirm/i })).toHaveCount(0);
}

