import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog, admissionsSelfReportSections } from "@/lib/db/schema";
import {
  ADMISSIONS_SECTION_KEYS,
  SECTION_DEFINITIONS,
  getSectionDefinition,
  getSectionState,
  listSectionStates,
  reviewSection,
  saveSectionDraft,
  submitSection,
} from "@/lib/admissions/sections";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";

const UPDATED_AT = new Date("2026-07-01T00:00:00Z");

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "staff@example.com",
  role: "counselor",
  isAdmin: false,
};

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const PARENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "parent@example.com",
  role: "parent",
  isAdmin: false,
};

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as essays.test.ts) with
 * insert/update recording and a native `transaction` that hands the same
 * fake back to withAuditedTransaction. Each db.select() resolves to the next
 * queued result — the queue order must match the function's query order.
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  let generated = 0;
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  function selectBuilder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "groupBy", "limit"]) {
      b[method] = () => b;
    }
    (b as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return b;
  }

  const tx = {
    select: () => selectBuilder(queue[i++] ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = {
          id: `00000000-0000-4000-8000-${String(generated++).padStart(12, "0")}`,
          submittedAt: null,
          reviewedByEmail: null,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-01T00:00:00Z"),
          ...values,
        };
        return {
          returning: () => Promise.resolve([row]),
          then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        const b: Record<string, unknown> = {};
        b.where = () => b;
        b.returning = () => Promise.resolve([]);
        (b as { then: unknown }).then = (
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve(undefined).then(resolve, reject);
        return b;
      },
    }),
  };

  const db = {
    ...tx,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  return { db: db as never, inserts, updates };
}

function auditInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsAuditLog).map((call) => call.values);
}

function sectionInserts(inserts: InsertCall[]) {
  return inserts
    .filter((call) => call.table === admissionsSelfReportSections)
    .map((call) => call.values);
}

function sectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    caseId: CASE_ID,
    sectionKey: "about_you",
    payload: { hometown: "Bangkok, Thailand" },
    state: "draft",
    submittedAt: null,
    reviewedByEmail: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("SECTION_DEFINITIONS", () => {
  it("defines every canonical section key exactly once", () => {
    expect(SECTION_DEFINITIONS.map((definition) => definition.id)).toEqual([
      ...ADMISSIONS_SECTION_KEYS,
    ]);
  });

  it("keeps every step within the 5-10 fields design budget with unique keys", () => {
    for (const definition of SECTION_DEFINITIONS) {
      expect(definition.steps.length).toBeGreaterThan(0);
      const keys = new Set<string>();
      for (const step of definition.steps) {
        expect(step.fields.length).toBeGreaterThanOrEqual(5);
        expect(step.fields.length).toBeLessThanOrEqual(10);
        for (const field of step.fields) {
          expect(keys.has(field.key)).toBe(false);
          keys.add(field.key);
          expect(field.helper.length).toBeGreaterThan(0);
          if (field.type === "select" || field.type === "multiselect") {
            expect(field.options && field.options.length).toBeTruthy();
          }
          if (field.maxLength !== undefined) {
            expect(field.maxLength).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("resolves definitions by key and null for unknown keys", () => {
    expect(getSectionDefinition("about_you")?.title).toBe("About You");
    expect(getSectionDefinition("nope")).toBeNull();
  });
});

describe("getSectionState", () => {
  it("virtualizes a missing row as an empty draft without writing", async () => {
    const { db, inserts, updates } = fakeDb([[]]);

    const state = await getSectionState(CASE_ID, "personality", db);

    expect(state).toMatchObject({
      caseId: CASE_ID,
      sectionKey: "personality",
      payload: {},
      state: "draft",
      submittedAt: null,
      reviewedByEmail: null,
      updatedAt: null,
    });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("returns the stored payload and state", async () => {
    const { db } = fakeDb([[sectionRow({ state: "submitted", submittedAt: UPDATED_AT })]]);

    const state = await getSectionState(CASE_ID, "about_you", db);

    expect(state.payload).toEqual({ hometown: "Bangkok, Thailand" });
    expect(state.state).toBe("submitted");
    expect(state.submittedAt).toBe(UPDATED_AT.toISOString());
    expect(state.updatedAt).toBe(UPDATED_AT.toISOString());
  });

  it("throws NotFound for an unknown sectionKey", async () => {
    const { db } = fakeDb([]);

    await expect(getSectionState(CASE_ID, "unknown_section", db)).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId", async () => {
    const { db } = fakeDb([]);

    await expect(getSectionState("not-a-uuid", "about_you", db)).rejects.toThrow("NotFound");
  });
});

describe("listSectionStates", () => {
  it("returns every definition in order, defaulting missing rows to draft", async () => {
    const { db } = fakeDb([[
      {
        sectionKey: "q_and_a_survey",
        state: "submitted",
        submittedAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
      },
    ]]);

    const summaries = await listSectionStates(CASE_ID, db);

    expect(summaries.map((summary) => summary.sectionKey)).toEqual([...ADMISSIONS_SECTION_KEYS]);
    const survey = summaries.find((summary) => summary.sectionKey === "q_and_a_survey");
    expect(survey?.state).toBe("submitted");
    const aboutYou = summaries.find((summary) => summary.sectionKey === "about_you");
    expect(aboutYou).toMatchObject({ state: "draft", submittedAt: null, updatedAt: null });
  });

  it("fails closed to an empty list on a malformed caseId", async () => {
    const { db } = fakeDb([]);

    await expect(listSectionStates("nope", db)).resolves.toEqual([]);
  });
});

describe("saveSectionDraft", () => {
  it("rejects unknown payload keys before any write", async () => {
    const { db, inserts, updates } = fakeDb([]);

    await expect(
      saveSectionDraft(
        { access: STUDENT_ACCESS, sectionKey: "about_you", payload: { hacker_field: "x" } },
        db,
      ),
    ).rejects.toThrow('Unknown field "hacker_field" for section "about_you"');
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("forbids parents", async () => {
    const { db } = fakeDb([]);

    await expect(
      saveSectionDraft(
        { access: PARENT_ACCESS, sectionKey: "about_you", payload: { hometown: "BKK" } },
        db,
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("enforces maxLength as a hard stop", async () => {
    const { db } = fakeDb([]);

    await expect(
      saveSectionDraft(
        {
          access: STUDENT_ACCESS,
          sectionKey: "about_you",
          payload: { preferred_name: "x".repeat(51) },
        },
        db,
      ),
    ).rejects.toThrow('Field "preferred_name" exceeds 50 characters');
  });

  it("rejects select values outside the field's options", async () => {
    const { db } = fakeDb([]);

    await expect(
      saveSectionDraft(
        {
          access: STUDENT_ACCESS,
          sectionKey: "q_and_a_survey",
          payload: { preferred_environment: "The moon" },
        },
        db,
      ),
    ).rejects.toThrow('Field "preferred_environment" has an unknown option: "The moon"');
  });

  it("rejects multiselect entries outside the field's options", async () => {
    const { db } = fakeDb([]);

    await expect(
      saveSectionDraft(
        {
          access: STUDENT_ACCESS,
          sectionKey: "about_you",
          payload: { favorite_subjects: ["Math", "Alchemy"] },
        },
        db,
      ),
    ).rejects.toThrow('Field "favorite_subjects" has an unknown option: "Alchemy"');
  });

  it("materializes a missing row as a draft on first save", async () => {
    const { db, inserts } = fakeDb([[]]);

    const state = await saveSectionDraft(
      { access: STUDENT_ACCESS, sectionKey: "about_you", payload: { hometown: "  Bangkok  " } },
      db,
    );

    const rows = sectionInserts(inserts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: CASE_ID,
      sectionKey: "about_you",
      payload: { hometown: "Bangkok" },
      state: "draft",
    });
    expect(state.state).toBe("draft");
    expect(state.payload).toEqual({ hometown: "Bangkok" });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "self_report_section",
      action: "save_draft",
    });
  });

  it("merges a partial payload into the stored payload and clears null keys", async () => {
    const row = sectionRow({
      payload: { hometown: "Bangkok, Thailand", preferred_name: "Mint" },
    });
    const { db, updates } = fakeDb([[row]]);

    const state = await saveSectionDraft(
      {
        access: STUDENT_ACCESS,
        sectionKey: "about_you",
        payload: { languages: "Thai, English", preferred_name: null },
      },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set.payload).toEqual({
      hometown: "Bangkok, Thailand",
      languages: "Thai, English",
    });
    expect(updates[0].set.state).toBeUndefined();
    expect(state.payload).toEqual({
      hometown: "Bangkok, Thailand",
      languages: "Thai, English",
    });
  });

  it("returns a submitted section to draft on an effective edit, audited", async () => {
    const row = sectionRow({
      state: "submitted",
      submittedAt: UPDATED_AT,
    });
    const { db, inserts, updates } = fakeDb([[row]]);

    const state = await saveSectionDraft(
      { access: STUDENT_ACCESS, sectionKey: "about_you", payload: { hometown: "Chiang Mai" } },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({
      state: "draft",
      submittedAt: null,
      reviewedByEmail: null,
    });
    expect(state.state).toBe("draft");
    expect(state.submittedAt).toBeNull();

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0].diff).toMatchObject({
      hometown: { old: "Bangkok, Thailand", new: "Chiang Mai" },
      state: { old: "submitted", new: "draft" },
    });
  });

  it("also returns a reviewed section to draft on an effective edit", async () => {
    const row = sectionRow({
      state: "reviewed",
      submittedAt: UPDATED_AT,
      reviewedByEmail: "staff@example.com",
    });
    const { db, updates } = fakeDb([[row]]);

    const state = await saveSectionDraft(
      { access: STUDENT_ACCESS, sectionKey: "about_you", payload: { hometown: "Chiang Mai" } },
      db,
    );

    expect(updates[0].set).toMatchObject({ state: "draft", reviewedByEmail: null });
    expect(state.state).toBe("draft");
    expect(state.reviewedByEmail).toBeNull();
  });

  it("does not revert state on a no-op save (same values replayed)", async () => {
    const row = sectionRow({ state: "submitted", submittedAt: UPDATED_AT });
    const { db, inserts, updates } = fakeDb([[row]]);

    const state = await saveSectionDraft(
      {
        access: STUDENT_ACCESS,
        sectionKey: "about_you",
        payload: { hometown: "Bangkok, Thailand", preferred_name: null },
      },
      db,
    );

    expect(updates).toHaveLength(0);
    expect(auditInserts(inserts)).toHaveLength(0);
    expect(state.state).toBe("submitted");
  });

  it("attributes a counselor override via the audit actorRole", async () => {
    const { db, inserts } = fakeDb([[sectionRow()]]);

    await saveSectionDraft(
      { access: COUNSELOR_ACCESS, sectionKey: "about_you", payload: { hometown: "Phuket" } },
      db,
    );

    expect(auditInserts(inserts)[0]).toMatchObject({
      actorEmail: "staff@example.com",
      actorRole: "counselor",
      action: "save_draft",
    });
  });

  it("dedupes multiselect values while preserving order", async () => {
    const { db, updates } = fakeDb([[sectionRow({ payload: {} })]]);

    const state = await saveSectionDraft(
      {
        access: STUDENT_ACCESS,
        sectionKey: "about_you",
        payload: { favorite_subjects: ["Math", "Physics", "Math"] },
      },
      db,
    );

    expect(updates[0].set.payload).toEqual({ favorite_subjects: ["Math", "Physics"] });
    expect(state.payload).toEqual({ favorite_subjects: ["Math", "Physics"] });
  });
});

describe("submitSection", () => {
  it("moves a draft to submitted and returns the notify marker", async () => {
    const { db, inserts, updates } = fakeDb([[sectionRow()]]);

    const result = await submitSection(
      { access: STUDENT_ACCESS, sectionKey: "about_you" },
      db,
    );

    expect(result.notify).toBe(true);
    expect(result.section.state).toBe("submitted");
    expect(result.section.submittedAt).not.toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ state: "submitted", reviewedByEmail: null });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "self_report_section",
      entityId: ROW_ID,
      action: "submit",
    });
  });

  it("throws Conflict when the section was never saved (empty virtual draft)", async () => {
    const { db, updates } = fakeDb([[]]);

    await expect(
      submitSection({ access: STUDENT_ACCESS, sectionKey: "about_you" }, db),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
  });

  it("throws Conflict when already submitted", async () => {
    const { db } = fakeDb([[sectionRow({ state: "submitted", submittedAt: UPDATED_AT })]]);

    await expect(
      submitSection({ access: STUDENT_ACCESS, sectionKey: "about_you" }, db),
    ).rejects.toThrow("Conflict");
  });

  it("forbids parents", async () => {
    const { db } = fakeDb([]);

    await expect(
      submitSection({ access: PARENT_ACCESS, sectionKey: "about_you" }, db),
    ).rejects.toThrow("Forbidden");
  });
});

describe("reviewSection", () => {
  it("moves a submitted section to reviewed and stamps the reviewer", async () => {
    const { db, inserts, updates } = fakeDb([
      [sectionRow({ state: "submitted", submittedAt: UPDATED_AT })],
    ]);

    const state = await reviewSection(
      { access: COUNSELOR_ACCESS, sectionKey: "about_you" },
      db,
    );

    expect(state.state).toBe("reviewed");
    expect(state.reviewedByEmail).toBe("staff@example.com");
    expect(updates[0].set).toMatchObject({
      state: "reviewed",
      reviewedByEmail: "staff@example.com",
    });
    expect(auditInserts(inserts)[0]).toMatchObject({ action: "review" });
  });

  it("forbids students", async () => {
    const { db } = fakeDb([]);

    await expect(
      reviewSection({ access: STUDENT_ACCESS, sectionKey: "about_you" }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("throws Conflict when the section is still a draft", async () => {
    const { db } = fakeDb([[sectionRow()]]);

    await expect(
      reviewSection({ access: COUNSELOR_ACCESS, sectionKey: "about_you" }, db),
    ).rejects.toThrow("Conflict");
  });

  it("throws NotFound when the section was never saved", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      reviewSection({ access: COUNSELOR_ACCESS, sectionKey: "about_you" }, db),
    ).rejects.toThrow("NotFound");
  });
});
