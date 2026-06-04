import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("cron invocations migration", () => {
  it("creates the audit table and dashboard indexes", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "drizzle/0038_data_health_cron_invocations.sql"),
      "utf8",
    );

    expect(sql).toContain('CREATE TABLE "cron_invocations"');
    expect(sql).toContain('"job_key" text NOT NULL');
    expect(sql).toContain('"trigger_source" text DEFAULT');
    expect(sql).toContain("cron_invocations_job_received_idx");
    expect(sql).toContain("cron_invocations_outcome_received_idx");
    expect(sql).toContain("cron_invocations_trigger_received_idx");
  });
});
