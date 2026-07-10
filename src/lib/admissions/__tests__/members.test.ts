import { afterEach, describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the membership
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

// Invitation writes queue transactionally; stub the outbox boundary so the
// membership transaction and immediate post-commit kick are observable.
vi.mock("@/lib/admissions/notifications", () => ({
  deriveStudentFirstName: vi.fn((student: { preferredName?: string | null; fullName?: string }) =>
    student.preferredName || student.fullName?.split(/\s+/)[0] || "Student"),
  queueMemberInviteOutbox: vi.fn(async () => "88888888-8888-4888-8888-888888888888"),
  deliverAdmissionsOutboxBestEffort: vi.fn(async () => ({
    attempted: 1,
    sent: 1,
    skipped: 0,
    failed: 0,
    errors: [],
  })),
}));

import {
  admissionsAuditLog,
  admissionsCaseMembers,
  admissionsStudents,
} from "@/lib/db/schema";
import {
  deliverAdmissionsOutboxBestEffort,
  queueMemberInviteOutbox,
} from "@/lib/admissions/notifications";
import {
  activateMembershipsForEmail,
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
const MEMBER_UPDATED_AT = "2026-06-02T00:00:00.000Z";

const ACTOR = { email: "staff@example.com", role: "counselor" as const };

const queueInviteMock = vi.mocked(queueMemberInviteOutbox);
const deliverOutboxMock = vi.mocked(deliverAdmissionsOutboxBestEffort);

afterEach(() => {
  queueInviteMock.mockClear();
  deliverOutboxMock.mockClear();
});

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
function fakeDb(queue: unknown[][], options: { updateResults?: unknown[][] } = {}) {
  let i = 0;
  let generated = 0;
  let returnedUpdate = 0;
  const selectCalls: number[] = [];
  const lockCalls: string[] = [];
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  function selectBuilder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "groupBy", "limit"]) {
      b[method] = () => b;
    }
    b.for = (strength: string) => {
      lockCalls.push(strength);
      return b;
    };
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
        b.returning = () => Promise.resolve(
          options.updateResults?.[returnedUpdate++] ?? [{ id: MEMBER_ID }],
        );
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
  return { db: db as never, selectCalls, lockCalls, inserts, updates };
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
    const { db, inserts } = fakeDb([[
      {
        studentEmail: STUDENT_EMAIL,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        familyPortalOpen: true,
      },
    ], []]);

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

    expect(queueInviteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        caseId: CASE_ID,
        recipientEmail: "mom@example.com",
        studentFirstName: "Ada",
      }),
    );
    expect(deliverOutboxMock).toHaveBeenCalledWith(
      ["88888888-8888-4888-8888-888888888888"],
      db,
    );
  });

  it("adds a counselor as immediately active", async () => {
    const { db, inserts } = fakeDb([
      [{ studentEmail: STUDENT_EMAIL }],
      [{ id: "active-counselor" }],
      [],
    ]);

    await addMember(
      { caseId: CASE_ID, email: "new-staff@example.com", role: "counselor", actor: ACTOR },
      db,
    );

    const members = memberInserts(inserts);
    expect(members[0]).toMatchObject({ role: "counselor", status: "active" });
    expect(members[0].activatedAt).toBeInstanceOf(Date);
    expect(members[0].invitedAt).toBeNull();

    // Active counselor memberships never queue a family invite.
    expect(queueInviteMock).not.toHaveBeenCalled();
    expect(deliverOutboxMock).not.toHaveBeenCalled();
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
    const { db, inserts, lockCalls, updates } = fakeDb([[memberRow()]]);

    const dto = await revokeMember({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ status: "revoked" });
    expect(updates[0].set.revokedAt).toBeInstanceOf(Date);

    expect(dto.status).toBe("revoked");
    expect(dto.revokedAt).not.toBeNull();
    expect(lockCalls).toEqual(["update"]);

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

  it("does not revoke the case's sole student membership", async () => {
    const { db, updates } = fakeDb([[memberRow({ role: "student" })]]);

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

  it("does not audit when the conditional revoke loses a race", async () => {
    const { db, inserts } = fakeDb([[memberRow()]], { updateResults: [[]] });

    await expect(
      revokeMember({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR }, db),
    ).rejects.toThrow("Conflict");
    expect(auditInserts(inserts)).toHaveLength(0);
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

  it("queues the replacement family invite atomically when the portal is open", async () => {
    const { db } = fakeDb([
      [{
        studentEmail: STUDENT_EMAIL,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        familyPortalOpen: true,
      }],
      [memberRow()],
      [],
    ]);

    await changeMemberEmail(
      {
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        newEmail: "replacement@example.com",
        actor: ACTOR,
      },
      db,
    );

    expect(queueInviteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipientEmail: "replacement@example.com",
        studentFirstName: "Ada",
        dedupeKey: expect.stringContaining("member-invite:email-change:"),
      }),
    );
    expect(deliverOutboxMock).toHaveBeenCalledWith(
      ["88888888-8888-4888-8888-888888888888"],
      db,
    );
  });

  it("keeps the canonical student profile email aligned with a student membership change", async () => {
    const studentId = "77777777-7777-4777-8777-777777777777";
    const { db, inserts, updates } = fakeDb([
      [{
        studentId,
        studentEmail: STUDENT_EMAIL,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        familyPortalOpen: false,
      }],
      [memberRow({ role: "student", email: STUDENT_EMAIL })],
      [],
    ]);

    await changeMemberEmail(
      {
        caseId: CASE_ID,
        memberId: MEMBER_ID,
        newEmail: "new-ada@example.com",
        actor: ACTOR,
      },
      db,
    );

    const studentUpdate = updates.find((call) => call.table === admissionsStudents);
    expect(studentUpdate?.set).toMatchObject({ studentEmail: "new-ada@example.com" });
    expect(auditInserts(inserts)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "student",
        entityId: studentId,
        action: "email_change",
        diff: {
          studentEmail: { old: STUDENT_EMAIL, new: "new-ada@example.com" },
        },
      }),
    ]));
  });

  it("keeps a registry-validated counselor active after an email change", async () => {
    const { db, inserts } = fakeDb([
      [{ studentEmail: STUDENT_EMAIL }],
      [memberRow({ role: "counselor", email: "old-staff@example.com" })],
      [{ id: "active-counselor" }],
      [],
    ]);

    await changeMemberEmail(
      { caseId: CASE_ID, memberId: MEMBER_ID, newEmail: "new-staff@example.com", actor: ACTOR },
      db,
    );

    expect(memberInserts(inserts)[0]).toMatchObject({ role: "counselor", status: "active" });
    expect(queueInviteMock).not.toHaveBeenCalled();
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
      [{
        studentEmail: STUDENT_EMAIL,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        familyPortalOpen: true,
      }],
    ]);

    const dto = await reInvite({
      caseId: CASE_ID,
      memberId: MEMBER_ID,
      actor: ACTOR,
      expectedUpdatedAt: MEMBER_UPDATED_AT,
    }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ status: "invited" });
    expect(updates[0].set.invitedAt).toBeInstanceOf(Date);
    expect((updates[0].set.invitedAt as Date).getTime()).toBeGreaterThan(previousInvite.getTime());

    expect(dto.status).toBe("invited");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "reinvite", entityId: MEMBER_ID });

    expect(queueInviteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        memberId: MEMBER_ID,
        recipientEmail: "mom@example.com",
        dedupeKey: `member-invite:reinvite:${MEMBER_ID}:${MEMBER_UPDATED_AT}`,
      }),
    );
    expect(deliverOutboxMock).toHaveBeenCalledWith(
      ["88888888-8888-4888-8888-888888888888"],
      db,
    );
  });

  it("moves a bounced member back to invited", async () => {
    const { db, updates } = fakeDb([
      [memberRow({ status: "bounced", invitedAt: new Date("2026-06-01T00:00:00Z"), activatedAt: null })],
      [{
        studentEmail: STUDENT_EMAIL,
        fullName: "Ada Lovelace",
        preferredName: null,
        familyPortalOpen: true,
      }],
    ]);

    const dto = await reInvite({
      caseId: CASE_ID,
      memberId: MEMBER_ID,
      actor: ACTOR,
      expectedUpdatedAt: MEMBER_UPDATED_AT,
    }, db);

    expect(updates[0].set).toMatchObject({ status: "invited" });
    expect(dto.status).toBe("invited");
  });

  it("does not send an unusable invitation while the family portal is closed", async () => {
    const { db } = fakeDb([
      [memberRow({ status: "invited", activatedAt: null })],
      [{
        studentEmail: STUDENT_EMAIL,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        familyPortalOpen: false,
      }],
    ]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR, expectedUpdatedAt: MEMBER_UPDATED_AT }, db),
    ).rejects.toThrow("Conflict");
    expect(queueInviteMock).not.toHaveBeenCalled();
    expect(deliverOutboxMock).not.toHaveBeenCalled();
  });

  it("throws Conflict for an active member (nothing to invite)", async () => {
    const { db } = fakeDb([[memberRow({ status: "active" })]]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR, expectedUpdatedAt: MEMBER_UPDATED_AT }, db),
    ).rejects.toThrow("Conflict");
  });

  it("throws Conflict for a revoked member (must be re-added)", async () => {
    const { db } = fakeDb([[memberRow({ status: "revoked" })]]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR, expectedUpdatedAt: MEMBER_UPDATED_AT }, db),
    ).rejects.toThrow("Conflict");
  });

  it("throws NotFound when the member row is missing", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      reInvite({ caseId: CASE_ID, memberId: MEMBER_ID, actor: ACTOR, expectedUpdatedAt: MEMBER_UPDATED_AT }, db),
    ).rejects.toThrow("NotFound");
  });

  it("treats a retry of one committed re-invite action as an idempotent replay", async () => {
    const current = memberRow({
      status: "invited",
      activatedAt: null,
      updatedAt: new Date("2026-07-02T00:00:00Z"),
    });
    const { db, inserts, updates } = fakeDb([
      [current],
      [{ id: "existing-outbox-row" }],
    ]);

    const dto = await reInvite({
      caseId: CASE_ID,
      memberId: MEMBER_ID,
      actor: ACTOR,
      expectedUpdatedAt: MEMBER_UPDATED_AT,
    }, db);

    expect(dto.updatedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(updates).toHaveLength(0);
    expect(auditInserts(inserts)).toHaveLength(0);
    expect(queueInviteMock).not.toHaveBeenCalled();
    expect(deliverOutboxMock).not.toHaveBeenCalled();
  });

  it("rejects a stale re-invite token that has no matching outbox action", async () => {
    const { db } = fakeDb([
      [memberRow({ status: "invited", updatedAt: new Date("2026-07-02T00:00:00Z") })],
      [],
    ]);

    await expect(reInvite({
      caseId: CASE_ID,
      memberId: MEMBER_ID,
      actor: ACTOR,
      expectedUpdatedAt: MEMBER_UPDATED_AT,
    }, db)).rejects.toThrow("Conflict");
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

describe("activateMembershipsForEmail (PRD §3.7 exact-email activation)", () => {
  it("flips every invited/bounced membership to active with activatedAt + an 'activate' audit row", async () => {
    const invited = memberRow({
      id: "m1",
      email: "kid@example.com",
      role: "student",
      status: "invited",
      activatedAt: null,
    });
    const bounced = memberRow({
      id: "m2",
      caseId: "22222222-2222-4222-8222-222222222222",
      email: "kid@example.com",
      role: "parent",
      status: "bounced",
      activatedAt: null,
    });
    const { db, inserts, updates } = fakeDb([[invited, bounced]]);

    const activated = await activateMembershipsForEmail("Kid@Example.com ", db);

    expect(activated).toHaveLength(2);
    expect(activated.every((member) => member.status === "active")).toBe(true);
    expect(activated.every((member) => member.activatedAt !== null)).toBe(true);

    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.table).toBe(admissionsCaseMembers);
      expect(update.set).toMatchObject({ status: "active" });
      expect(update.set.activatedAt).toBeInstanceOf(Date);
    }

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorEmail: "kid@example.com",
      actorRole: "student",
      entityType: "case_member",
      entityId: "m1",
      action: "activate",
    });
    expect(audits[1]).toMatchObject({
      actorRole: "parent",
      entityId: "m2",
      action: "activate",
    });
  });

  it("no-ops without a transaction when the email has no invited/bounced rows", async () => {
    // Revoked and active rows are filtered by the WHERE — the select returns
    // nothing pending, so no update/audit writes happen at all.
    const { db, inserts, updates, selectCalls } = fakeDb([[]]);

    const activated = await activateMembershipsForEmail("mom@example.com", db);

    expect(activated).toEqual([]);
    expect(selectCalls).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("no-ops for an empty email without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(activateMembershipsForEmail("   ", db)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });

  it("audits and returns only memberships actually changed by the conditional update", async () => {
    const invited = memberRow({
      id: "m1",
      email: "kid@example.com",
      role: "student",
      status: "invited",
      activatedAt: null,
    });
    const { db, inserts } = fakeDb([[invited]], { updateResults: [[]] });

    await expect(activateMembershipsForEmail("kid@example.com", db)).resolves.toEqual([]);
    expect(auditInserts(inserts)).toHaveLength(0);
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
