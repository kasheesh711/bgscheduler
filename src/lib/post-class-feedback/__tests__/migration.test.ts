import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../drizzle/0055_post_class_feedback.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../../../../drizzle/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

describe("post-class feedback migration", () => {
  it("creates the durable source, operations, AI, access, and finance stores", () => {
    const requiredTables = [
      "post_class_settings",
      "post_class_enforcement_windows",
      "post_class_field_mappings",
      "post_class_access_grants",
      "post_class_config_audit_log",
      "post_class_digest_recipients",
      "post_class_sync_runs",
      "post_class_sessions",
      "post_class_session_participants",
      "post_class_feedback_versions",
      "post_class_feedback_event_links",
      "post_class_assessments",
      "post_class_source_issues",
      "post_class_notification_runs",
      "post_class_notification_deliveries",
      "post_class_notification_items",
      "post_class_notification_attempts",
      "post_class_ai_runs",
      "post_class_ai_concerns",
      "post_class_ai_reviews",
      "post_class_finance_periods",
      "post_class_deductions",
      "post_class_deduction_actions",
      "post_class_deduction_offsets",
    ];

    for (const table of requiredTables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("adds a feature-owned tutor primary email without replacing Wise emails", () => {
    expect(migration).toContain(
      'ALTER TABLE "tutor_contacts" ADD COLUMN "primary_email" text;',
    );
    expect(migration).not.toContain('DROP COLUMN "onsite_email"');
    expect(migration).not.toContain('DROP COLUMN "online_email"');
  });

  it("seeds shadow settings, live form mappings, all-admin viewing, and Kevin setup access", () => {
    expect(migration).toContain("'Initial shadow-mode rollout'");
    expect(migration).toContain("'Topics covered'");
    expect(migration).toContain("'How the student did in class'");
    expect(migration).toContain("'Need more work on'");
    expect(migration).toContain("'Homework and due date'");
    expect(migration).toMatch(
      /SELECT lower\(btrim\("email"\)\), 'viewer', 'system:migration'[\s\S]+FROM "admin_users"/,
    );
    for (const capability of ["viewer", "reviewer", "finance", "access_manager"]) {
      expect(migration).toContain(`('kevhsh7@gmail.com', '${capability}', 'system:migration')`);
    }
    expect(migration).toContain(
      "VALUES ('kevhsh7@gmail.com', true, 'system:migration')",
    );
  });

  it("has no duplicate column declarations within any new table", () => {
    const tables = migration.matchAll(
      /CREATE TABLE "(post_class_[^"]+)" \(([\s\S]*?)\n\);/g,
    );

    for (const [, tableName, body] of tables) {
      const declarations = body.split(/\n\s+CONSTRAINT /, 1)[0];
      const columnNames = [...declarations.matchAll(/^\s+"([^"]+)"\s+/gm)]
        .map((match) => match[1]);
      expect(new Set(columnNames).size, tableName).toBe(columnNames.length);
    }
  });

  it("keeps all explicit constraint and index names within PostgreSQL's identifier limit", () => {
    const identifiers = [...migration.matchAll(/(?:CONSTRAINT|INDEX) "([^"]+)"/g)]
      .map((match) => match[1]);
    expect(identifiers.length).toBeGreaterThan(0);
    for (const identifier of identifiers) {
      expect(identifier.length, identifier).toBeLessThanOrEqual(63);
    }
  });

  it("does not write feedback to Wise or connect deductions to Payroll", () => {
    expect(migration).not.toMatch(/INSERT INTO "wise_/);
    expect(migration).not.toMatch(/REFERENCES "public"\."payroll_/);
  });

  it("makes evidence and decision history append-only", () => {
    for (const trigger of [
      "pc_feedback_versions_immutable",
      "pc_assessments_immutable",
      "pc_config_audit_immutable",
      "pc_ai_reviews_immutable",
      "pc_deduction_actions_immutable",
      "pc_deduction_offsets_immutable",
    ]) {
      expect(migration).toContain(`CREATE TRIGGER "${trigger}"`);
    }
    expect(migration).toContain('CREATE TRIGGER "pc_processed_deduction_immutable"');
  });

  it("is registered after the concurrent Student Promotions migrations", () => {
    expect(journal.entries.find((entry) => entry.idx === 55)).toMatchObject({
      idx: 55,
      tag: "0055_post_class_feedback",
    });
  });
});
