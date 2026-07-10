import { expect, test } from "@playwright/test";

import {
  expectAuthenticatedAdmissionsPage,
  expectNoHorizontalOverflow,
} from "./support/assertions";
import { pilotEnv, pilotSkipReason } from "./support/pilot-env";

const counselorSkipReason = pilotSkipReason("counselor", { requireCaseId: true });

test.describe("admissions counselor pilot", () => {
  test.skip(
    counselorSkipReason !== null,
    counselorSkipReason ?? "Pilot counselor environment unavailable.",
  );

  test.beforeEach(async ({ page }) => {
    await page.goto("/admissions");
    await expectAuthenticatedAdmissionsPage(page);
  });

  test("opens a caseload row into the five-area case workspace", async ({ page }) => {
    const caseId = pilotEnv.counselorCaseId!;
    await expect(page.getByRole("heading", { name: "Admissions caseload" })).toBeVisible();

    const caseLink = page.locator(`a[href="/admissions/${caseId}"]`).first();
    await expect(caseLink).toBeVisible();
    await caseLink.click();

    await expect(page).toHaveURL(new RegExp(`/admissions/${caseId}(?:\\?|$)`));
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Student", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Colleges & Applications", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Money", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Casework", exact: true })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(5);
    await expectNoHorizontalOverflow(page);
  });

  test("exercises member management and lifecycle confirmations without mutating", async ({ page }) => {
    const caseId = pilotEnv.counselorCaseId!;
    await page.goto(`/admissions/${caseId}?tab=casework`);

    await expect(page.getByTestId("casework-panel")).toBeVisible();
    await expect(page.getByTestId("case-lifecycle-card")).toBeVisible();
    const people = page.getByTestId("people-access-card");
    await expect(people).toBeVisible();
    await expect(people.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(people.getByLabel("Role", { exact: true })).toHaveValue("parent");
    await expect(people.getByRole("button", { name: "Add person" })).toBeVisible();
    await expect(page.getByTestId("member-list")).toBeVisible();

    const changeEmail = people.getByRole("button", { name: "Change email" }).first();
    await expect(changeEmail).toBeVisible();
    await changeEmail.click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Change member email" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    const lifecycleAction = page
      .getByTestId("case-lifecycle-card")
      .getByRole("button", { name: /Mark withdrawn|Mark completed|Archive case/ })
      .first();
    await expect(
      lifecycleAction,
      "the dedicated pilot case must have one valid explicit lifecycle action",
    ).toBeVisible();
    await lifecycleAction.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  });

  test("shows the import wizard and never writes before confirmation", async ({ page }) => {
    const caseId = pilotEnv.counselorCaseId!;
    await page.goto(`/admissions/${caseId}?tab=casework`);
    const wizard = page.getByTestId("workbook-import-wizard");
    await expect(wizard).toBeVisible();
    await expect(wizard).toContainText("there is no ongoing synchronization");
    await expect(wizard.getByRole("button", { name: "Preview" })).toBeDisabled();
    await expect(wizard.getByRole("button", { name: "Connect Sheets" })).toBeVisible();
  });

  test("previews a configured legacy workbook without committing it", async ({ page }) => {
    test.skip(
      !pilotEnv.importSpreadsheetUrl,
      "Set ADMISSIONS_E2E_IMPORT_SPREADSHEET_URL and authorize Sheets on the counselor pilot account.",
    );
    const caseId = pilotEnv.counselorCaseId!;
    await page.goto(`/admissions/${caseId}?tab=casework`);
    const wizard = page.getByTestId("workbook-import-wizard");
    await wizard.getByLabel("Copied Google Sheets workbook URL").fill(pilotEnv.importSpreadsheetUrl!);
    await wizard.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(wizard.getByTestId("workbook-import-preview")).toBeVisible({ timeout: 30_000 });
    await expect(wizard).toContainText("no changes have been written");
    await expect(wizard.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  });
});
