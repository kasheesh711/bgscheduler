import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../drizzle/0055_post_class_feedback.sql", import.meta.url),
  "utf8",
);
const payoutMigration = readFileSync(
  new URL("../../../../drizzle/0057_post_class_payout_runs.sql", import.meta.url),
  "utf8",
);
const restoreMigration = readFileSync(
  new URL("../../../../drizzle/0058_post_class_source_status_restore.sql", import.meta.url),
  "utf8",
);
const masterMigration = readFileSync(
  new URL("../../../../drizzle/0059_post_class_payout_master.sql", import.meta.url),
  "utf8",
);
const durablePayoutMigration = readFileSync(
  new URL("../../../../drizzle/0060_post_class_payout_durable_runs.sql", import.meta.url),
  "utf8",
);
const sourceAnchorMigration = readFileSync(
  new URL("../../../../drizzle/0061_payout_line_source_anchor.sql", import.meta.url),
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

describe("payout run migration", () => {
  it("creates the run, mapping, and line stores", () => {
    for (const table of [
      "post_class_payout_runs",
      "post_class_tutor_payout_sheets",
      "post_class_payout_run_lines",
    ]) {
      expect(payoutMigration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  it("declares the run, match, and write status enums", () => {
    expect(payoutMigration).toContain(
      `CREATE TYPE "public"."post_class_payout_run_status" AS ENUM('draft', 'published')`,
    );
    expect(payoutMigration).toContain(
      `CREATE TYPE "public"."post_class_payout_match_status" AS ENUM('pending', 'matched', 'unmatched', 'ambiguous', 'no_sheet')`,
    );
    expect(payoutMigration).toContain(
      `CREATE TYPE "public"."post_class_payout_write_status" AS ENUM('pending', 'written', 'failed', 'skipped')`,
    );
  });

  it("makes a run's window, tutor mapping, and per-deduction line unique", () => {
    // One run per window, one active sheet per tutor, one line per deduction —
    // these are what make re-pressing Publish safe.
    expect(payoutMigration).toMatch(/CREATE UNIQUE INDEX[^;]*"post_class_payout_runs"/);
    expect(payoutMigration).toMatch(/CREATE UNIQUE INDEX[^;]*"post_class_tutor_payout_sheets"/);
    expect(payoutMigration).toMatch(/CREATE UNIQUE INDEX[^;]*"post_class_payout_run_lines"/);
  });

  it("keeps every identifier within PostgreSQL's limit", () => {
    const identifiers = [...payoutMigration.matchAll(/(?:CONSTRAINT|INDEX) "([^"]+)"/g)]
      .map((match) => match[1]);
    expect(identifiers.length).toBeGreaterThan(0);
    for (const identifier of identifiers) {
      expect(identifier.length, identifier).toBeLessThanOrEqual(63);
    }
  });

  it("is registered in the journal", () => {
    expect(journal.entries.find((entry) => entry.idx === 57)).toMatchObject({
      idx: 57,
      tag: "0057_post_class_payout_runs",
    });
  });
});

describe("source status restore migration", () => {
  it("adds the nullable remembered status without touching source_status itself", () => {
    expect(restoreMigration).toContain(
      'ADD COLUMN IF NOT EXISTS "source_status_before" "post_class_source_status"',
    );
    // The demotion must stay fail-closed: this migration only adds the memory
    // that makes recovery possible, it never relaxes a status or backfills one.
    expect(restoreMigration).not.toMatch(/UPDATE "post_class_sessions"/);
    expect(restoreMigration).not.toMatch(/ALTER COLUMN "source_status"/);
    expect(restoreMigration).not.toMatch(/DROP COLUMN/);
  });

  it("indexes only the rows awaiting restore", () => {
    expect(restoreMigration).toMatch(
      /CREATE INDEX IF NOT EXISTS "pc_sessions_source_restore_idx"[\s\S]*WHERE "source_status_before" IS NOT NULL/,
    );
  });

  it("is registered in the journal", () => {
    expect(journal.entries.find((entry) => entry.idx === 58)).toMatchObject({
      idx: 58,
      tag: "0058_post_class_source_status_restore",
    });
  });
});

describe("payout master ledger migration", () => {
  it("stores the two exact ledger identity strings per tutor", () => {
    expect(masterMigration).toContain('CREATE TABLE IF NOT EXISTS "post_class_payout_tutor_names"');
    expect(masterMigration).toContain('"onsite_name" text NOT NULL');
    expect(masterMigration).toContain('"online_name" text');
    // One tutor per key, and one tutor per ledger name — a name claimed twice
    // would send one tutor's deduction into another's view.
    expect(masterMigration).toMatch(/CREATE UNIQUE INDEX[^;]*"canonical_key"/);
    expect(masterMigration).toMatch(/CREATE UNIQUE INDEX[^;]*"onsite_name"/);
  });

  it("adds the reconcile bookkeeping a re-appended row needs", () => {
    for (const column of ["marker_miss_count", "last_seen_in_master_at", "reappend_count", "master_row_number"]) {
      expect(masterMigration).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    // Counters must start at zero, or the first reconcile pass could read a
    // null as a miss and re-append a deduction that is already present.
    expect(masterMigration).toContain('"marker_miss_count" integer DEFAULT 0 NOT NULL');
    expect(masterMigration).toContain('"reappend_count" integer DEFAULT 0 NOT NULL');
  });

  it("touches no existing data", () => {
    expect(masterMigration).not.toMatch(/\bUPDATE\b/);
    expect(masterMigration).not.toMatch(/\bDELETE\b/);
    expect(masterMigration).not.toMatch(/DROP (TABLE|COLUMN)/);
  });

  it("is registered in the journal", () => {
    expect(journal.entries.find((entry) => entry.idx === 59)).toMatchObject({
      idx: 59,
      tag: "0059_post_class_payout_master",
    });
  });
});

describe("durable payout publishing migration", () => {
  it("adds lifecycle leases, signed source identities, and durable audit stores", () => {
    for (const status of ["publishing", "partial", "closed"]) {
      expect(durablePayoutMigration).toContain(`ADD VALUE IF NOT EXISTS '${status}'`);
    }
    for (const column of [
      "lease_token",
      "lease_expires_at",
      "source_identity",
      "row_signature",
      "pass_token",
      "scheduled_end_at",
      "finance_month",
    ]) {
      expect(durablePayoutMigration).toContain(`"${column}"`);
    }
    for (const table of [
      "post_class_payout_adjustments",
      "post_class_payout_exceptions",
      "post_class_payout_roll_runs",
      "post_class_payout_roll_outcomes",
    ]) {
      expect(durablePayoutMigration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  it("drops every reconciliation-only column", () => {
    for (const column of [
      "marker_miss_count",
      "last_seen_in_master_at",
      "reappend_count",
      "master_row_number",
    ]) {
      expect(durablePayoutMigration).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });

  it("blocks rollout while any mutable-tab legacy write still needs an audited bootstrap", () => {
    expect(durablePayoutMigration).toMatch(
      /FROM "post_class_payout_run_lines"[\s\S]+WHERE "write_status" <> 'skipped'/u,
    );
    expect(durablePayoutMigration).toContain(
      "0060 requires an audited legacy payout bootstrap before migration",
    );
  });

  it("blocks duplicate legacy deduction rows before introducing global identities", () => {
    const duplicateGuard = durablePayoutMigration.indexOf(
      'GROUP BY "deduction_id"',
    );
    const firstMutation = durablePayoutMigration.indexOf(
      'ALTER TYPE "public"."post_class_payout_run_status"',
    );
    expect(duplicateGuard).toBeGreaterThanOrEqual(0);
    expect(duplicateGuard).toBeLessThan(firstMutation);
    expect(durablePayoutMigration).toContain(
      "the same deduction exists in multiple payout runs",
    );
  });

  it("constrains payout line kinds to durable deduction rows", () => {
    expect(durablePayoutMigration).toContain(
      'CONSTRAINT "pc_payout_run_lines_kind_check"',
    );
    expect(durablePayoutMigration).toContain(
      'CHECK ("line_kind" = \'deduction\')',
    );
  });

  it("preserves legacy row evidence before dropping its old column", () => {
    const copyEvidence = durablePayoutMigration.indexOf(
      'SET "inserted_row_number" = COALESCE("inserted_row_number", "master_row_number")',
    );
    const dropEvidence = durablePayoutMigration.indexOf(
      'DROP COLUMN IF EXISTS "master_row_number"',
    );
    expect(copyEvidence).toBeGreaterThan(-1);
    expect(dropEvidence).toBeGreaterThan(copyEvidence);
  });

  it("allows only the audited processed-to-reversed deduction transition", () => {
    expect(durablePayoutMigration).toContain(
      'CREATE OR REPLACE FUNCTION "post_class_protect_processed_deduction"()',
    );
    expect(durablePayoutMigration).toContain('OLD."status" = \'processed\'');
    expect(durablePayoutMigration).toContain('NEW."status" = \'reversed\'');
    expect(durablePayoutMigration).toContain(
      'NEW."version" = OLD."version" + 1',
    );
    expect(durablePayoutMigration).toContain(
      "to_jsonb(NEW) - 'status' - 'version' - 'updated_at'",
    );
  });

  it("replaces the old run-scoped line identity with global source and signature identities", () => {
    expect(durablePayoutMigration).toContain(
      'DROP INDEX IF EXISTS "pc_payout_run_lines_run_deduction_idx"',
    );
    expect(durablePayoutMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_run_lines_source_identity_idx"',
    );
    expect(durablePayoutMigration).toMatch(
      /GROUP BY "row_signature"\s+HAVING count\(\*\) > 1/u,
    );
    expect(durablePayoutMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_run_lines_row_signature_idx"',
    );
  });

  it("permits exactly one workbook date roll per closed payout run", () => {
    expect(durablePayoutMigration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "pc_payout_roll_runs_source_idx"\s+ON "post_class_payout_roll_runs" \("payout_run_id"\)/u,
    );
    expect(durablePayoutMigration).not.toContain(
      "pc_payout_roll_runs_source_target_idx",
    );
  });

  it("enforces ledger-name uniqueness across primary and alternate columns", () => {
    expect(durablePayoutMigration).toContain(
      'CREATE OR REPLACE FUNCTION "pc_enforce_payout_ledger_name_uniqueness"()',
    );
    expect(durablePayoutMigration).toContain("pg_advisory_xact_lock");
    expect(durablePayoutMigration).toContain(
      'CREATE TRIGGER "pc_payout_ledger_name_uniqueness"',
    );
  });

  it("is registered in the journal", () => {
    expect(journal.entries.find((entry) => entry.idx === 60)).toMatchObject({
      idx: 60,
      tag: "0060_post_class_payout_durable_runs",
    });
  });
});

describe("payout line source anchor migration", () => {
  it("adds only the nullable durable fingerprint column", () => {
    expect(sourceAnchorMigration).toContain("source_anchor_fingerprint");
    expect(sourceAnchorMigration).toContain(
      'ALTER TABLE "post_class_payout_run_lines" ADD COLUMN "source_anchor_fingerprint" text;',
    );
  });

  it("touches no existing data", () => {
    expect(sourceAnchorMigration).not.toMatch(/\bUPDATE\b/);
    expect(sourceAnchorMigration).not.toMatch(/\bDELETE\b/);
    expect(sourceAnchorMigration).not.toMatch(/DROP (TABLE|COLUMN)/);
  });

  it("is registered in the journal", () => {
    expect(journal.entries.find((entry) => entry.idx === 61)).toMatchObject({
      idx: 61,
      tag: "0061_payout_line_source_anchor",
    });
  });
});
