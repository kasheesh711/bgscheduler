import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog, admissionsNotes } from "@/lib/db/schema";
import {
  ADMISSIONS_NOTE_VISIBILITIES,
  createNote,
  listNotesForRole,
  updateNoteVisibility,
} from "@/lib/admissions/notes";
import type { AdmissionsNoteVisibility, CaseRole } from "@/lib/admissions/types";
import type { Database } from "@/lib/db";

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = new Date("2026-07-01T00:00:00Z");

const STAFF_NOTE = {
  id: "note-staff",
  caseId: CASE_ID,
  authorEmail: "counselor@example.com",
  body: "internal: family is price-sensitive",
  visibility: "staff_only",
  deletedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const SHARED_NOTE = {
  id: "note-shared",
  caseId: CASE_ID,
  authorEmail: "counselor@example.com",
  body: "Great progress on the main essay this week",
  visibility: "shared_with_family",
  deletedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const NOTE_DTO_KEYS = [
  "authorEmail",
  "body",
  "caseId",
  "createdAt",
  "id",
  "updatedAt",
  "visibility",
];

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/** Mock write db (transaction + recorded inserts/updates), as in meetings tests. */
function makeWriteDb(existingRow?: Record<string, unknown>) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  let idCounter = 0;

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const id = `id-${++idCounter}`;
        return {
          returning: async () => [
            { id, createdAt: CREATED_AT, updatedAt: CREATED_AT, deletedAt: null, ...values },
          ],
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (existingRow ? [existingRow] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return {
          where: () => ({
            returning: async () => [{ ...(existingRow ?? {}), ...set }],
          }),
        };
      },
    }),
  };

  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const db = { transaction } as unknown as Database;
  return { db, inserts, updates, transaction };
}

/**
 * Mock read db that IGNORES the where clause and returns every provided row —
 * deliberately sloppy, so the tests prove the in-process visibility filter
 * fails closed even if the SQL filter regressed.
 */
function makeSelectDb(rows: Array<Record<string, unknown>>) {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({ orderBy: async () => rows }),
    }),
  }));
  const db = { select } as unknown as Database;
  return { db, select };
}

describe("createNote", () => {
  const baseInput = {
    caseId: CASE_ID,
    authorEmail: "Counselor@Example.com ",
    actorRole: "counselor" as const,
    body: "Family call went well",
    visibility: "staff_only" as const,
  };

  it("inserts the note with the explicit visibility and normalized author email", async () => {
    const { db, inserts } = makeWriteDb();

    const note = await createNote(baseInput, db);

    const noteInserts = inserts.filter((call) => call.table === admissionsNotes);
    expect(noteInserts).toHaveLength(1);
    expect(noteInserts[0].values).toEqual({
      caseId: CASE_ID,
      authorEmail: "counselor@example.com",
      body: "Family call went well",
      visibility: "staff_only",
    });
    expect(note.visibility).toBe("staff_only");
    expect(Object.keys(note).sort()).toEqual(NOTE_DTO_KEYS);
  });

  it("audits the create with the chosen visibility in the diff", async () => {
    const { db, inserts } = makeWriteDb();

    await createNote(baseInput, db);

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: CASE_ID,
      actorEmail: "counselor@example.com",
      actorRole: "counselor",
      entityType: "note",
      entityId: "id-1",
      action: "create",
      diff: { visibility: { old: null, new: "staff_only" } },
    }));
  });

  it("rejects a missing visibility before any write — no default is applied", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createNote(
      { ...baseInput, visibility: undefined as never },
      db,
    )).rejects.toThrow(/visibility is required/i);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown visibility value (fail-closed)", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createNote(
      { ...baseInput, visibility: "public" as never },
      db,
    )).rejects.toThrow(/visibility is required/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(ADMISSIONS_NOTE_VISIBILITIES).toEqual(["staff_only", "shared_with_family"]);
  });

  it("rejects an empty body before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createNote({ ...baseInput, body: "   " }, db))
      .rejects.toThrow(/body must not be empty/);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("listNotesForRole", () => {
  it.each(["parent", "student"] as const)(
    "never returns staff_only rows to a %s, even when the query leaks them",
    async (role: CaseRole) => {
      const { db } = makeSelectDb([STAFF_NOTE, SHARED_NOTE]);

      const notes = await listNotesForRole(CASE_ID, role, db);

      expect(notes).toHaveLength(1);
      expect(notes.map((note) => note.id)).toEqual(["note-shared"]);
      expect(notes.every((note) => note.visibility === "shared_with_family")).toBe(true);
    },
  );

  it.each(["counselor", "admin"] as const)(
    "returns staff_only and shared rows to a %s",
    async (role: CaseRole) => {
      const { db } = makeSelectDb([STAFF_NOTE, SHARED_NOTE]);

      const notes = await listNotesForRole(CASE_ID, role, db);

      expect(notes.map((note) => note.id)).toEqual(["note-staff", "note-shared"]);
    },
  );

  it("maps rows through the DTO whitelist — no deletedAt or extra keys leak", async () => {
    const { db } = makeSelectDb([
      { ...SHARED_NOTE, internalColumn: "must-not-leak" },
    ]);

    const notes = await listNotesForRole(CASE_ID, "parent", db);

    expect(notes).toHaveLength(1);
    expect(Object.keys(notes[0]).sort()).toEqual(NOTE_DTO_KEYS);
    expect(notes[0]).toEqual({
      id: "note-shared",
      caseId: CASE_ID,
      authorEmail: "counselor@example.com",
      body: "Great progress on the main essay this week",
      visibility: "shared_with_family",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("updateNoteVisibility", () => {
  const actor = { actorEmail: "counselor@example.com", actorRole: "counselor" as const };

  it("throws NotFound when the note does not exist in this case", async () => {
    const { db } = makeWriteDb();

    await expect(updateNoteVisibility({
      caseId: CASE_ID,
      noteId: "note-x",
      ...actor,
      visibility: "shared_with_family",
    }, db)).rejects.toThrow("NotFound");
  });

  it("updates the visibility and audits the change atomically", async () => {
    const { db, inserts, updates } = makeWriteDb(STAFF_NOTE);

    const note = await updateNoteVisibility({
      caseId: CASE_ID,
      noteId: "note-staff",
      ...actor,
      visibility: "shared_with_family",
    }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsNotes);
    expect(updates[0].set.visibility).toBe("shared_with_family");
    expect(updates[0].set.updatedAt).toBeInstanceOf(Date);
    expect(note.visibility).toBe("shared_with_family");

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      entityType: "note",
      entityId: "note-staff",
      action: "visibility_change",
      diff: { visibility: { old: "staff_only", new: "shared_with_family" } },
    }));
  });

  it("is a no-op (no update, no audit) when the visibility is unchanged", async () => {
    const { db, inserts, updates } = makeWriteDb(STAFF_NOTE);

    const note = await updateNoteVisibility({
      caseId: CASE_ID,
      noteId: "note-staff",
      ...actor,
      visibility: "staff_only",
    }, db);

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(note.visibility).toBe("staff_only");
  });

  it("rejects an unknown target visibility before any write", async () => {
    const { db, transaction } = makeWriteDb(STAFF_NOTE);

    await expect(updateNoteVisibility({
      caseId: CASE_ID,
      noteId: "note-staff",
      ...actor,
      visibility: "everyone" as unknown as AdmissionsNoteVisibility,
    }, db)).rejects.toThrow(/visibility is required/i);
    expect(transaction).not.toHaveBeenCalled();
  });
});
