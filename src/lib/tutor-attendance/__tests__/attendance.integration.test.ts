import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { attendanceAccessForEmail, type AttendanceAccess } from "../access";
import { attendanceCsv, attendanceOverview } from "../data";
import {
  recordAttendancePunch,
  requestAttendanceCorrection,
  reviewAttendanceCorrection,
  saveAttendanceSettings,
  requestAttendanceWfh,
  decideAttendanceWfh,
} from "../service";
import { DEFAULT_WEEK, instant } from "../model";

let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
let a: AttendanceAccess, b: AttendanceAccess, admin: AttendanceAccess;
const date = "2026-09-14",
  office = "8.8.8.8";
const now = (time: string) => instant(date, time);
const punch = (kind: "in" | "out", idempotencyKey = crypto.randomUUID()) => ({
  kind,
  date,
  idempotencyKey,
});

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.stubEnv("TUTOR_ATTENDANCE_ENABLED", "true");
  await db.execute(
    sql`TRUNCATE tutor_attendance_audit, tutor_attendance_corrections, tutor_attendance_days, tutor_attendance_exceptions, tutor_attendance_schedules, tutor_attendance_enrollments, tutor_attendance_config, tutor_contacts, admin_users CASCADE`,
  );
  await db.insert(s.tutorContacts).values([
    {
      canonicalKey: "a",
      displayName: "Tutor A",
      onsiteEmail: "a-original@example.test",
    },
    {
      canonicalKey: "b",
      displayName: "Tutor B",
      onsiteEmail: "b@example.test",
    },
    {
      canonicalKey: "part-time",
      displayName: "Part time tutor",
      onsiteEmail: "part@example.test",
    },
  ]);
  await db.insert(s.adminUsers).values([
    { email: "admin@example.test", allowedPages: ["/tutor-attendance"] },
    { email: "other-admin@example.test", allowedPages: ["/search"] },
  ]);
  await db.insert(s.tutorAttendanceEnrollments).values([
    { canonicalKey: "a", loginEmail: "a-google@example.test", startDate: date },
    { canonicalKey: "b", loginEmail: "b@example.test", startDate: date },
  ]);
  await db.insert(s.tutorAttendanceSchedules).values([
    { canonicalKey: "a", effectiveFrom: date, week: DEFAULT_WEEK, revision: 1 },
    { canonicalKey: "b", effectiveFrom: date, week: DEFAULT_WEEK, revision: 1 },
  ]);
  await db
    .insert(s.tutorAttendanceConfig)
    .values({ networks: [{ label: "Office", cidr: office }], revision: 1 });
  a = await attendanceAccessForEmail("a-google@example.test", db);
  b = await attendanceAccessForEmail("b@example.test", db);
  admin = await attendanceAccessForEmail("admin@example.test", db);
});
describe("office attendance transactions", () => {
  it("records one pair across duplicate taps, competing devices and replay after response loss", async () => {
    const input = punch("in");
    await Promise.all([
      recordAttendancePunch(a, input, office, db, now("10:01")),
      recordAttendancePunch(a, punch("in"), office, db, now("10:01")),
    ]);
    await recordAttendancePunch(a, input, null, db, now("11:00"));
    await recordAttendancePunch(a, punch("out"), office, db, now("15:59"));
    const [day] = await db.select().from(s.tutorAttendanceDays);
    expect(day).toMatchObject({
      recordedIn: now("10:01"),
      recordedOut: now("15:59"),
      revision: 2,
    });
    const result = await attendanceOverview(
      a,
      { start: date, end: date },
      office,
      db,
      now("17:00"),
    );
    expect(result.rows[0]).toMatchObject({
      lateMinutes: 1,
      earlyMinutes: 1,
      spanMinutes: 358,
    });
    await expect(
      recordAttendancePunch(
        a,
        { ...input, kind: "out" },
        office,
        db,
        now("17:00"),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("fails closed offsite, while disabled, outside enrollment and after midnight", async () => {
    await expect(
      recordAttendancePunch(a, punch("in"), "1.1.1.1", db, now("10:00")),
    ).rejects.toMatchObject({ code: "OFFICE_NETWORK_REQUIRED" });
    vi.stubEnv("TUTOR_ATTENDANCE_ENABLED", "false");
    await expect(
      recordAttendancePunch(a, punch("in"), office, db, now("10:00")),
    ).rejects.toMatchObject({ code: "CLOCKING_DISABLED" });
    vi.stubEnv("TUTOR_ATTENDANCE_ENABLED", "true");
    await expect(
      recordAttendancePunch(
        a,
        punch("in"),
        office,
        db,
        instant("2026-09-15", "00:01"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(s.tutorAttendanceDays)).toHaveLength(0);
  });
  it("keeps missing departures incomplete and permits the next day's independent arrival", async () => {
    await recordAttendancePunch(a, punch("in"), office, db, now("10:00"));
    await recordAttendancePunch(
      a,
      { ...punch("in"), date: "2026-09-15" },
      office,
      db,
      instant("2026-09-15", "10:00"),
    );
    const result = await attendanceOverview(
      a,
      { start: date, end: "2026-09-15" },
      office,
      db,
      instant("2026-09-15", "12:00"),
    );
    expect(result.rows.find((r) => r.date === date)).toMatchObject({
      status: "missing_out",
      spanMinutes: null,
      clockOut: null,
    });
  });
  it("records departure evidence even when arrival was forgotten", async () => {
    await recordAttendancePunch(a, punch("out"), office, db, now("16:00"));
    expect(
      (
        await attendanceOverview(
          a,
          { start: date, end: date },
          office,
          db,
          now("17:00"),
        )
      ).rows[0],
    ).toMatchObject({ status: "missing_in", clockIn: null, spanMinutes: null });
  });
  it("allows offsite corrections while paused, preserving raw evidence after approval", async () => {
    await recordAttendancePunch(a, punch("in"), office, db, now("10:30"));
    vi.stubEnv("TUTOR_ATTENDANCE_ENABLED", "false");
    const input = {
      date,
      proposedIn: "10:00",
      proposedOut: "16:00",
      reason: "Forgot arrival and departure",
      expectedRevision: 1,
      idempotencyKey: crypto.randomUUID(),
    };
    const request = await requestAttendanceCorrection(
      a,
      input,
      db,
      now("17:00"),
    );
    expect(
      await requestAttendanceCorrection(a, input, db, now("17:30")),
    ).toEqual(request);
    await reviewAttendanceCorrection(
      admin,
      request.id,
      {
        decision: "approved",
        reason: "Confirmed with office roster",
        expectedRevision: 1,
      },
      db,
      now("18:00"),
    );
    const [day] = await db.select().from(s.tutorAttendanceDays);
    expect(day).toMatchObject({
      recordedIn: now("10:30"),
      recordedOut: null,
      effectiveIn: now("10:00"),
      effectiveOut: now("16:00"),
      corrected: true,
      revision: 2,
    });
    const overview = await attendanceOverview(
      a,
      { start: date, end: date },
      null,
      db,
      now("18:00"),
    );
    expect(overview.corrections[0]).toMatchObject({
      recordedIn: now("10:30").toISOString(),
      recordedOut: null,
      currentIn: now("10:00").toISOString(),
      currentOut: now("16:00").toISOString(),
      currentRevision: 2,
    });
    expect(
      (await db.select().from(s.tutorAttendanceAudit)).map((r) => r.action),
    ).toContain("correction_approved");
    await expect(
      db.execute(sql`UPDATE tutor_attendance_audit SET action = 'changed'`),
    ).rejects.toThrow();
  });
  it("rejects stale approval after a new punch; rejection remains possible without altering times", async () => {
    await recordAttendancePunch(a, punch("in"), office, db, now("10:30"));
    const request = await requestAttendanceCorrection(
      a,
      {
        date,
        proposedIn: "10:00",
        proposedOut: null,
        reason: "Forgot arrival",
        expectedRevision: 1,
        idempotencyKey: crypto.randomUUID(),
      },
      db,
      now("11:00"),
    );
    await recordAttendancePunch(a, punch("out"), office, db, now("16:00"));
    await expect(
      reviewAttendanceCorrection(
        admin,
        request.id,
        {
          decision: "approved",
          reason: "Reviewed record",
          expectedRevision: 2,
        },
        db,
        now("17:00"),
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    await reviewAttendanceCorrection(
      admin,
      request.id,
      {
        decision: "rejected",
        reason: "Submit updated departure too",
        expectedRevision: 2,
      },
      db,
      now("17:00"),
    );
    expect(
      (await db.select().from(s.tutorAttendanceDays))[0].effectiveIn,
    ).toEqual(now("10:30"));
  });
  it("rejects future corrections and stale correction submissions", async () => {
    const correction = {
      date,
      proposedIn: "10:00",
      proposedOut: "16:00",
      reason: "Forgot clocking",
      expectedRevision: 0,
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(
      requestAttendanceCorrection(a, correction, db, now("11:00")),
    ).rejects.toMatchObject({ status: 400 });
    await recordAttendancePunch(a, punch("in"), office, db, now("10:00"));
    await expect(
      requestAttendanceCorrection(a, correction, db, now("17:00")),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
  });
  it("isolates tutors and rejects unknown, unenrolled, revoked and restricted admin identities", async () => {
    await recordAttendancePunch(b, punch("in"), office, db, now("10:00"));
    const own = await attendanceOverview(
      a,
      { start: date, end: date, canonicalKey: "b" },
      null,
      db,
      now("11:00"),
    );
    expect(own.rows.every((r) => r.canonicalKey === "a")).toBe(true);
    for (const email of [
      "part@example.test",
      "a-original@example.test",
      "other-admin@example.test",
      "stranger@example.test",
    ])
      await expect(attendanceAccessForEmail(email, db)).rejects.toMatchObject({
        status: 403,
      });
    await db
      .update(s.tutorAttendanceEnrollments)
      .set({ active: false })
      .where(eq(s.tutorAttendanceEnrollments.canonicalKey, "a"));
    await expect(
      attendanceOverview(a, {}, null, db, now("11:00")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      recordAttendancePunch(a, punch("in"), office, db, now("11:00")),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks current admin version and permission on writes", async () => {
    await db
      .update(s.adminUsers)
      .set({ accessVersion: 1 })
      .where(eq(s.adminUsers.email, admin.email));
    await expect(
      saveAttendanceSettings(
        admin,
        {
          action: "networks",
          networks: [],
          verifiedOfficeConnection: true,
          reason: "Remove office network",
          expectedRevision: 1,
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("applies network revocation and rejects competing setup edits", async () => {
    await saveAttendanceSettings(
      admin,
      {
        action: "networks",
        networks: [],
        verifiedOfficeConnection: true,
        reason: "Office connection changed",
        expectedRevision: 1,
      },
      db,
      now("09:00"),
    );
    await expect(
      recordAttendancePunch(a, punch("in"), office, db, now("10:00")),
    ).rejects.toMatchObject({ code: "OFFICE_NETWORK_REQUIRED" });
    await expect(
      saveAttendanceSettings(
        admin,
        {
          action: "networks",
          networks: [{ label: "Old", cidr: office }],
          verifiedOfficeConnection: true,
          reason: "Stale browser update",
          expectedRevision: 1,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
  });
  it("versions individual schedules and auditable retrospective exceptions", async () => {
    await saveAttendanceSettings(
      admin,
      {
        action: "schedule",
        canonicalKey: "a",
        effectiveFrom: "2026-09-21",
        week: DEFAULT_WEEK.map((w) =>
          w ? { start: "11:00", end: "17:00" } : null,
        ),
        reason: "New working agreement",
        expectedRevision: 1,
      },
      db,
      now("09:00"),
    );
    const before = await attendanceOverview(
      admin,
      { start: date, end: "2026-09-21" },
      office,
      db,
      instant("2026-09-21", "18:00"),
    );
    expect(
      before.rows.find((r) => r.canonicalKey === "a" && r.date === date)
        ?.requirement,
    ).toMatchObject({ start: "10:00" });
    expect(
      before.rows.find((r) => r.canonicalKey === "a" && r.date === "2026-09-21")
        ?.requirement,
    ).toMatchObject({ start: "11:00" });
    await saveAttendanceSettings(
      admin,
      {
        action: "exception",
        canonicalKey: "a",
        date,
        kind: "excused",
        start: null,
        end: null,
        reason: "Approved sick leave",
        expectedRevision: 2,
      },
      db,
      instant("2026-09-21", "18:00"),
    );
    expect(
      (
        await attendanceOverview(
          a,
          { start: date, end: date },
          office,
          db,
          now("18:00"),
        )
      ).rows[0].status,
    ).toBe("excused");
    await expect(
      saveAttendanceSettings(
        admin,
        {
          action: "schedule",
          canonicalKey: "a",
          effectiveFrom: date,
          week: DEFAULT_WEEK,
          reason: "Retroactive recurring change",
          expectedRevision: 3,
        },
        db,
        instant("2026-09-21", "18:00"),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("exports complete and incomplete records without spreadsheet formula injection", async () => {
    await db
      .update(s.tutorContacts)
      .set({ displayName: "=DANGEROUS()" })
      .where(eq(s.tutorContacts.canonicalKey, "a"));
    await recordAttendancePunch(a, punch("in"), office, db, now("10:00"));
    const report = await attendanceOverview(
      admin,
      { start: date, end: date },
      null,
      db,
      now("17:00"),
    );
    const csv = attendanceCsv(report);
    expect(csv).toContain("'=DANGEROUS()");
    expect(csv).toContain("includes breaks");
    expect(
      report.rows.find((r) => r.canonicalKey === "a")?.spanMinutes,
    ).toBeNull();
  });
});

describe("approved WFH attendance", () => {
  const requestInput = (requestedDate = date) => ({
    date: requestedDate,
    reason: "Working from home today",
    idempotencyKey: crypto.randomUUID(),
  });
  const decision = (
    value: "approved" | "rejected" | "cancelled",
    expectedRevision = 0,
  ) => ({
    decision: value,
    expectedRevision,
    reason: "Reviewed working arrangement",
  });
  async function approve() {
    const request = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:00"),
    );
    await decideAttendanceWfh(
      admin,
      request.id,
      decision("approved"),
      db,
      now("09:30"),
    );
    return request;
  }
  it("requires approval for remote punches and keeps the usual hours, evidence and CSV", async () => {
    const request = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:00"),
    );
    for (const kind of ["in", "out"] as const)
      await expect(
        recordAttendancePunch(a, punch(kind), null, db, now("10:00")),
      ).rejects.toMatchObject({ code: "OFFICE_NETWORK_REQUIRED" });
    expect(await db.select().from(s.tutorAttendanceDays)).toHaveLength(0);
    await decideAttendanceWfh(
      admin,
      request.id,
      decision("approved"),
      db,
      now("09:30"),
    );
    const before = await attendanceOverview(
      a,
      { start: date, end: date },
      null,
      db,
      now("09:40"),
    );
    expect(before.network.approved).toBe(false);
    expect(before.clockingAllowed).toBe(true);
    expect(before.rows[0]).toMatchObject({
      workMode: "wfh",
      wfhRequestId: request.id,
      requirement: { start: "10:00", end: "16:00" },
    });
    const input = punch("in");
    await Promise.all([
      recordAttendancePunch(a, input, null, db, now("10:01")),
      recordAttendancePunch(a, punch("in"), "1.1.1.1", db, now("10:01")),
    ]);
    await recordAttendancePunch(a, input, null, db, now("11:00"));
    await recordAttendancePunch(a, punch("out"), null, db, now("15:59"));
    const report = await attendanceOverview(
      a,
      { start: date, end: date },
      null,
      db,
      now("17:00"),
    );
    expect(report.rows[0]).toMatchObject({
      workMode: "wfh",
      lateMinutes: 1,
      earlyMinutes: 1,
      spanMinutes: 358,
      revision: 3,
    });
    expect(attendanceCsv(report)).toContain(`"WFH","${request.id}"`);
    const audit = await db
      .select()
      .from(s.tutorAttendanceAudit)
      .where(eq(s.tutorAttendanceAudit.action, "clock_in"));
    expect(audit[0].data).toMatchObject({
      workMode: "wfh",
      wfhRequestId: request.id,
      authorization: "approved_wfh",
    });
    expect(report.wfhRequests[0].canCancel).toBe(false);
  });
  it("makes requests and decisions safe to retry, with one active request per date", async () => {
    const input = requestInput();
    const results = await Promise.all([
      requestAttendanceWfh(a, input, db, now("09:00")),
      requestAttendanceWfh(a, input, db, now("09:00")),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(
      requestAttendanceWfh(a, requestInput(), db, now("09:00")),
    ).rejects.toMatchObject({ code: "WFH_REQUEST_EXISTS" });
    await expect(
      requestAttendanceWfh(
        a,
        { ...input, reason: "Changed reason" },
        db,
        now("09:00"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await decideAttendanceWfh(
      admin,
      results[0].id,
      decision("approved"),
      db,
      now("09:30"),
    );
    expect(
      await decideAttendanceWfh(
        admin,
        results[0].id,
        decision("approved"),
        db,
        now("09:35"),
      ),
    ).toMatchObject({ replayed: true });
    await expect(
      decideAttendanceWfh(
        admin,
        results[0].id,
        decision("rejected"),
        db,
        now("09:40"),
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(await db.select().from(s.tutorAttendanceWfhRequests)).toHaveLength(
      1,
    );
  });
  it("cancels unused approval, preserves its review history and restores the office guard", async () => {
    const request = await approve();
    await decideAttendanceWfh(
      a,
      request.id,
      decision("cancelled", 1),
      db,
      now("09:40"),
    );
    expect(
      await decideAttendanceWfh(
        a,
        request.id,
        decision("cancelled", 1),
        db,
        now("09:45"),
      ),
    ).toMatchObject({ replayed: true });
    const report = await attendanceOverview(
      a,
      { start: date, end: date },
      null,
      db,
      now("09:50"),
    );
    expect(report.rows[0]).toMatchObject({
      workMode: "office",
      wfhRequestId: null,
      revision: 2,
    });
    expect(report.wfhRequests[0]).toMatchObject({
      status: "cancelled",
      reviewedBy: admin.email,
      cancelledBy: a.email,
    });
    expect(report.clockingAllowed).toBe(false);
    await expect(
      recordAttendancePunch(a, punch("in"), null, db, now("10:00")),
    ).rejects.toMatchObject({ code: "OFFICE_NETWORK_REQUIRED" });
    await requestAttendanceWfh(a, requestInput(), db, now("10:00"));
    expect(await db.select().from(s.tutorAttendanceWfhRequests)).toHaveLength(
      2,
    );
  });
  it("allows rejection or withdrawal of pending requests without granting remote access", async () => {
    const rejected = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:00"),
    );
    await decideAttendanceWfh(
      admin,
      rejected.id,
      decision("rejected"),
      db,
      now("09:20"),
    );
    const withdrawn = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:30"),
    );
    await decideAttendanceWfh(
      a,
      withdrawn.id,
      decision("cancelled"),
      db,
      now("09:40"),
    );
    await expect(
      recordAttendancePunch(a, punch("in"), null, db, now("10:00")),
    ).rejects.toMatchObject({ code: "OFFICE_NETWORK_REQUIRED" });
    await expect(
      decideAttendanceWfh(
        admin,
        withdrawn.id,
        decision("approved"),
        db,
        now("10:00"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const audit = await db.select().from(s.tutorAttendanceAudit);
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "wfh_requested",
        "wfh_rejected",
        "wfh_cancelled",
      ]),
    );
  });
  it("never relabels an office punch or revokes a WFH day after attendance starts", async () => {
    const pending = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:00"),
    );
    await recordAttendancePunch(a, punch("in"), office, db, now("10:00"));
    await expect(
      decideAttendanceWfh(
        admin,
        pending.id,
        decision("approved"),
        db,
        now("10:10"),
      ),
    ).rejects.toMatchObject({ code: "WORK_LOCATION_LOCKED" });
    await decideAttendanceWfh(
      admin,
      pending.id,
      decision("rejected"),
      db,
      now("10:10"),
    );
    await expect(
      requestAttendanceWfh(a, requestInput(), db, now("10:20")),
    ).rejects.toMatchObject({ code: "WORK_LOCATION_LOCKED" });
    const other = await requestAttendanceWfh(
      b,
      requestInput(),
      db,
      now("09:00"),
    );
    await decideAttendanceWfh(
      admin,
      other.id,
      decision("approved"),
      db,
      now("09:20"),
    );
    await recordAttendancePunch(b, punch("out"), null, db, now("16:00"));
    for (const actor of [b, admin])
      await expect(
        decideAttendanceWfh(
          actor,
          other.id,
          decision("cancelled", 1),
          db,
          now("16:10"),
        ),
      ).rejects.toMatchObject({ code: "WORK_LOCATION_LOCKED" });
    const report = await attendanceOverview(
      b,
      { start: date, end: date },
      null,
      db,
      now("17:00"),
    );
    expect(report.rows[0]).toMatchObject({
      workMode: "wfh",
      status: "missing_in",
      spanMinutes: null,
    });
  });
  it("serializes cancellation against a remote punch so only one can succeed", async () => {
    const request = await approve();
    const results = await Promise.allSettled([
      decideAttendanceWfh(
        a,
        request.id,
        decision("cancelled", 1),
        db,
        now("10:00"),
      ),
      recordAttendancePunch(a, punch("in"), null, db, now("10:00")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [day] = await db.select().from(s.tutorAttendanceDays);
    const [savedRequest] = await db.select().from(s.tutorAttendanceWfhRequests);
    if (day.recordedIn) {
      expect(day.workMode).toBe("wfh");
      expect(savedRequest.status).toBe("approved");
    } else {
      expect(day.workMode).toBe("office");
      expect(savedRequest.status).toBe("cancelled");
    }
  });
  it("isolates requests and blocks self-approval including enrolled administrators", async () => {
    const request = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:00"),
    );
    await expect(
      decideAttendanceWfh(
        b,
        request.id,
        decision("cancelled"),
        db,
        now("09:10"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      decideAttendanceWfh(
        a,
        request.id,
        decision("approved"),
        db,
        now("09:10"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const own = await attendanceOverview(
      b,
      { canonicalKey: "a" },
      null,
      db,
      now("10:00"),
    );
    expect(own.wfhRequests).toEqual([]);
    await db
      .insert(s.adminUsers)
      .values({ email: a.email, allowedPages: ["/tutor-attendance"] });
    const enrolledAdmin = await attendanceAccessForEmail(a.email, db);
    await expect(
      decideAttendanceWfh(
        enrolledAdmin,
        request.id,
        decision("approved"),
        db,
        now("09:10"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .update(s.tutorAttendanceEnrollments)
      .set({ loginEmail: "new-a@example.test" })
      .where(eq(s.tutorAttendanceEnrollments.canonicalKey, "a"));
    await db
      .insert(s.adminUsers)
      .values({
        email: "new-a@example.test",
        allowedPages: ["/tutor-attendance"],
      });
    const reboundAdmin = await attendanceAccessForEmail(
      "new-a@example.test",
      db,
    );
    await expect(
      decideAttendanceWfh(
        reboundAdmin,
        request.id,
        decision("approved"),
        db,
        now("09:20"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const report = await attendanceOverview(
      reboundAdmin,
      {},
      null,
      db,
      now("09:20"),
    );
    expect(report.wfhRequests[0].canApprove).toBe(false);
  });
  it("rechecks reviewer permissions and the requested tutor's active enrollment", async () => {
    const request = await requestAttendanceWfh(
      a,
      requestInput(),
      db,
      now("09:00"),
    );
    await db
      .update(s.adminUsers)
      .set({ accessVersion: 1 })
      .where(eq(s.adminUsers.email, admin.email));
    await expect(
      decideAttendanceWfh(
        admin,
        request.id,
        decision("approved"),
        db,
        now("09:10"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    admin = await attendanceAccessForEmail(admin.email, db);
    await db
      .update(s.tutorContacts)
      .set({ active: false })
      .where(eq(s.tutorContacts.canonicalKey, "a"));
    await expect(
      decideAttendanceWfh(
        admin,
        request.id,
        decision("approved"),
        db,
        now("09:20"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const report = await attendanceOverview(admin, {}, null, db, now("09:20"));
    expect(report.wfhRequests[0]).toMatchObject({
      canApprove: false,
      canReject: true,
    });
  });
  it("supports requests while paused, but the global switch still blocks WFH punches", async () => {
    vi.stubEnv("TUTOR_ATTENDANCE_ENABLED", "false");
    await approve();
    await expect(
      recordAttendancePunch(a, punch("in"), null, db, now("10:00")),
    ).rejects.toMatchObject({ code: "CLOCKING_DISABLED" });
    expect(
      (await attendanceOverview(a, {}, null, db, now("10:00"))).clockingAllowed,
    ).toBe(false);
  });
  it("keeps an approved day visible but disables clocking if enrollment dates change", async () => {
    await approve();
    await db
      .update(s.tutorAttendanceEnrollments)
      .set({ startDate: "2026-09-15" })
      .where(eq(s.tutorAttendanceEnrollments.canonicalKey, "a"));
    const report = await attendanceOverview(
      a,
      { start: date, end: date },
      null,
      db,
      now("10:00"),
    );
    expect(report.rows[0].workMode).toBe("wfh");
    expect(report.clockingAllowed).toBe(false);
    await expect(
      recordAttendancePunch(a, punch("in"), null, db, now("10:00")),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("uses Bangkok dates, shows future requests, and does not carry approval into the next day", async () => {
    const tomorrow = "2026-09-15";
    await approve();
    await requestAttendanceWfh(a, requestInput(tomorrow), db, now("11:00"));
    const report = await attendanceOverview(
      a,
      { start: date, end: date },
      null,
      db,
      now("11:00"),
    );
    expect(report.wfhRequests.some((r) => r.date === tomorrow)).toBe(true);
    await expect(
      recordAttendancePunch(
        a,
        { ...punch("in"), date: tomorrow },
        null,
        db,
        instant(tomorrow, "10:00"),
      ),
    ).rejects.toMatchObject({ code: "OFFICE_NETWORK_REQUIRED" });
    await expect(
      requestAttendanceWfh(b, requestInput(), db, instant(tomorrow, "00:00")),
    ).rejects.toMatchObject({ code: "WFH_DATE_PASSED" });
    const pending = report.wfhRequests.find((r) => r.date === tomorrow)!;
    await expect(
      decideAttendanceWfh(
        admin,
        pending.id,
        decision("approved"),
        db,
        instant("2026-09-16", "00:00"),
      ),
    ).rejects.toMatchObject({ code: "WFH_DATE_PASSED" });
    await decideAttendanceWfh(
      admin,
      pending.id,
      decision("rejected"),
      db,
      instant("2026-09-16", "00:00"),
    );
  });
  it("preserves WFH and raw punches through corrections, and blocks stale corrections after approval", async () => {
    const correction = await requestAttendanceCorrection(
      a,
      {
        date,
        proposedIn: "09:00",
        proposedOut: null,
        reason: "Forgot clocking in",
        expectedRevision: 0,
        idempotencyKey: crypto.randomUUID(),
      },
      db,
      now("09:10"),
    );
    const request = await approve();
    await expect(
      reviewAttendanceCorrection(
        admin,
        correction.id,
        { ...decision("approved", 1) },
        db,
        now("09:40"),
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    await reviewAttendanceCorrection(
      admin,
      correction.id,
      decision("rejected", 1),
      db,
      now("09:40"),
    );
    await recordAttendancePunch(a, punch("in"), null, db, now("10:30"));
    const fixed = await requestAttendanceCorrection(
      a,
      {
        date,
        proposedIn: "10:00",
        proposedOut: "16:00",
        reason: "Correct the missed working times",
        expectedRevision: 2,
        idempotencyKey: crypto.randomUUID(),
      },
      db,
      now("17:00"),
    );
    await reviewAttendanceCorrection(
      admin,
      fixed.id,
      decision("approved", 2),
      db,
      now("17:10"),
    );
    const [day] = await db.select().from(s.tutorAttendanceDays);
    expect(day).toMatchObject({
      workMode: "wfh",
      wfhRequestId: request.id,
      recordedIn: now("10:30"),
      effectiveIn: now("10:00"),
      effectiveOut: now("16:00"),
      corrected: true,
    });
  });
  it("leaves office closures and dated hour overrides in effect on WFH days", async () => {
    await approve();
    await saveAttendanceSettings(
      admin,
      {
        action: "exception",
        canonicalKey: "a",
        date,
        kind: "hours",
        start: "11:00",
        end: "17:00",
        reason: "Agreed working hours",
        expectedRevision: 1,
      },
      db,
      now("09:00"),
    );
    let report = await attendanceOverview(a, {}, null, db, now("12:00"));
    expect(report.rows[0]).toMatchObject({
      workMode: "wfh",
      requirement: { start: "11:00", end: "17:00" },
    });
    await saveAttendanceSettings(
      admin,
      {
        action: "exception",
        canonicalKey: null,
        date,
        kind: "excused",
        start: null,
        end: null,
        reason: "Office holiday",
        expectedRevision: 2,
      },
      db,
      now("09:00"),
    );
    report = await attendanceOverview(a, {}, null, db, now("12:00"));
    expect(report.rows[0]).toMatchObject({
      workMode: "wfh",
      status: "excused",
    });
  });
});
