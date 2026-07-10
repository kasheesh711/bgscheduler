import { existsSync } from "node:fs";

export type AdmissionsE2ERole = "counselor" | "student" | "parent" | "admin";

const storageEnvByRole: Record<AdmissionsE2ERole, string> = {
  counselor: "ADMISSIONS_E2E_COUNSELOR_STORAGE_STATE",
  student: "ADMISSIONS_E2E_STUDENT_STORAGE_STATE",
  parent: "ADMISSIONS_E2E_PARENT_STORAGE_STATE",
  admin: "ADMISSIONS_E2E_ADMIN_STORAGE_STATE",
};

function read(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const pilotEnv = Object.freeze({
  baseURL: read("ADMISSIONS_E2E_BASE_URL"),
  counselorCaseId: read("ADMISSIONS_E2E_COUNSELOR_CASE_ID"),
  studentCaseId: read("ADMISSIONS_E2E_STUDENT_CASE_ID"),
  parentCaseId: read("ADMISSIONS_E2E_PARENT_CASE_ID"),
  parentSecondCaseId: read("ADMISSIONS_E2E_PARENT_SECOND_CASE_ID"),
  importSpreadsheetUrl: read("ADMISSIONS_E2E_IMPORT_SPREADSHEET_URL"),
  studentActionText: read("ADMISSIONS_E2E_STUDENT_ACTION_TEXT"),
  studentActionSub: read("ADMISSIONS_E2E_STUDENT_ACTION_SUB"),
});

export function roleStorageState(role: AdmissionsE2ERole): string | undefined {
  return read(storageEnvByRole[role]);
}

export function pilotSkipReason(
  role: AdmissionsE2ERole,
  options: { requireCaseId?: boolean } = {},
): string | null {
  if (!pilotEnv.baseURL) {
    return "Set ADMISSIONS_E2E_BASE_URL to the pilot deployment.";
  }
  const storageState = roleStorageState(role);
  if (!storageState) {
    return `Set ${storageEnvByRole[role]} to a pre-authenticated Playwright storage-state file.`;
  }
  if (!existsSync(storageState)) {
    return `${storageEnvByRole[role]} does not point to an existing file.`;
  }
  if (options.requireCaseId) {
    const caseId = role === "counselor"
      ? pilotEnv.counselorCaseId
      : role === "student"
        ? pilotEnv.studentCaseId
        : role === "parent"
          ? pilotEnv.parentCaseId
          : undefined;
    if (!caseId) {
      return `Set ADMISSIONS_E2E_${role.toUpperCase()}_CASE_ID to a dedicated pilot case.`;
    }
  }
  return null;
}

