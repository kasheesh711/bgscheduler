import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { count, eq, inArray } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import * as schema from "@/lib/db/schema";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { assertCaseMutationAllowed, requireCaseAccess } from "@/lib/admissions/access";
import { updateCaseProfile } from "@/lib/admissions/cases";
import { revokeMember } from "@/lib/admissions/members";
import { withAuditedTransaction, writeAuditLog } from "@/lib/admissions/audit";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

async function seedCase() {
  const suffix = crypto.randomUUID();
  const [cohort] = await handle.db.insert(schema.admissionsCohorts).values({
    name: `Admissions parity integration cohort ${suffix}`,
    graduationYear: 2027,
  }).returning();
  const [student] = await handle.db.insert(schema.admissionsStudents).values({
    fullName: "Test Student",
    studentEmail: `student-${suffix}@example.com`,
    cohortId: cohort.id,
  }).returning();
  const [admissionsCase] = await handle.db.insert(schema.admissionsCases).values({
    studentId: student.id,
    cohortId: cohort.id,
  }).returning();
  return { admissionsCase, student, cohort };
}

describe("0053–0054 admissions parity migrations — real Postgres", () => {
  it("enforces new FKs, unique keys, checks, and extension defaults", async () => {
    const { admissionsCase } = await seedCase();

    const [academic] = await handle.db.insert(schema.admissionsAcademicRecords).values({
      caseId: admissionsCase.id,
      system: "us",
      effectiveDate: "2026-06-01",
      payload: { system: "us", gpaScale: 4, fourYearCoursePlan: [] },
    }).returning();
    expect(academic.deletedAt).toBeNull();
    await expect(handle.db.insert(schema.admissionsAcademicRecords).values({
      caseId: admissionsCase.id,
      system: "us",
      effectiveDate: "2026-06-01",
      payload: { system: "us", gpaScale: 4, fourYearCoursePlan: [] },
    })).rejects.toThrow();

    const [award] = await handle.db.insert(schema.admissionsAwards).values({
      caseId: admissionsCase.id,
      title: "National Award",
      commonAppRank: 1,
      ucEligibilityNarrative: "e".repeat(250),
      ucAchievementNarrative: "a".repeat(350),
    }).returning();
    expect(award.commonAppRank).toBe(1);
    await expect(handle.db.insert(schema.admissionsAwards).values({
      caseId: admissionsCase.id,
      title: "Duplicate rank",
      commonAppRank: 1,
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsAwards).values({
      caseId: admissionsCase.id,
      title: "Too long",
      ucEligibilityNarrative: "x".repeat(251),
    })).rejects.toThrow();

    const [sitting] = await handle.db.insert(schema.admissionsTestSittings).values({
      caseId: admissionsCase.id,
      testType: "sat",
      testDate: "2026-11-07",
      lateRegistrationDeadline: "2026-10-20",
      status: "score_received",
      scoreDetails: { testType: "sat", math: 780, readingWriting: 720, total: 1500 },
      actualScore: "1500",
    }).returning();
    expect(sitting.status).toBe("score_received");
    expect(sitting.deletedAt).toBeNull();

    await handle.db.insert(schema.admissionsNotificationOutbox).values({
      caseId: admissionsCase.id,
      recipientEmail: "student@example.com",
      category: "invite",
      payload: { studentName: "Test Student" },
      dedupeKey: "invite:parity-integration",
    });
    await expect(handle.db.insert(schema.admissionsNotificationOutbox).values({
      caseId: admissionsCase.id,
      recipientEmail: "student@example.com",
      category: "invite",
      payload: {},
      dedupeKey: "invite:parity-integration",
    })).rejects.toThrow();

    const [listItem] = await handle.db.insert(schema.admissionsCollegeListItems).values({
      caseId: admissionsCase.id,
      instName: "Example University",
      country: "US",
      isManual: true,
      round: "rd",
      firstChoiceMajor: "Computer Science",
      admissionsUrl: "https://example.edu/admissions",
    }).returning();
    await handle.db.insert(schema.admissionsCollegeResearch).values({
      listItemId: listItem.id,
      fitRating: 5,
      sources: [{ title: "Official site", url: "https://example.edu" }],
    });
    await expect(handle.db.insert(schema.admissionsCollegeResearch).values({
      listItemId: listItem.id,
      fitRating: 4,
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsCollegeResearch).values({
      listItemId: crypto.randomUUID(),
      fitRating: 4,
    })).rejects.toThrow();
  });

  it("runs the 0054 status backfill safely and idempotently against real Postgres", async () => {
    const { admissionsCase } = await seedCase();
    const inserted = await handle.db.insert(schema.admissionsTestSittings).values([
      {
        caseId: admissionsCase.id,
        testType: "sat",
        testDate: "2000-01-01",
        status: "planned",
      },
      {
        caseId: admissionsCase.id,
        testType: "act",
        testDate: "2999-01-01",
        status: "planned",
      },
      {
        caseId: admissionsCase.id,
        testType: "toefl",
        testDate: "2999-01-01",
        status: "planned",
        actualScore: "112",
      },
      {
        caseId: admissionsCase.id,
        testType: "sat",
        testDate: "2999-01-01",
        status: "planned",
        scoreDetails: { testType: "sat", math: 760, readingWriting: 740, total: 1500 },
      },
      {
        caseId: admissionsCase.id,
        testType: "ielts",
        testDate: "2000-01-01",
        status: "planned",
        actualScore: "8.0",
        deletedAt: new Date(),
      },
    ]).returning({ id: schema.admissionsTestSittings.id });

    const migrationSql = await readFile(
      path.resolve(process.cwd(), "drizzle/0054_admissions_test_status_backfill.sql"),
      "utf8",
    );
    await handle.pool.query(migrationSql);
    // A second execution proves the data migration can be retried without
    // changing already-restored or intentionally untouched rows.
    await handle.pool.query(migrationSql);

    const rows = await handle.db.select({
      id: schema.admissionsTestSittings.id,
      status: schema.admissionsTestSittings.status,
    }).from(schema.admissionsTestSittings).where(inArray(
      schema.admissionsTestSittings.id,
      inserted.map((row) => row.id),
    ));
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    expect(statusById.get(inserted[0]!.id)).toBe("taken");
    expect(statusById.get(inserted[1]!.id)).toBe("planned");
    expect(statusById.get(inserted[2]!.id)).toBe("score_received");
    expect(statusById.get(inserted[3]!.id)).toBe("score_received");
    expect(statusById.get(inserted[4]!.id)).toBe("planned");
  });

  it("enforces the remaining 0053 relationship and idempotency constraints", async () => {
    const { admissionsCase } = await seedCase();
    const missingId = crypto.randomUUID();
    const [listItem] = await handle.db.insert(schema.admissionsCollegeListItems).values({
      caseId: admissionsCase.id,
      instName: "Constraint University",
      country: "US",
      isManual: true,
      round: "rd",
    }).returning();

    await expect(handle.db.insert(schema.admissionsAwards).values({
      caseId: missingId,
      title: "Orphan award",
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsTestSittings).values({
      caseId: missingId,
      testType: "sat",
      testDate: "2026-10-01",
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsAcademicRecords).values({
      caseId: missingId,
      system: "us",
      effectiveDate: "2026-06-01",
      payload: { system: "us", gpaScale: 4, fourYearCoursePlan: [] },
    })).rejects.toThrow();

    await handle.db.insert(schema.admissionsInterestEvents).values({
      listItemId: listItem.id,
      type: "campus_visit",
      eventDate: "2026-09-01",
      actorEmail: "student@example.com",
    });
    await expect(handle.db.insert(schema.admissionsInterestEvents).values({
      listItemId: missingId,
      type: "campus_visit",
      eventDate: "2026-09-01",
      actorEmail: "student@example.com",
    })).rejects.toThrow();

    await handle.db.insert(schema.admissionsCollegeRequirements).values({
      listItemId: listItem.id,
      kind: "interview",
      title: "Complete interview",
    });
    await expect(handle.db.insert(schema.admissionsCollegeRequirements).values({
      listItemId: missingId,
      kind: "interview",
      title: "Orphan requirement",
    })).rejects.toThrow();

    await handle.db.insert(schema.admissionsFinancialAidOffers).values({
      listItemId: listItem.id,
      awardYear: 2027,
    });
    await expect(handle.db.insert(schema.admissionsFinancialAidOffers).values({
      listItemId: listItem.id,
      awardYear: 2028,
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsFinancialAidOffers).values({
      listItemId: missingId,
      awardYear: 2027,
    })).rejects.toThrow();

    await handle.db.insert(schema.admissionsScholarships).values({
      caseId: admissionsCase.id,
      listItemId: listItem.id,
      name: "Constraint scholarship",
    });
    await expect(handle.db.insert(schema.admissionsScholarships).values({
      caseId: missingId,
      name: "Orphan scholarship",
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsScholarships).values({
      caseId: admissionsCase.id,
      listItemId: missingId,
      name: "Orphan college scholarship",
    })).rejects.toThrow();

    const prompt = {
      institution: "Constraint University",
      program: "Honors",
      cycle: "2026-27",
      promptKey: "one",
      prompt: "Why us?",
      wordLimit: 250,
    };
    await handle.db.insert(schema.admissionsEssayPromptCatalog).values(prompt);
    await expect(handle.db.insert(schema.admissionsEssayPromptCatalog).values(prompt))
      .rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsEssayPromptCatalog).values({
      ...prompt,
      promptKey: "invalid-limit",
      wordLimit: 0,
    })).rejects.toThrow();

    const [run] = await handle.db.insert(schema.admissionsImportRuns).values({
      caseId: admissionsCase.id,
      spreadsheetId: "constraint-sheet",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/constraint-sheet/edit",
      sourceFingerprint: "f".repeat(64),
      createdByEmail: "staff@example.com",
    }).returning();
    await expect(handle.db.insert(schema.admissionsImportRuns).values({
      caseId: missingId,
      spreadsheetId: "orphan-sheet",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/orphan-sheet/edit",
      sourceFingerprint: "e".repeat(64),
      createdByEmail: "staff@example.com",
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsImportRuns).values({
      caseId: admissionsCase.id,
      spreadsheetId: "constraint-sheet",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/constraint-sheet/edit",
      sourceFingerprint: "f".repeat(64),
      createdByEmail: "staff@example.com",
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsImportIssues).values({
      runId: missingId,
      severity: "warning",
      code: "missing_date",
      message: "Orphan issue",
    })).rejects.toThrow();
    const mapping = {
      runId: run.id,
      sourceType: "task",
      sourceKey: "Tasks:2",
      targetType: "task",
      targetId: crypto.randomUUID(),
    };
    await handle.db.insert(schema.admissionsImportMappings).values(mapping);
    await expect(handle.db.insert(schema.admissionsImportMappings).values(mapping))
      .rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsImportMappings).values({
      ...mapping,
      runId: missingId,
      sourceKey: "Tasks:3",
    })).rejects.toThrow();

    await expect(handle.db.insert(schema.admissionsNotificationOutbox).values({
      caseId: admissionsCase.id,
      memberId: missingId,
      recipientEmail: "missing@example.com",
      category: "invite",
      payload: {},
      dedupeKey: `missing-member:${crypto.randomUUID()}`,
    })).rejects.toThrow();
    await expect(handle.db.insert(schema.admissionsNotificationOutbox).values({
      caseId: missingId,
      recipientEmail: "missing@example.com",
      category: "invite",
      payload: {},
      dedupeKey: `missing-case:${crypto.randomUUID()}`,
    })).rejects.toThrow();
  });

  it("enforces family lifecycle access and revocation against real rows", async () => {
    const { admissionsCase, student } = await seedCase();
    const studentEmail = student.studentEmail;
    const parentEmail = `parent-${crypto.randomUUID()}@example.com`;
    const counselorEmail = `counselor-${crypto.randomUUID()}@example.com`;
    const [studentMember, parentMember] = await handle.db
      .insert(schema.admissionsCaseMembers)
      .values([
        { caseId: admissionsCase.id, email: studentEmail, role: "student", status: "active" },
        { caseId: admissionsCase.id, email: parentEmail, role: "parent", status: "active" },
      ])
      .returning();
    await handle.db.insert(schema.admissionsCounselors).values({
      email: counselorEmail,
      name: "Assigned Counselor",
      active: true,
    });
    await handle.db.insert(schema.admissionsCaseMembers).values({
      caseId: admissionsCase.id,
      email: counselorEmail,
      role: "counselor",
      status: "active",
    });

    await expect(requireCaseAccess(studentEmail, admissionsCase.id, "student", handle.db as never))
      .rejects.toThrow("Forbidden");
    await expect(requireCaseAccess(parentEmail, admissionsCase.id, "parent", handle.db as never))
      .rejects.toThrow("Forbidden");
    await expect(requireCaseAccess(counselorEmail, admissionsCase.id, "counselor", handle.db as never))
      .resolves.toMatchObject({ role: "counselor", isAdmin: false });

    await handle.db.update(schema.admissionsCases)
      .set({ familyPortalOpen: true })
      .where(eq(schema.admissionsCases.id, admissionsCase.id));
    await expect(requireCaseAccess(studentEmail, admissionsCase.id, "student", handle.db as never))
      .resolves.toMatchObject({ role: "student", familyReadOnly: undefined });

    await handle.db.update(schema.admissionsCases)
      .set({ status: "completed" })
      .where(eq(schema.admissionsCases.id, admissionsCase.id));
    const completedParent = await requireCaseAccess(
      parentEmail,
      admissionsCase.id,
      "parent",
      handle.db as never,
    );
    expect(completedParent).toMatchObject({ role: "parent", familyReadOnly: true });
    expect(() => assertCaseMutationAllowed(completedParent)).toThrow("Forbidden");

    await handle.db.update(schema.admissionsCases)
      .set({ status: "withdrawn" })
      .where(eq(schema.admissionsCases.id, admissionsCase.id));
    await expect(requireCaseAccess(studentEmail, admissionsCase.id, "student", handle.db as never))
      .rejects.toThrow("Forbidden");

    await handle.db.update(schema.admissionsCases)
      .set({ status: "active" })
      .where(eq(schema.admissionsCases.id, admissionsCase.id));
    await revokeMember({
      caseId: admissionsCase.id,
      memberId: parentMember.id,
      actor: { email: counselorEmail, role: "counselor" },
    }, handle.db as never);
    await expect(requireCaseAccess(parentEmail, admissionsCase.id, "parent", handle.db as never))
      .rejects.toThrow("Forbidden");
    await expect(revokeMember({
      caseId: admissionsCase.id,
      memberId: studentMember.id,
      actor: { email: counselorEmail, role: "counselor" },
    }, handle.db as never)).rejects.toThrow("Conflict");
  });

  it("allows only one concurrent portal-open transaction and one invite per member", async () => {
    const { admissionsCase, student } = await seedCase();
    const parentEmail = `parent-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.admissionsCaseMembers).values([
      { caseId: admissionsCase.id, email: student.studentEmail, role: "student", status: "invited" },
      { caseId: admissionsCase.id, email: parentEmail, role: "parent", status: "invited" },
    ]);
    const [current] = await handle.db.select({ updatedAt: schema.admissionsCases.updatedAt })
      .from(schema.admissionsCases)
      .where(eq(schema.admissionsCases.id, admissionsCase.id));
    const input = {
      caseId: admissionsCase.id,
      expectedUpdatedAt: current.updatedAt.toISOString(),
      familyPortalOpen: true,
      actor: { email: "staff@example.com", role: "counselor" as const },
    };
    const results = await Promise.allSettled([
      updateCaseProfile(input, handle.db as never),
      updateCaseProfile(input, handle.db as never),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [outboxCount] = await handle.db.select({ value: count() })
      .from(schema.admissionsNotificationOutbox)
      .where(eq(schema.admissionsNotificationOutbox.caseId, admissionsCase.id));
    expect(Number(outboxCount.value)).toBe(2);
  });

  it("rolls a mutation back when its paired audit insert fails", async () => {
    const { admissionsCase } = await seedCase();
    const title = `Rollback award ${crypto.randomUUID()}`;
    await expect(withAuditedTransaction(async (tx) => {
      const [award] = await tx.insert(schema.admissionsAwards).values({
        caseId: admissionsCase.id,
        title,
      }).returning({ id: schema.admissionsAwards.id });
      await writeAuditLog(tx, {
        caseId: admissionsCase.id,
        actorEmail: "staff@example.com",
        actorRole: "invalid-role" as never,
        entityType: "award",
        entityId: award.id,
        action: "create",
      });
    }, handle.db as never)).rejects.toThrow();

    const [awardCount] = await handle.db.select({ value: count() })
      .from(schema.admissionsAwards)
      .where(eq(schema.admissionsAwards.title, title));
    expect(Number(awardCount.value)).toBe(0);
  });
});
