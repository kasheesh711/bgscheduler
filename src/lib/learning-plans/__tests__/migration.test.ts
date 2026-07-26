import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../drizzle/0056_learning_plan_access_grants.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../../../../drizzle/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };
const snapshot54 = JSON.parse(readFileSync(
  new URL("../../../../drizzle/meta/0054_snapshot.json", import.meta.url),
  "utf8",
)) as MigrationSnapshot;
const snapshot55 = JSON.parse(readFileSync(
  new URL("../../../../drizzle/meta/0055_snapshot.json", import.meta.url),
  "utf8",
)) as MigrationSnapshot;
const snapshot56 = JSON.parse(readFileSync(
  new URL("../../../../drizzle/meta/0056_snapshot.json", import.meta.url),
  "utf8",
)) as MigrationSnapshot;

interface MigrationSnapshot {
  id: string;
  prevId: string;
  tables: Record<string, {
    columns: Record<string, unknown>;
    foreignKeys: Record<string, unknown>;
  }>;
}

describe("learning-plan access-grants migration", () => {
  it("creates a normalized-email primary-key grant store", () => {
    expect(migration).toContain('CREATE TABLE "learning_plan_access_grants"');
    expect(migration).toContain('"email" text PRIMARY KEY NOT NULL');
    expect(migration).toContain('"granted_by_email" text NOT NULL');
    expect(migration).toContain(
      '"created_at" timestamp with time zone DEFAULT now() NOT NULL',
    );
    expect(migration).toContain(
      'CONSTRAINT "learning_plan_access_email_normalized_check"',
    );
    expect(migration).toMatch(
      /"email" = lower\(btrim\([^)]*"email"\)\) AND [^\n]*"email" <> ''/,
    );
    expect(migration).toContain(
      'CONSTRAINT "learning_plan_access_granted_by_nonblank_check"',
    );
    expect(migration).toMatch(/btrim\([^)]*"granted_by_email"\) <> ''/);
  });

  it("does not couple feature grants to the admin allowlist", () => {
    expect(migration).not.toContain("REFERENCES");
    expect(
      snapshot56.tables["public.learning_plan_access_grants"].foreignKeys,
    ).toEqual({});
  });

  it("idempotently seeds exactly the three approved grants", () => {
    const seed = migration.match(
      /INSERT INTO "learning_plan_access_grants" \("email", "granted_by_email"\) VALUES([\s\S]*?)ON CONFLICT \("email"\) DO NOTHING;/,
    );
    expect(seed).not.toBeNull();

    const rows = [...seed![1].matchAll(/\('([^']+)', '([^']+)'\)/g)]
      .map((match) => [match[1], match[2]]);
    expect(rows).toEqual([
      ["m.giftwan@gmail.com", "system:migration"],
      ["gift.m@begiftededucation.com", "system:migration"],
      ["tudda.tudsirivoravat@gmail.com", "system:migration"],
    ]);
  });

  it("restores the 0055 snapshot chain and registers 0056", () => {
    expect(snapshot55.prevId).toBe(snapshot54.id);
    expect(snapshot56.prevId).toBe(snapshot55.id);
    expect(snapshot55.tables).toHaveProperty("public.post_class_access_grants");
    expect(snapshot55.tables).not.toHaveProperty("public.learning_plan_access_grants");
    expect(snapshot56.tables).toHaveProperty("public.learning_plan_access_grants");
    // Assert 0056 is registered, not that it is the newest entry — pinning
    // it to the tail breaks on every subsequent migration.
    expect(journal.entries).toContainEqual(expect.objectContaining({
      idx: 56,
      tag: "0056_learning_plan_access_grants",
    }));
  });
});
