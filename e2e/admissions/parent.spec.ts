import { expect, test } from "@playwright/test";

import {
  expectAuthenticatedAdmissionsPage,
  expectNoHorizontalOverflow,
  expectNoParentMutationControls,
} from "./support/assertions";
import { pilotEnv, pilotSkipReason } from "./support/pilot-env";

const parentSkipReason = pilotSkipReason("parent", { requireCaseId: true });

test.describe("admissions parent pilot", () => {
  test.skip(
    parentSkipReason !== null,
    parentSkipReason ?? "Pilot parent environment unavailable.",
  );

  test.beforeEach(async ({ page }) => {
    await page.goto(`/admissions/${pilotEnv.parentCaseId}`);
    await expectAuthenticatedAdmissionsPage(page);
    await expect(page.getByTestId("parent-dashboard")).toBeVisible();
  });

  test("renders the complete family-approved record read-only", async ({ page }) => {
    for (const testId of [
      "parent-profile",
      "parent-academics",
      "parent-checklist",
      "parent-deadlines",
      "parent-colleges",
      "parent-recommenders",
      "parent-essays",
      "parent-activities",
      "parent-awards",
      "parent-testing",
      "parent-money",
      "parent-announcements",
      "parent-notes",
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    await expectNoParentMutationControls(page);
    await expectNoHorizontalOverflow(page);
  });

  test("switches between Thai and English and exposes sign-out", async ({ page }) => {
    await page.getByTestId("parent-locale-en").click();
    await expect(page.getByTestId("parent-locale-en")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("bgscheduler.admissions.parent-locale"))).toBe("en");

    await page.getByTestId("parent-locale-th").click();
    await expect(page.getByTestId("parent-locale-th")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("parent-sign-out")).toHaveAttribute("href", "/api/auth/signout");
  });

  test("opens the authenticated sign-out flow", async ({ page }) => {
    await page.getByTestId("parent-sign-out").click();
    await expect(page).toHaveURL(/\/api\/auth\/signout(?:\?|$)/);
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  });

  test("switches to a second linked child", async ({ page }) => {
    test.skip(
      !pilotEnv.parentSecondCaseId,
      "Set ADMISSIONS_E2E_PARENT_SECOND_CASE_ID for a parent linked to two pilot cases.",
    );
    const switcher = page.getByTestId("parent-child-switcher");
    await expect(switcher).toBeVisible();
    const sibling = switcher.locator(`a[href="/admissions/${pilotEnv.parentSecondCaseId}"]`);
    await expect(sibling).toBeVisible();
    await sibling.click();
    await expect(page).toHaveURL(new RegExp(`/admissions/${pilotEnv.parentSecondCaseId}(?:\\?|$)`));
    await expect(page.getByTestId("parent-dashboard")).toBeVisible();
    await expectNoParentMutationControls(page);
  });
});
