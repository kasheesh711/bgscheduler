import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Modules whose recipients are staff only: they ride Resend in wave one. */
const STAFF_MODULES = [
  "src/lib/internal/cron-watchdog.ts",
  "src/lib/feedback-autowriter/alerts.ts",
  "src/lib/feedback-autowriter/incidents.ts",
  "src/lib/classrooms/weekend-check.ts",
  "src/lib/classrooms/admin-schedule-email.ts",
  "src/lib/progress-tests/admin-digest.ts",
  "src/lib/leave-requests/sync.ts",
  "src/lib/auth/email-code.ts",
];

describe("staff email modules", () => {
  it.each(STAFF_MODULES)("%s tags every outbound sender as staff", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const calls = source.match(/createOutboundEmailSender\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('audience: "staff"');
  });
});
