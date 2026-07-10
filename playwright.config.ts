import { existsSync } from "node:fs";

import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

const baseURL = process.env.ADMISSIONS_E2E_BASE_URL ?? "http://127.0.0.1:3000";

function existingStorageState(envName: string): string | undefined {
  const value = process.env[envName]?.trim();
  return value && existsSync(value) ? value : undefined;
}

function roleProject(
  name: string,
  testFile: string,
  storageEnv: string,
  use: NonNullable<PlaywrightTestConfig["use"]> = {},
) {
  return {
    name,
    testMatch: testFile,
    use: {
      ...devices["Desktop Chrome"],
      ...use,
      storageState: existingStorageState(storageEnv),
    },
  };
}

export default defineConfig({
  testDir: "./e2e/admissions",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  outputDir: "test-results/admissions-playwright",
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "playwright-report/admissions" }],
  ],
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    roleProject(
      "admissions-counselor",
      "counselor.spec.ts",
      "ADMISSIONS_E2E_COUNSELOR_STORAGE_STATE",
    ),
    roleProject(
      "admissions-student-mobile",
      "student.spec.ts",
      "ADMISSIONS_E2E_STUDENT_STORAGE_STATE",
      {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    ),
    roleProject(
      "admissions-parent",
      "parent.spec.ts",
      "ADMISSIONS_E2E_PARENT_STORAGE_STATE",
    ),
    roleProject(
      "admissions-admin",
      "admin.spec.ts",
      "ADMISSIONS_E2E_ADMIN_STORAGE_STATE",
    ),
  ],
});

