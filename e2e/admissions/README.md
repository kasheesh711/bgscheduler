# Admissions pilot browser tests

This suite exercises the deployed admissions pilot as counselor, student,
parent, and admin users. It uses real Google/Auth.js sessions captured as
Playwright storage-state files. It does not provide an authentication bypass,
seed credentials, or commit session cookies.

## One-time setup

Install the Chromium runtime after installing project dependencies:

```bash
npx playwright install chromium
```

Choose an existing pilot deployment and capture one session per role. Keep the
JSON files outside the repository because they contain live session cookies:

```bash
export ADMISSIONS_E2E_BASE_URL="https://your-pilot.example.com"

npx playwright codegen \
  --save-storage="$HOME/.config/bgscheduler-e2e/counselor.json" \
  "$ADMISSIONS_E2E_BASE_URL/login?callbackUrl=/admissions"
```

Complete Google sign-in in the opened browser, verify `/admissions` has loaded,
then close it. Repeat for student, parent, and admin accounts using separate
storage files. Never place account passwords or storage-state JSON in this
repository.

## Required environment

```bash
export ADMISSIONS_E2E_BASE_URL="https://your-pilot.example.com"
export ADMISSIONS_E2E_COUNSELOR_STORAGE_STATE="$HOME/.config/bgscheduler-e2e/counselor.json"
export ADMISSIONS_E2E_STUDENT_STORAGE_STATE="$HOME/.config/bgscheduler-e2e/student.json"
export ADMISSIONS_E2E_PARENT_STORAGE_STATE="$HOME/.config/bgscheduler-e2e/parent.json"
export ADMISSIONS_E2E_ADMIN_STORAGE_STATE="$HOME/.config/bgscheduler-e2e/admin.json"

export ADMISSIONS_E2E_COUNSELOR_CASE_ID="00000000-0000-4000-8000-000000000001"
export ADMISSIONS_E2E_STUDENT_CASE_ID="00000000-0000-4000-8000-000000000002"
export ADMISSIONS_E2E_PARENT_CASE_ID="00000000-0000-4000-8000-000000000003"
```

Use dedicated pilot cases with family portals open for student/parent roles.
The counselor case must contain at least one member, one college, and one valid
explicit lifecycle action. The student case must contain at least one college
so application completeness and research controls can be exercised.

Optional scenarios:

```bash
# Parent account linked to two open pilot cases.
export ADMISSIONS_E2E_PARENT_SECOND_CASE_ID="00000000-0000-4000-8000-000000000004"

# Read-only import preview. The counselor account must already have explicitly
# connected Google Sheets; the suite never confirms the import.
export ADMISSIONS_E2E_IMPORT_SPREADSHEET_URL="https://docs.google.com/spreadsheets/d/.../edit"

# A visible This Week testing or section action on the student case.
export ADMISSIONS_E2E_STUDENT_ACTION_TEXT="SAT registration closes"
export ADMISSIONS_E2E_STUDENT_ACTION_SUB="testing" # testing or sections
```

Missing role configuration produces a clear Playwright skip instead of an auth
fallback. Missing optional values skip only their corresponding scenario.

## Commands

Validate discovery without opening a browser:

```bash
npm run test:e2e:admissions:list
```

Run the pilot suite:

```bash
npm run test:e2e:admissions
```

Artifacts on failure are written to ignored `test-results/` and
`playwright-report/` directories. The suite runs with one worker because the
projects intentionally share pilot records.

