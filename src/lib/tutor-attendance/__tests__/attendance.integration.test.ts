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
