import { expect, test } from "@playwright/test";

import { expectAuthenticatedAdmissionsPage } from "./support/assertions";
import { pilotSkipReason } from "./support/pilot-env";

const adminSkipReason = pilotSkipReason("admin");

test.describe("admissions admin pilot", () => {
  test.skip(
    adminSkipReason !== null,
    adminSkipReason ?? "Pilot admin environment unavailable.",
  );

  test.beforeEach(async ({ page }) => {
    await page.goto("/admissions");
    await expectAuthenticatedAdmissionsPage(page);
  });

  test("opens counselor, cohort, and template management", async ({ page }) => {
    await page.getByTestId("open-manage").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Manage admissions" })).toBeVisible();

    await dialog.getByTestId("manage-tab-counselors").click();
    await expect(dialog.getByTestId("counselors-manager")).toBeVisible();
    await expect(dialog.getByTestId("counselor-add-form")).toBeVisible();

    await dialog.getByTestId("manage-tab-cohorts").click();
    await expect(dialog.getByTestId("cohorts-manager")).toBeVisible();
    await expect(dialog.getByTestId("cohort-add-form")).toBeVisible();

    await dialog.getByTestId("manage-tab-templates").click();
    await expect(dialog.getByTestId("template-editor")).toBeVisible();
    await expect(dialog.getByTestId("template-cohort-select")).toBeVisible();
  });
});
