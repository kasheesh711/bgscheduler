import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("0053 admissions parity migration", () => {
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/0053_nosy_spectrum.sql"),
    "utf8",
  );

  it("creates the parity tables and transactional notification outbox", () => {
    for (const table of [
      "admissions_awards",
      "admissions_college_research",
      "admissions_interest_events",
      "admissions_college_requirements",
      "admissions_financial_aid_offers",
      "admissions_scholarships",
      "admissions_essay_prompt_catalog",
      "admissions_import_runs",
      "admissions_import_issues",
      "admissions_import_mappings",
      "admissions_notification_outbox",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migration).toContain("admissions_notification_outbox_dedupe_key_idx");
    expect(migration).toContain("admissions_notification_outbox_delivery_idx");
    expect(migration).toContain('"provider_message_id" text');
  });

  it("extends cases, family sharing, college details, and typed testing", () => {
    for (const column of [
      "family_portal_open",
      "family_portal_opened_at",
      "family_portal_opened_by_email",
      "shared_with_family",
      "first_choice_major",
      "second_choice_major",
      "admissions_url",
      "portal_url",
      "late_registration_deadline",
      "score_details",
      "deleted_at",
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toContain("admissions_test_sitting_status");
    expect(migration).toContain("admissions_awards_uc_eligibility_length_check");
    expect(migration).toContain("admissions_academic_records_case_system_date_idx");
  });
});

describe("0054 admissions test-status backfill", () => {
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/0054_admissions_test_status_backfill.sql"),
    "utf8",
  );

  it("classifies scored rows before past unscored rows and leaves future planned rows alone", () => {
    const scoreReceived = migration.indexOf('SET\n  "status" = \'score_received\'');
    const taken = migration.indexOf('SET\n  "status" = \'taken\'');
    expect(scoreReceived).toBeGreaterThan(-1);
    expect(taken).toBeGreaterThan(scoreReceived);
    expect(migration).toContain('NULLIF(BTRIM("actual_score"), \'\') IS NOT NULL');
    expect(migration).toContain('"score_details" IS NOT NULL');
    expect(migration).toContain('AND "status" = \'planned\'');
    expect(migration).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok'");
  });
});
