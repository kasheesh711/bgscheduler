import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the membership
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog, admissionsCaseMembers } from "@/lib/db/schema";
import {
  addMember,
  changeMemberEmail,
  getActiveCaseMembers,
  isUuidShaped,
  mapAdmissionsMemberRow,
  normalizeAdmissionsEmail,
  reInvite,
  rejectStudentAsParent,
  revokeMember,
} from "@/lib/admissions/members";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "99999999-9999-4999-8999-999999999999";
const STUDENT_EMAIL = "ada@example.com";

const ACTOR = { email: "staff@example.com", role: "counselor" as const };

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as access.test.ts) extended with
 * insert/update recording and a native `transaction` that hands the same fake
 * back to withAuditedTransaction. Each db.select() resolves to the next
 * queued result — the queue order must match the function's query order.
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  let generated = 0;
  const selectCalls: number[] = [];
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
    select: () => {
      selectCalls.push(i);
      return selectBuilder(queue[i++] ?? []);
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = {
          id: `generated-${generated++}`,
          invitedAt: null,
          activatedAt: null,
          revokedAt: null,
          addedByEmail: null,
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
  return { db: db as never, selectCalls, inserts, updates };
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    caseId: CASE_ID,
    email: "mom@example.com",
    role: "parent",
    status: "active",
    invitedAt: new Date("2026-06-01T00:00:00Z"),
    activatedAt: new Date("2026-06-02T00:00:00Z"),
    revokedAt: null,
    addedByEmail: "staff@example.com",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-02T00:00:00Z"),
    ...overrides,
  };
}

function auditInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsAuditLog).map((call) => call.values);
}

function memberInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsCaseMembers).map((call) => call.values);
}

describe("helpers", () => {
  it("normalizeAdmissionsEmail trims and lowercases", () => {
    expect(normalizeAdmissionsEmail("  Mom@Example.COM ")).toBe("mom@example.com");
  });

  it("isUuidShaped accepts uuids and rejects junk", () => {
    expect(isUuidShaped(CASE_ID)).toBe(true);
    expect(isUuidShaped("not-a-uuid")).toBe(false);
    expect(isUuidShaped("")).toBe(false);
  });

  it("mapAdmissionsMemberRow serializes timestamps to ISO strings", () => {
    const dto = mapAdmissionsMemberRow(memberRow() as never);

    expect(dto).toMatchObject({
      id: MEMBER_ID,
      caseId: CASE_ID,
      email: "mom@example.com",
      role: "parent",
      status: "active",
      invitedAt: "2026-06-01T00:00:00.000Z",
      activatedAt: "2026-06-02T00:00:00.000Z",
      revokedAt: null,
    });
  });
});

describe("addMember", () => {
  it("adds a parent as an invited member with a paired audit row", async () => {
    // Queue: [case+student email], [existing (caseId,email) row -> none].
    const { db, inserts } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], []]);

    const dto = await addMember(
      { caseId: CASE_ID, email: " Mom@Example.com ", role: "parent", actor: ACTOR },
      db,
    );

    const members = memberInserts(inserts);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      caseId: CASE_ID,
      email: "mom@example.com",
      role: "parent",
      status: "invited",
      addedByEmail: "staff@example.com",
    });
    expect(members[0].invitedAt).toBeInstanceOf(Date);
    expect(members[0].activatedAt).toBeNull();

    expect(dto).toMatchObject({ email: "mom@example.com", role: "parent", status: "invited" });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "case_member",
      action: "create",
      diff: {
        email: { old: null, new: "mom@example.com" },
        role: { old: null, new: "parent" },
        status: { old: null, new: "invited" },
      },
    });
  });

  it("adds a counselor as immediately active", async () => {
    const { db, inserts } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], []]);

    await addMember(
      { caseId: CASE_ID, email: "new-staff@example.com", role: "counselor", actor: ACTOR },
      db,
    );

    const members = memberInserts(inserts);
    expect(members[0]).toMatchObject({ role: "counselor", status: "active" });
    expect(members[0].activatedAt).toBeInstanceOf(Date);
    expect(members[0].invitedAt).toBeNull();
  });

  it("rejects a parent email equal to the case's student email with Conflict", async () => {
    const { db, inserts, selectCalls } = fakeDb([[{ studentEmail: STUDENT_EMAIL }]]);

    await expect(
      addMember({ caseId: CASE_ID, email: "ADA@example.com", role: "parent", actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
    expect(selectCalls).toHaveLength(1);
  });

  it("allows the student email as parent under adminOverride", async () => {
    const { db, inserts } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], []]);

    await addMember(
      {
        caseId: CASE_ID,
        email: STUDENT_EMAIL,
        role: "parent",
        actor: { email: "admin@example.com", role: "admin" },
        adminOverride: true,
      },
      db,
    );

    expect(memberInserts(inserts)).toHaveLength(1);
  });

  it("rejects an existing non-revoked membership with Conflict", async () => {
    const { db, inserts } = fakeDb([
      [{ studentEmail: STUDENT_EMAIL }],
      [memberRow({ status: "active" })],
    ]);

    await expect(
      addMember({ caseId: CASE_ID, email: "mom@example.com", role: "parent", actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("reinstates a revoked membership in place (audited as reinstate)", async () => {
    const revoked = memberRow({
      status: "revoked",
      revokedAt: new Date("2026-06-20T00:00:00Z"),
    });
    const { db, inserts, updates } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], [revoked]]);

    const dto = await addMember(
      { caseId: CASE_ID, email: "mom@example.com", role: "parent", actor: ACTOR },
      db,
    );

    expect(memberInserts(inserts)).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ role: "parent", status: "invited", revokedAt: null });

    expect(dto).toMatchObject({ id: MEMBER_ID, status: "invited", revokedAt: null });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "reinstate", entityId: MEMBER_ID });
    expect((audits[0].diff as Record<string, unknown>).status).toEqual({
      old: "revoked",
      new: "invited",
    });
  });

  it("rejects role student with Conflict without querying (single student per case)", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(
      addMember({ caseId: CASE_ID, email: "kid2@example.com", role: "student", actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound when the case is missing or soft-deleted", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      addMember({ caseId: CASE_ID, email: "mom@example.com", role: "parent", actor: ACTOR }, db),
    ).rejects.toThrow("NotFound");
  });
});

describe("revokeMember", () => {
  it("revokes an active member and writes the status diff", async () => {
    const { db, inserts, updates } = fakeDb([[memberRow()]]);

    const dto = await revokeMember({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ status: "revoked" });
    expect(updates[0].set.revokedAt).toBeInstanceOf(Date);

    expect(dto.status).toBe("revoked");
    expect(dto.revokedAt).not.toBeNull();

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "revoke", entityId: MEMBER_ID });
    expect((audits[0].diff as Record<string, unknown>).status).toEqual({
      old: "active",
      new: "revoked",
    });
  });

  it("throws Conflict when the member is already revoked", async () => {
    const { db, updates } = fakeDb([[memberRow({ status: "revoked" })]]);

    await expect(
      revokeMember({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
  });

  it("throws NotFound for a member of a different case (scoped lookup misses)", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      revokeMember({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db),
    ).rejects.toThrow("NotFound");
  });

  it("throws NotFound for malformed ids without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(
      revokeMember({ caseId: CASE_ID, memberId: "nope", actor: ACTOR }, db),
    ).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});

describe("changeMemberEmail", () => {
  it("revokes the old row and creates a fresh invited row for the new email", async () => {
    // Queue: [case+student email], [member row], [duplicate check -> none].
    const { db, inserts, updates } = fakeDb([
      [{ studentEmail: STUDENT_EMAIL }],
      [memberRow()],
      [],
    ]);

    const dto = await changeMemberEmail(
      { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: "New-Mom@Example.com", actor: ACTOR },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ status: "revoked" });

    const members = memberInserts(inserts);
    expect(members).toHaveLength(1);
    // New row keeps the role but is always invited (new address must accept).
    expect(members[0]).toMatchObject({
      email: "new-mom@example.com",
      role: "parent",
      status: "invited",
    });
    expect(members[0].invitedAt).toBeInstanceOf(Date);

    expect(dto).toMatchObject({ email: "new-mom@example.com", role: "parent", status: "invited" });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: "email_change", entityId: MEMBER_ID });
    expect((audits[0].diff as Record<string, unknown>).email).toEqual({
      old: "mom@example.com",
      new: "new-mom@example.com",
    });
    expect(audits[1]).toMatchObject({ action: "create" });
  });

  it("forces invited status even when the member is a counselor", async () => {
    const { db, inserts } = fakeDb([
      [{ studentEmail: STUDENT_EMAIL }],
      [memberRow({ role: "counselor", email: "old-staff@example.com" })],
      [],
    ]);

    await changeMemberEmail(
      { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: "new-staff@example.com", actor: ACTOR },
      db,
    );

    expect(memberInserts(inserts)[0]).toMatchObject({ role: "counselor", status: "invited" });
  });

  it("rejects a parent's new email equal to the student email with Conflict", async () => {
    const { db, selectCalls } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], [memberRow()]]);

    await expect(
      changeMemberEmail(
        { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: STUDENT_EMAIL, actor: ACTOR },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(selectCalls).toHaveLength(2);
  });

  it("allows a parent's new email equal to the student email under adminOverride", async () => {
    const { db, inserts } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], [memberRow()], []]);

    await changeMemberEmail(
      {
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        newEmail: STUDENT_EMAIL,
        actor: { email: "admin@example.com", role: "admin" },
        adminOverride: true,
      },
      db,
    );

    expect(memberInserts(inserts)).toHaveLength(1);
  });

  it("rejects a new email that already has a membership row with Conflict", async () => {
    const { db, updates } = fakeDb([
      [{ studentEmail: STUDENT_EMAIL }],
      [memberRow()],
      [{ id: "other-member" }],
    ]);

    await expect(
      changeMemberEmail(
        { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: "dad@example.com", actor: ACTOR },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
  });

  it("rejects an unchanged email with Conflict", async () => {
    const { db } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], [memberRow()]]);

    await expect(
      changeMemberEmail(
        { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: " MOM@example.com ", actor: ACTOR },
        db,
      ),
    ).rejects.toThrow("Conflict");
  });

  it("rejects a revoked member with Conflict", async () => {
    const { db } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], [memberRow({ status: "revoked" })]]);

    await expect(
      changeMemberEmail(
        { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: "new@example.com", actor: ACTOR },
        db,
      ),
    ).rejects.toThrow("Conflict");
  });

  it("throws NotFound when the member row is missing", async () => {
    const { db } = fakeDb([[{ studentEmail: STUDENT_EMAIL }], []]);

    await expect(
      changeMemberEmail(
        { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: "new@example.com", actor: ACTOR },
        db,
      ),
    ).rejects.toThrow("NotFound");
  });
});

describe("reInvite", () => {
  it("stamps a fresh invitedAt on an invited member (audited)", async () => {
    const previousInvite = new Date("2026-06-01T00:00:00Z");
    const { db, inserts, updates } = fakeDb([
      [memberRow({ status: "invited", invitedAt: previousInvite, activatedAt: null })],
    ]);

    const dto = await reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ status: "invited" });
    expect(updates[0].set.invitedAt).toBeInstanceOf(Date);
    expect((updates[0].set.invitedAt as Date).getTime()).toBeGreaterThan(previousInvite.getTime());

    expect(dto.status).toBe("invited");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "reinvite", entityId: MEMBER_ID });
  });

  it("moves a bounced member back to invited", async () => {
    const { db, updates } = fakeDb([
      [memberRow({ status: "bounced", invitedAt: new Date("2026-06-01T00:00:00Z"), activatedAt: null })],
    ]);

    const dto = await reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db);

    expect(updates[0].set).toMatchObject({ status: "invited" });
    expect(dto.status).toBe("invited");
  });

  it("throws Conflict for an active member (nothing to invite)", async () => {
    const { db } = fakeDb([[memberRow({ status: "active" })]]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
  });

  it("throws Conflict for a revoked member (must be re-added)", async () => {
    const { db } = fakeDb([[memberRow({ status: "revoked" })]]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
  });

  it("throws NotFound when the member row is missing", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db),
    ).rejects.toThrow("NotFound");
  });
});

describe("rejectStudentAsParent", () => {
  it("throws Conflict when a parent email matches the case's student email", async () => {
    const { db } = fakeDb([[{ studentEmail: STUDENT_EMAIL }]]);

    await expect(
      rejectStudentAsParent(
        { caseId: CASE_ID, parentEmails: ["mom@example.com", " ADA@Example.com "] },
        db,
      ),
    ).rejects.toThrow("Conflict");
  });

  it("resolves under adminOverride even when the email matches", async () => {
    const { db } = fakeDb([[{ studentEmail: STUDENT_EMAIL }]]);

    await expect(
      rejectStudentAsParent(
        { caseId: CASE_ID, parentEmails: [STUDENT_EMAIL], adminOverride: true },
        db,
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves when no parent email matches", async () => {
    const { db } = fakeDb([[{ studentEmail: STUDENT_EMAIL }]]);

    await expect(
      rejectStudentAsParent({ caseId: CASE_ID, parentEmails: ["mom@example.com"] }, db),
    ).resolves.toBeUndefined();
  });

  it("throws NotFound when the case is missing", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      rejectStudentAsParent({ caseId: CASE_ID, parentEmails: ["mom@example.com"] }, db),
    ).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(
      rejectStudentAsParent({ caseId: "nope", parentEmails: ["mom@example.com"] }, db),
    ).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});

describe("getActiveCaseMembers", () => {
  it("returns only status=active rows — a revoked member disappears immediately", async () => {
    const { db } = fakeDb([[
      memberRow({ id: "m1", email: "mom@example.com", status: "active" }),
      memberRow({ id: "m2", email: "gone@example.com", status: "revoked" }),
      memberRow({ id: "m3", email: "kid@example.com", status: "invited" }),
      memberRow({ id: "m4", email: "bounce@example.com", status: "bounced" }),
    ]]);

    const members = await getActiveCaseMembers(CASE_ID, db);

    expect(members.map((member) => member.id)).toEqual(["m1"]);
    expect(members[0].status).toBe("active");
  });

  it("fails closed to [] for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(getActiveCaseMembers("nope", db)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});
