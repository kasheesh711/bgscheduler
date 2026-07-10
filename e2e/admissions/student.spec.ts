import { expect, test } from "@playwright/test";

import {
  expectAuthenticatedAdmissionsPage,
  expectNoHorizontalOverflow,
} from "./support/assertions";
import { pilotEnv, pilotSkipReason } from "./support/pilot-env";

const studentSkipReason = pilotSkipReason("student", { requireCaseId: true });

test.describe("admissions student mobile pilot", () => {
  test.skip(
    studentSkipReason !== null,
    studentSkipReason ?? "Pilot student environment unavailable.",
  );

  test.beforeEach(async ({ page }) => {
    await page.goto(`/admissions/${pilotEnv.studentCaseId}`);
    await expectAuthenticatedAdmissionsPage(page);
    await expect(page.getByTestId("student-nav-home")).toBeVisible();
    expect(page.viewportSize()).toEqual({ width: 375, height: 812 });
  });

  test("keeps tasks and essays usable at 375px", async ({ page }) => {
    await page.getByTestId("student-nav-tasks").click();
    await expect(page.locator('section[aria-label="Tasks"]')).toContainText("Tasks");
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("student-nav-essays").click();
    await expect(page.locator('section[aria-label="Essays"]')).toContainText("Essays");
    await expect(page.getByTestId("add-essay")).toBeVisible();
    await expect(page.getByTestId("open-prompt-catalog")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("opens activities, awards, and testing from More without horizontal scroll", async ({ page }) => {
    await page.getByTestId("student-nav-more").click();
    await page.getByTestId("more-menu-activities").click();
    await expect(page.getByTestId("activities-cap")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("student-nav-more").click();
    await page.getByTestId("more-menu-awards").click();
    await expect(page.getByTestId("awards-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add award" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("student-nav-more").click();
    await page.getByTestId("more-menu-testing").click();
    await expect(page.getByTestId("testing-view")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("shows counselor academics and shared feedback in dedicated views", async ({ page }) => {
    await page.getByTestId("student-nav-more").click();
    await page.getByTestId("more-menu-academics").click();
    await expect(page.getByTestId("academics-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add record" })).toHaveCount(0);

    await page.getByTestId("student-nav-more").click();
    await page.getByTestId("more-menu-feedback").click();
    await expect(page.getByTestId("shared-feedback-panel")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("shows application completeness and student-owned college research", async ({ page }) => {
    await page.getByTestId("student-nav-colleges").click();
    await expect(page.locator('section[aria-label="Colleges"]')).toContainText("Colleges & applications");
    await expect(page.getByTestId("college-details-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save application plan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save research" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("routes a configured This Week action directly to its owning sub-view", async ({ page }) => {
    test.skip(
      !pilotEnv.studentActionText || !pilotEnv.studentActionSub,
      "Set ADMISSIONS_E2E_STUDENT_ACTION_TEXT and ADMISSIONS_E2E_STUDENT_ACTION_SUB for a testing or section action on the pilot case.",
    );
    expect(["testing", "sections"]).toContain(pilotEnv.studentActionSub);
    await page
      .getByTestId("this-week-action")
      .filter({ hasText: pilotEnv.studentActionText! })
      .click();
    await expect(page).toHaveURL(new RegExp(`view=more.*sub=${pilotEnv.studentActionSub}`));
    await expect(page.getByTestId("more-back")).toBeVisible();
  });
});
