import { randomUUID } from "node:crypto";
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
import { accessForEmail, resolveObserver } from "../access";
import {
  bookObservation,
  assignmentCommand,
  saveReport,
  acknowledgeCommunication,
  refreshQuarter,
  overview,
} from "../service";
import {
  generateAssignments,
  invalidateObservation,
  claimJob,
  detail,
  withObserverOperation,
  getAssignment,
  listAssignments,
} from "../repository";
import { EMPTY_REPORT, RUBRIC } from "../rubric";
import {
  type Lesson,
  HEADS,
  titleScopes,
  titleDepartments,
  SitInError,
} from "../model";
import { readFileSync } from "node:fs";
import { decryptToken, encryptToken } from "@/lib/sales-dashboard/google-oauth";
import {
  CALENDAR_SCOPES,
  finishCalendarOAuth,
  calendarProvider,
  calendarConnection,
  disconnectCalendar,
  beginCalendarOAuth,
  verifyOAuthState,
} from "../calendar";
import { MICROSOFT_SCOPES, OBSERVATION_PROPERTY } from "../calendar-microsoft";
import {
  processJobs,
  eventMatches,
  observationEmail,
  reconcileObservation,
  runSitInWorker,
} from "../worker";
import {
  loadSources,
  suggestionsFor,
  verifyLiveLesson,
  type Sources,
} from "../sources";
vi.mock("../sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources")>()),
  loadSources: vi.fn(),
  suggestionsFor: vi.fn(),
  verifyLiveLesson: vi.fn(),
}));
let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const email = HEADS[0].email,
  manager = "manager@example.test";
const now = new Date("2026-10-01T00:00:00Z");
const lesson: Lesson = {
  id: "wise-lesson",
  classId: "wise-class",
  tutorKey: "target",
  tutorName: "Test Tutor",
  title: "Physics and Maths",
  start: "2026-10-05T03:00:00Z",
  end: "2026-10-05T04:00:00Z",
  status: "UPCOMING",
  location: "Test Room",
  modality: "onsite",
  departments: ["physics", "maths"],
  participants: [
    {
      studentKey: "learner-one",
      studentName: "Test Learner",
      familyKey: "family-one",
      parentName: "Test Parent",
    },
    {
      studentKey: "learner-two",
      studentName: "Second Learner",
      familyKey: "family-two",
      parentName: "Second Parent",
    },
  ],
};
const sources = {
  lessons: [lesson],
  accounts: [],
  contacts: [],
  mappings: [],
} as unknown as Sources;
beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (handle) await stopTestDb(handle);
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("TUTOR_SIT_INS_ENABLED", "true");
  vi.stubEnv("TUTOR_SIT_INS_DELIVERY_ENABLED", "true");
  vi.stubEnv("TUTOR_SIT_INS_MICROSOFT_ENABLED", "true");
  vi.stubEnv("TUTOR_SIT_INS_MICROSOFT_CLIENT_ID", "ms-client");
  vi.stubEnv("TUTOR_SIT_INS_MICROSOFT_CLIENT_SECRET", "ms-secret");
  vi.stubEnv("VERCEL_ENV", "development");
  vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
  vi.stubEnv("AUTH_SECRET", "test-only-sit-in-encryption-key");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-secret");
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  await db.execute(
    sql`TRUNCATE tutor_sit_in_assignments, tutor_sit_in_grants, tutor_sit_in_calendar_connections, tutor_sit_in_audit, tutor_sit_in_mappings, tutor_sit_in_worker_state, tutor_contacts, admin_users RESTART IDENTITY CASCADE`,
  );
  await db.insert(s.adminUsers).values({ email: manager, allowedPages: null });
  await db.insert(s.tutorContacts).values([
    { canonicalKey: "head", displayName: "Head" },
    {
      canonicalKey: "target",
      displayName: "Test Tutor",
      onsiteEmail: "tutor@example.test",
    },
  ]);
  await db.insert(s.tutorSitInGrants).values({
    email,
    canonicalKey: "head",
    departments: ["physics", "maths", "iseb"],
  });
  await db.insert(s.tutorSitInCalendarConnections).values({
    email,
    googleEmail: email,
    googleSubject: "google-head",
    accessTokenCiphertext: encryptToken("test-token")!,
    expiresAt: new Date("2027-01-01"),
    scope: CALENDAR_SCOPES.join(" "),
  });
  vi.mocked(loadSources).mockResolvedValue(sources);
  vi.mocked(suggestionsFor).mockResolvedValue([]);
  vi.mocked(verifyLiveLesson).mockImplementation(async (_a, proposed) => ({
    observer: {
      ...(await accessForEmail(email, db)),
      canonicalKey: "head",
      name: "Head",
    },
    lesson: {
      ...proposed,
      modality:
        proposed.modality === "online"
          ? ("online" as const)
          : ("onsite" as const),
    },
  }));
});
async function obligation(department = "physics", tutor = "target") {
  const [row] = await db
    .insert(s.tutorSitInAssignments)
    .values({
      quarter: "2026-Q4",
      department,
      canonicalKey: tutor,
      tutorName: "Test Tutor",
      observerEmail: email,
    })
    .returning();
  return row;
}
async function booking() {
  const a = await obligation();
  const result = await bookObservation(
    await accessForEmail(email, db),
    a.id,
    { sessionId: lesson.id, expectedRevision: 0 },
    db,
  );
  return {
    assignment: result.assignment,
    observation: result.observations[0],
    report: result.reports[0],
  };
}
async function bindRecordedEvent(
  observation: typeof s.tutorSitInObservations.$inferSelect,
  provider: "google" | "microsoft" = "google",
) {
  const [bound] = await db
    .update(s.tutorSitInObservations)
    .set({
      calendarProvider: provider,
      calendarAccountId:
        provider === "google" ? "google-head" : "microsoft-head",
      calendarId: provider === "google" ? "head-calendar" : "Primary/Case+ID",
      eventId:
        provider === "google"
          ? observation.id.replaceAll("-", "")
          : "Immutable+ID/Case",
      calendarAttemptedAt: now,
      calendarSyncedAt: now,
      calendarStatus: "synced",
      lesson: { ...observation.lesson, tutorEmail: "tutor@example.test" },
    })
    .where(eq(s.tutorSitInObservations.id, observation.id))
    .returning();
  return bound;
}
const googleList = () =>
  Response.json({
    items: [
      {
        id: "head-calendar",
        summary: "Primary",
        primary: true,
        accessRole: "owner",
      },
    ],
  });
describe("database-enforced QA workflow", () => {
  it("checks notice again after a slow live verification before persisting any booking", async () => {
    vi.setSystemTime(new Date(Date.parse(lesson.start) - 24 * 3600000 - 1));
    vi.mocked(verifyLiveLesson).mockImplementationOnce(
      async (_assignment, proposed) => {
        vi.setSystemTime(
          new Date(Date.parse(proposed.start) - 24 * 3600000 + 1),
        );
        return {
          observer: {
            email,
            role: "observer",
            canonicalKey: "head",
            name: "Head",
            departments: ["physics"],
          },
          lesson: { ...proposed, modality: "onsite" as const },
        };
      },
    );
    const a = await obligation();
    await expect(
      bookObservation(
        await accessForEmail(email, db),
        a.id,
        { sessionId: lesson.id, expectedRevision: 0 },
        db,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_NOTICE" });
    expect(await db.select().from(s.tutorSitInObservations)).toHaveLength(0);
    expect(await db.select().from(s.tutorSitInJobs)).toHaveLength(0);
  });
  it("submits exactly at 48 hours in the next quarter without changing its observation quarter", async () => {
    const b = await booking();
    const end = new Date("2026-12-31T10:00:00Z");
    await db
      .update(s.tutorSitInObservations)
      .set({
        calendarStatus: "synced",
        startTime: new Date(+end - 3600000),
        endTime: end,
      })
      .where(eq(s.tutorSitInObservations.id, b.observation.id));
    const report = await saveReport(
      await accessForEmail(email, db),
      b.report.id,
      {
        expectedRevision: 0,
        submit: true,
        data: {
          ...EMPTY_REPORT,
          occurred: true,
          strengths: "Clear",
          priorities: "More checks",
          nextSteps: "Retrieval",
          scores: Object.fromEntries(
            RUBRIC.sections.flatMap((section) =>
              section.criteria.map((c) => [c.id, 10 as const]),
            ),
          ),
        },
      },
      db,
      new Date(+end + 48 * 3600000),
    );
    expect(report.late).toBe(false);
    expect((await db.select().from(s.tutorSitInAssignments))[0].quarter).toBe(
      "2026-Q4",
    );
  });
  it("shows failed deliveries only for accessible observations or the current recipient", async () => {
    const b = await booking();
    await db.insert(s.tutorSitInJobs).values([
      {
        key: "my-digest",
        kind: "digest",
        recipient: email,
        status: "failed",
        lastError: "Relay unavailable",
      },
      {
        key: "other-digest",
        kind: "digest",
        recipient: "other@example.test",
        status: "failed",
        lastError: "Private to other account",
      },
      {
        key: "my-observation",
        kind: "calendar_upsert",
        observationId: b.observation.id,
        status: "failed",
      },
    ]);
    const result = await overview(
      await accessForEmail(email, db),
      "2026-Q4",
      db,
    );
    expect(result.deliveryIssues).toHaveLength(2);
    expect(
      result.deliveryIssues.some((j) => j.recipient === "other@example.test"),
    ).toBe(false);
  });
  it("isolates departments, limits coordinators, and honors disabled/revoked accounts", async () => {
    const maths = await obligation("english");
    const head = await accessForEmail(email, db);
    await expect(detail(head, maths.id, db)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      detail(await accessForEmail(manager, db), maths.id, db),
    ).resolves.toBeDefined();
    await db
      .insert(s.tutorSitInGrants)
      .values({ email: "staff@example.test", role: "coordinator" });
    expect(
      (
        await detail(
          await accessForEmail("staff@example.test", db),
          maths.id,
          db,
        )
      ).reports,
    ).toEqual([]);
    await db
      .insert(s.adminUsers)
      .values({ email, allowedPages: null, disabled: true });
    await expect(accessForEmail(email, db)).rejects.toMatchObject({
      status: 403,
    });
    await db
      .update(s.adminUsers)
      .set({ disabled: false })
      .where(eq(s.adminUsers.email, email));
    await db
      .update(s.tutorSitInGrants)
      .set({ active: false })
      .where(eq(s.tutorSitInGrants.email, email));
    await expect(accessForEmail(email, db)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("generates unique multi-subject obligations, separate ISEB coverage, mid-quarter additions, and no self-assignment", async () => {
    const sample = {
      ...sources,
      lessons: [
        { ...lesson, departments: ["physics", "maths", "iseb"] },
        {
          ...lesson,
          id: "head-class",
          tutorKey: "head",
          departments: ["physics"],
        },
      ],
    } as Sources;
    expect(await generateAssignments("2026-Q4", sample, db)).toBe(4);
    expect(await generateAssignments("2026-Q4", sample, db)).toBe(0);
    const own = await db
      .select()
      .from(s.tutorSitInAssignments)
      .where(eq(s.tutorSitInAssignments.canonicalKey, "head"));
    expect(own[0].observerEmail).toBeNull();
    expect(
      await generateAssignments(
        "2026-Q4",
        { ...sources, lessons: [{ ...lesson, tutorKey: "new-tutor" }] },
        db,
      ),
    ).toBe(2);
    await generateAssignments("2026-Q4", { ...sources, lessons: [] }, db);
    expect(await db.select().from(s.tutorSitInAssignments)).toHaveLength(6);
    await expect(
      resolveObserver(email, "physics", "head", db),
    ).rejects.toMatchObject({ code: "SELF_OBSERVATION" });
  });
  it("isolates ISEB strands for list, detail and observer eligibility", async () => {
    await db
      .update(s.tutorSitInGrants)
      .set({ departments: ["iseb"], scopes: ["iseb_english_vr"] })
      .where(eq(s.tutorSitInGrants.email, email));
    const [english, maths, other] = await db
      .insert(s.tutorSitInAssignments)
      .values(
        ["iseb_english_vr", "iseb_maths_vr", "iseb_other"].map(
          (coverageScope) => ({
            quarter: "2026-Q4",
            department: "iseb",
            coverageScope,
            canonicalKey: "target",
            tutorName: "Tutor",
            observerEmail: email,
          }),
        ),
      )
      .returning();
    const access = await accessForEmail(email, db);
    expect(
      (await listAssignments(access, "2026-Q4", db)).map((a) => a.id),
    ).toEqual([english.id]);
    await expect(getAssignment(access, maths.id, db)).rejects.toMatchObject({
      status: 403,
    });
    await expect(detail(access, other.id, db)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      resolveObserver(email, "iseb_maths_vr", "target", db),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("generates distinct strands concurrently and supersedes only unused automatic coverage", async () => {
    const old = await obligation("english");
    const manual = await obligation("maths");
    await db
      .update(s.tutorSitInAssignments)
      .set({ allocationMode: "manual" })
      .where(eq(s.tutorSitInAssignments.id, manual.id));
    const sample = {
      ...sources,
      lessons: ["Eng+VR", "Math + VR", "Non VR"].map((title, i) => ({
        ...lesson,
        id: "strand-" + i,
        title,
        departments: titleDepartments(title),
        scopes: titleScopes(title),
      })),
    } as Sources;
    const results = await Promise.all([
      generateAssignments("2026-Q4", sample, db),
      generateAssignments("2026-Q4", sample, db),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(3);
    const rows = await db.select().from(s.tutorSitInAssignments);
    expect(rows.find((a) => a.id === old.id)?.status).toBe("superseded");
    expect(rows.find((a) => a.id === manual.id)?.status).toBe("pending");
    expect(
      await listAssignments(await accessForEmail(manager, db), "2026-Q4", db),
    ).toHaveLength(4);
    expect(
      (await db.select().from(s.tutorSitInAudit)).filter(
        (e) => e.action === "assignment_superseded",
      ),
    ).toHaveLength(1);
    // An actual ordinary lesson recreates legitimate ordinary subject coverage.
    await generateAssignments(
      "2026-Q4",
      {
        ...sample,
        lessons: [
          ...sample.lessons,
          {
            ...lesson,
            title: "English",
            departments: ["english"],
            scopes: ["english"],
          },
        ],
      },
      db,
    );
    expect(
      (await db.select().from(s.tutorSitInAssignments)).filter(
        (a) => a.department === "english" && a.status === "pending",
      ),
    ).toHaveLength(1);
  });
  it("balances only automatic Science, excludes self, and preserves manual and booked allocations", async () => {
    const heads = [HEADS[0], HEADS[1], HEADS[3]];
    await db.insert(s.tutorContacts).values([
      { canonicalKey: "peat", displayName: "Peat" },
      { canonicalKey: "mimi", displayName: "Mimi" },
    ]);
    await db
      .update(s.tutorSitInGrants)
      .set({
        departments: ["physics", "science"],
        scopes: ["physics", "science"],
      })
      .where(eq(s.tutorSitInGrants.email, email));
    await db.insert(s.tutorSitInGrants).values([
      {
        email: heads[1].email,
        departments: ["maths", "science"],
        scopes: ["maths", "science"],
        canonicalKey: "peat",
      },
      {
        email: heads[2].email,
        departments: ["chemistry", "science"],
        scopes: ["chemistry", "science"],
        canonicalKey: "mimi",
      },
    ]);
    vi.mocked(suggestionsFor).mockResolvedValue([
      {
        sessionId: "science",
        title: "Science",
        start: lesson.start,
        end: lesson.end,
        location: "Room",
        modality: "onsite",
        verification: "wise_only",
      },
    ]);
    const sample = {
      ...sources,
      lessons: ["head", "peat", "mimi", "t1", "t2", "t3", "t4", "t5", "t6"].map(
        (tutorKey, i) => ({
          ...lesson,
          tutorKey,
          id: "science-" + i,
          departments: ["science"],
          scopes: ["science"],
        }),
      ),
    } as Sources;
    await Promise.all([
      generateAssignments("2026-Q4", sample, db),
      generateAssignments("2026-Q4", sample, db),
    ]);
    let rows = await db.select().from(s.tutorSitInAssignments);
    expect(rows).toHaveLength(9);
    expect(
      heads.map((h) => rows.filter((a) => a.observerEmail === h.email).length),
    ).toEqual([3, 3, 3]);
    for (const a of rows)
      expect(a.observerEmail).not.toBe(
        (
          {
            head: heads[0].email,
            peat: heads[1].email,
            mimi: heads[2].email,
          } as Record<string, string>
        )[a.canonicalKey],
      );
    const manual = rows.find((a) => a.canonicalKey === "t1")!;
    const booked = rows.find((a) => a.canonicalKey === "t2")!;
    await db
      .update(s.tutorSitInAssignments)
      .set({ allocationMode: "manual" })
      .where(eq(s.tutorSitInAssignments.id, manual.id));
    await db
      .update(s.tutorSitInAssignments)
      .set({ status: "scheduled" })
      .where(eq(s.tutorSitInAssignments.id, booked.id));
    vi.mocked(suggestionsFor).mockImplementation(async (a) =>
      a.observerEmail === email
        ? [
            {
              sessionId: "free",
              title: "Science",
              start: lesson.start,
              end: lesson.end,
              location: "Room",
              modality: "onsite",
            },
          ]
        : [],
    );
    await generateAssignments("2026-Q4", sample, db);
    rows = await db.select().from(s.tutorSitInAssignments);
    expect(rows.find((a) => a.id === manual.id)?.observerEmail).toBe(
      manual.observerEmail,
    );
    expect(rows.find((a) => a.id === booked.id)?.observerEmail).toBe(
      booked.observerEmail,
    );
    expect(rows.find((a) => a.canonicalKey === "t3")?.observerEmail).toBe(
      email,
    );
  });
  it("does not allocate a head revoked while availability was loading", async () => {
    await db
      .update(s.tutorSitInGrants)
      .set({
        departments: ["physics", "science"],
        scopes: ["physics", "science"],
      })
      .where(eq(s.tutorSitInGrants.email, email));
    vi.mocked(suggestionsFor).mockImplementation(async () => {
      await db
        .update(s.tutorSitInGrants)
        .set({ active: false })
        .where(eq(s.tutorSitInGrants.email, email));
      return [];
    });
    await generateAssignments(
      "2026-Q4",
      {
        ...sources,
        lessons: [{ ...lesson, departments: ["science"], scopes: ["science"] }],
      },
      db,
    );
    expect(
      (await db.select().from(s.tutorSitInAssignments))[0].observerEmail,
    ).toBeNull();
  });
  it("serializes competing confirmation requests and makes retries idempotent", async () => {
    const a = await obligation(),
      b = await obligation("maths"),
      access = await accessForEmail(email, db);
    const results = await Promise.allSettled(
      [a, b].map((row) =>
        bookObservation(
          access,
          row.id,
          { sessionId: lesson.id, expectedRevision: 0 },
          db,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(s.tutorSitInObservations)).toHaveLength(1);
    const [observation] = await db.select().from(s.tutorSitInObservations);
    await bookObservation(
      access,
      observation.assignmentId,
      { sessionId: lesson.id, expectedRevision: 0 },
      db,
    );
    expect(
      (await db.select().from(s.tutorSitInJobs)).filter(
        (j) => j.kind === "calendar_upsert",
      ),
    ).toHaveLength(1);
    expect(
      (await db.select().from(s.tutorSitInJobs)).filter(
        (j) => j.kind === "staff_email",
      ),
    ).toHaveLength(5);
    expect(await db.select().from(s.tutorSitInReports)).toHaveLength(1);
  });
  it("also serializes separate sign-in emails bound to the same observer identity", async () => {
    const a = await obligation(),
      b = await obligation("maths");
    const insert = (assignmentId: string, observerEmail: string) =>
      db.insert(s.tutorSitInObservations).values({
        assignmentId,
        observerEmail,
        observerCanonicalKey: "head",
        lesson,
        startTime: new Date(lesson.start),
        endTime: new Date(lesson.end),
        calendarId: "primary",
        eventId: randomUUID(),
      });
    const results = await Promise.allSettled([
      insert(a.id, email),
      insert(b.id, "another@example.test"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(s.tutorSitInObservations)).toHaveLength(1);
  });
  it("invalidates acknowledgements after cancellation and preserves earlier actors/timestamps", async () => {
    const b = await booking();
    await db
      .insert(s.tutorSitInGrants)
      .values({ email: "staff@example.test", role: "coordinator" });
    await db
      .update(s.tutorSitInObservations)
      .set({ calendarStatus: "synced" })
      .where(eq(s.tutorSitInObservations.id, b.observation.id));
    const staff = await accessForEmail("staff@example.test", db);
    const [comm] = await db.select().from(s.tutorSitInCommunications);
    const first = await acknowledgeCommunication(
      staff,
      comm.id,
      { expectedRevision: 0, audience: "parent" },
      db,
    );
    expect(first.parentInformedBy).toBe(staff.email);
    expect(first.studentInformedAt).toBeNull();
    await invalidateObservation(
      db,
      b.observation,
      "Wise lesson cancelled",
      "system:test",
    );
    const rows = await db.select().from(s.tutorSitInCommunications);
    expect(rows.filter((c) => c.kind === "cancelled")).toHaveLength(2);
    expect(
      rows.filter((c) => c.kind === "scheduled").every((c) => !!c.supersededAt),
    ).toBe(true);
    expect(rows.find((c) => c.id === comm.id)?.parentInformedAt).toEqual(
      first.parentInformedAt,
    );
    await expect(
      acknowledgeCommunication(
        staff,
        comm.id,
        { expectedRevision: 1, audience: "student" },
        db,
      ),
    ).rejects.toThrow("changed");
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "needs_rescheduling",
    );
  });
  it("saves drafts, calculates totals and lateness, protects submission history and audits reopening", async () => {
    const b = await booking(),
      access = await accessForEmail(email, db);
    await db
      .update(s.tutorSitInObservations)
      .set({ calendarStatus: "synced" })
      .where(eq(s.tutorSitInObservations.id, b.observation.id));
    const draft = await saveReport(
      access,
      b.report.id,
      {
        expectedRevision: 0,
        submit: false,
        data: { ...EMPTY_REPORT, strengths: "Clear examples" },
      },
      db,
    );
    expect(draft.score).toBeNull();
    expect(draft.revision).toBe(1);
    await expect(
      saveReport(
        access,
        b.report.id,
        { expectedRevision: 0, submit: false, data: EMPTY_REPORT },
        db,
      ),
    ).rejects.toThrow("changed");
    const data = {
      ...EMPTY_REPORT,
      scores: Object.fromEntries(
        RUBRIC.sections.flatMap((s) =>
          s.criteria.map((c) => [c.id, 7 as const]),
        ),
      ),
      strengths: "Clear",
      priorities: "Check learning",
      nextSteps: "Use retrieval practice",
      occurred: true,
    };
    await expect(
      saveReport(
        access,
        b.report.id,
        { expectedRevision: 1, submit: true, data },
        db,
        new Date(lesson.start),
      ),
    ).rejects.toThrow("finished");
    const report = await saveReport(
      access,
      b.report.id,
      { expectedRevision: 1, submit: true, data },
      db,
      new Date("2026-10-07T04:00:01Z"),
    );
    expect(report.score).toBe(70);
    expect(report.late).toBe(true);
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "completed",
    );
    await expect(
      db
        .update(s.tutorSitInReports)
        .set({ score: 100 })
        .where(eq(s.tutorSitInReports.id, report.id)),
    ).rejects.toThrow();
    const a = (await db.select().from(s.tutorSitInAssignments))[0];
    await assignmentCommand(
      await accessForEmail(manager, db),
      a.id,
      {
        action: "reopen",
        expectedRevision: a.revision,
        reason: "Clarify evidence",
      },
      db,
    );
    const reports = await db.select().from(s.tutorSitInReports);
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.id === report.id)?.score).toBe(70);
    expect(reports.find((r) => r.id !== report.id)?.rubric).toEqual(
      report.rubric,
    );
    await expect(db.delete(s.tutorSitInAudit)).rejects.toThrow();
  });
  it("keeps reports and quarterly attribution intact when later source changes occur", async () => {
    const b = await booking();
    await db
      .update(s.tutorSitInAssignments)
      .set({ status: "completed" })
      .where(eq(s.tutorSitInAssignments.id, b.assignment.id));
    await invalidateObservation(
      db,
      b.observation,
      "Cancelled later",
      "system:test",
    );
    expect((await db.select().from(s.tutorSitInObservations))[0].current).toBe(
      true,
    );
    expect((await db.select().from(s.tutorSitInAssignments))[0].quarter).toBe(
      "2026-Q4",
    );
  });
  it("allows cleanup under a revoked grant, but refuses new scheduling", async () => {
    await db
      .update(s.tutorSitInGrants)
      .set({ active: false })
      .where(eq(s.tutorSitInGrants.email, email));
    await expect(
      withObserverOperation(db, email, async (lease) => {
        await lease();
      }),
    ).rejects.toThrow();
    await expect(
      withObserverOperation(
        db,
        email,
        async (lease) => {
          await lease();
          return "cleaned";
        },
        { cleanup: true },
      ),
    ).resolves.toBe("cleaned");
  });
});
describe("isolated Calendar and email delivery", () => {
  it("withdraws a queued observation when its observer grant is revoked before delivery", async () => {
    const b = await booking();
    await db
      .update(s.tutorSitInGrants)
      .set({ active: false })
      .where(eq(s.tutorSitInGrants.email, email));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await processJobs(db, { observationId: b.observation.id })).failed,
    ).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "needs_rescheduling",
    );
    expect(
      (await db.select().from(s.tutorSitInJobs)).some(
        (j) => j.kind === "calendar_delete",
      ),
    ).toBe(true);
  });
  function event(
    observation: Awaited<ReturnType<typeof booking>>["observation"],
  ) {
    return {
      id: observation.eventId || observation.id.replaceAll("-", ""),
      etag: "etag",
      description:
        "Quarterly tutor observation. Details: http://localhost:3000/tutor-sit-ins/" +
        observation.assignmentId,
      summary: "BeGifted Sit-in · " + lesson.title + " · " + lesson.tutorName,
      location: lesson.location!,
      start: { dateTime: lesson.start },
      end: { dateTime: lesson.end },
      attendees: [{ email: "tutor@example.test" }],
      extendedProperties: { private: { sitInObservationId: observation.id } },
    };
  }
  it.each(["edited", "deleted", "unavailable"])(
    "keeps Wise confirmed when the Google event is %s",
    async (state) => {
      const b = await booking();
      b.observation = await bindRecordedEvent(b.observation);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          state === "edited"
            ? Response.json({
                ...event(b.observation),
                start: { dateTime: "2026-10-05T03:30:00Z" },
              })
            : Response.json({}, { status: state === "deleted" ? 404 : 503 }),
        ),
      );
      await reconcileObservation(db, b.assignment, b.observation, sources, now);
      expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
        "scheduled",
      );
      const [observation] = await db.select().from(s.tutorSitInObservations);
      expect(observation.current).toBe(true);
      expect(observation.calendarStatus).toBe(
        state === "unavailable" ? "error" : "discrepancy",
      );
      expect(
        (await db.select().from(s.tutorSitInJobs)).some(
          (j) => j.kind === "calendar_delete",
        ),
      ).toBe(false);
      expect(
        (await db.select().from(s.tutorSitInCommunications)).every(
          (c) => !c.supersededAt,
        ),
      ).toBe(true);
      expect(await db.select().from(s.tutorSitInReports)).toHaveLength(1);
    },
  );
  it("confirms without Calendar or delivery and allows family acknowledgements and reports", async () => {
    await db.delete(s.tutorSitInCalendarConnections);
    vi.stubEnv("TUTOR_SIT_INS_DELIVERY_ENABLED", "false");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const b = await booking();
    expect(b.assignment.status).toBe("scheduled");
    expect(b.observation).toMatchObject({
      calendarId: null,
      calendarProvider: null,
      calendarAccountId: null,
      eventId: null,
    });
    expect(
      (await db.select().from(s.tutorSitInJobs)).filter(
        (j) => j.kind === "staff_email",
      ),
    ).toHaveLength(5);
    const [task] = await db.select().from(s.tutorSitInCommunications);
    const ack = await acknowledgeCommunication(
      await accessForEmail(manager, db),
      task.id,
      { expectedRevision: 0, audience: "parent" },
      db,
    );
    expect(ack.parentInformedBy).toBe(manager);
    vi.setSystemTime(new Date(Date.parse(lesson.end) + 49 * 3600000));
    const report = await saveReport(
      await accessForEmail(email, db),
      b.report.id,
      {
        expectedRevision: 0,
        submit: true,
        data: {
          ...EMPTY_REPORT,
          occurred: true,
          scores: Object.fromEntries(
            RUBRIC.sections
              .flatMap((section) => section.criteria)
              .map((c) => [c.id, 10]),
          ),
          strengths: "Clear explanations",
          priorities: "Use more checks",
          nextSteps: "Review next quarter",
        },
      },
      db,
    );
    expect(report.score).toBe(100);
    expect(report.late).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("connects after confirmation, wakes the queued job and adds one event even within 24 hours", async () => {
    await db.delete(s.tutorSitInCalendarConnections);
    const b = await booking();
    expect((await processJobs(db, { limit: 1 })).failed).toBe(1);
    expect(
      (await db.select().from(s.tutorSitInObservations))[0].calendarStatus,
    ).toBe("connection_required");
    vi.setSystemTime(new Date(Date.parse(lesson.start) - 3600000));
    let existing: ReturnType<typeof event> | null = null;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com/token"))
        return Response.json({
          access_token: "new",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: CALENDAR_SCOPES.join(" "),
        });
      if (String(url).includes("/userinfo"))
        return Response.json({
          sub: "google-head",
          email,
          email_verified: true,
        });
      if (String(url).includes("calendarList")) return googleList();
      if (init?.method === "POST") {
        existing = event(b.observation);
        return Response.json(existing);
      }
      return existing
        ? Response.json(existing)
        : Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const begin = beginCalendarOAuth(email, "http://localhost:3000");
    const state = verifyOAuthState(
      begin.cookie,
      new URL(begin.url).searchParams.get("state")!,
      email,
    );
    expect(new URL(begin.url).searchParams.get("scope")).not.toContain(
      "freebusy",
    );
    await finishCalendarOAuth(email, "code", state, db);
    expect(
      (await processJobs(db, { observationId: b.observation.id })).failed,
    ).toBe(0);
    expect(
      (await processJobs(db, { observationId: b.observation.id })).sent,
    ).toBe(0);
    const [o] = await db.select().from(s.tutorSitInObservations);
    expect(o).toMatchObject({
      calendarStatus: "synced",
      calendarId: "head-calendar",
      calendarProvider: "google",
    });
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/events?") && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      vi.mocked(verifyLiveLesson).mock.calls.at(-1)![4]?.requireAdvance,
    ).toBe(false);
  });
  it("finishes a cancellation before delivery without needing credentials, even with delivery paused", async () => {
    await db.delete(s.tutorSitInCalendarConnections);
    const b = await booking();
    await assignmentCommand(
      await accessForEmail(email, db),
      b.assignment.id,
      {
        action: "cancel",
        expectedRevision: b.assignment.revision,
        reason: "Lesson cancelled",
      },
      db,
    );
    vi.stubEnv("TUTOR_SIT_INS_DELIVERY_ENABLED", "false");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await processJobs(db);
    expect(
      (await db.select().from(s.tutorSitInObservations))[0].calendarStatus,
    ).toBe("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "does not create a new invitation after the start with delivery enabled=%s",
    async (enabled) => {
      const b = await booking();
      vi.stubEnv("TUTOR_SIT_INS_DELIVERY_ENABLED", String(enabled));
      vi.setSystemTime(new Date(lesson.start));
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await processJobs(db, { limit: 1 });
      expect(
        (await db.select().from(s.tutorSitInObservations))[0],
      ).toMatchObject({ current: true, calendarStatus: "missed" });
      expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
        "scheduled",
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect((await processJobs(db, { limit: 1 })).failed).toBe(0);
    },
  );
  it.each(["refresh", "worker"])(
    "reconciles Wise changes during %s with no Calendar and paused delivery",
    async (mode) => {
      await db.delete(s.tutorSitInCalendarConnections);
      const b = await booking();
      vi.stubEnv("TUTOR_SIT_INS_DELIVERY_ENABLED", "false");
      vi.mocked(verifyLiveLesson).mockRejectedValue(
        new SitInError(409, "Wise class cancelled", "LESSON_CHANGED"),
      );
      if (mode === "refresh")
        await refreshQuarter(await accessForEmail(email, db), "2026-Q4", db);
      else await runSitInWorker(db, now);
      expect(
        (await db.select().from(s.tutorSitInAssignments)).find(
          (a) => a.id === b.assignment.id,
        )?.status,
      ).toBe("needs_rescheduling");
      expect(
        (await db.select().from(s.tutorSitInObservations))[0].current,
      ).toBe(false);
    },
  );
  it("retains a Wise booking and records a retryable availability issue after Wise failure", async () => {
    const b = await booking();
    vi.mocked(verifyLiveLesson).mockRejectedValue(
      new SitInError(503, "Wise unavailable", "SOURCE_UNAVAILABLE"),
    );
    expect(
      await reconcileObservation(db, b.assignment, b.observation, sources, now),
    ).toBe(false);
    const [a] = await db.select().from(s.tutorSitInAssignments);
    expect(a.status).toBe("scheduled");
    expect(a.readinessIssues[0].category).toBe("availability");
    expect(
      (await db.select().from(s.tutorSitInObservations))[0].calendarError,
    ).toBeNull();
  });
  it("allows Calendar account disconnection before any queued observation is bound", async () => {
    const b = await booking();
    await disconnectCalendar(email, db);
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "scheduled",
    );
    expect(
      (await processJobs(db, { observationId: b.observation.id })).failed,
    ).toBe(1);
  });
  it("keeps missing invitation contact as a delivery issue", async () => {
    await db
      .update(s.tutorContacts)
      .set({ onsiteEmail: null })
      .where(eq(s.tutorContacts.canonicalKey, "target"));
    const b = await booking();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).includes("calendarList")
          ? googleList()
          : Response.json({}, { status: 404 }),
      ),
    );
    expect((await processJobs(db, { limit: 1 })).failed).toBe(1);
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "scheduled",
    );
    expect((await db.select().from(s.tutorSitInObservations))[0]).toMatchObject(
      { current: true, calendarStatus: "error" },
    );
    expect(b.report.id).toBeDefined();
  });
  it("verifies OAuth state, keeps setup connections separate from delivery, and blocks previews", () => {
    vi.stubEnv("TUTOR_SIT_INS_DELIVERY_ENABLED", "false");
    const result = beginCalendarOAuth(email, "http://localhost:3000"),
      url = new URL(result.url);
    expect(
      verifyOAuthState(result.cookie, url.searchParams.get("state")!, email)
        .email,
    ).toBe(email);
    expect(() => verifyOAuthState(result.cookie, "tampered", email)).toThrow();
    expect(() =>
      verifyOAuthState(
        result.cookie,
        url.searchParams.get("state")!,
        "another@example.test",
      ),
    ).toThrow();
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(() => beginCalendarOAuth(email, "http://localhost:3000")).toThrow(
      "unavailable",
    );
  });
  it("retries a failed event write with a persistent identifier and no duplicate invitation", async () => {
    const b = await booking();
    let existing: ReturnType<typeof event> | null = null,
      writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (String(_input).includes("calendarList")) return googleList();
        if (init?.method === "POST") {
          writes++;
          existing = event(b.observation);
          return Response.json(
            { error: "uncertain response" },
            { status: 503 },
          );
        }
        return existing
          ? Response.json(existing)
          : Response.json({}, { status: 404 });
      }),
    );
    const first = await processJobs(db, { limit: 1 });
    expect(first.failed).toBe(1);
    expect(
      (await db.select().from(s.tutorSitInObservations))[0].calendarStatus,
    ).toBe("error");
    await db.update(s.tutorSitInJobs).set({ retryAt: new Date("2026-09-01") });
    const second = await processJobs(db, { limit: 1 });
    expect(second.failed).toBe(0);
    expect(writes).toBe(1);
    expect(
      (await db.select().from(s.tutorSitInObservations))[0].calendarStatus,
    ).toBe("synced");
    expect(
      eventMatches(b.observation, {
        ...event(b.observation),
        start: { dateTime: "2026-10-05T06:00:00Z" },
      }),
    ).toBe(false);
    const content = observationEmail(b.observation, "confirmed");
    expect(content.text).toContain("Test Learner");
    expect(content.text).not.toContain("Accuracy of information");
  });
  it("shows staff relay failures and retries with the same delivery key", async () => {
    const b = await booking();
    await db.update(s.tutorSitInJobs).set({ status: "sent" });
    await db.insert(s.tutorSitInJobs).values({
      key: "staff-test",
      kind: "staff_email",
      observationId: b.observation.id,
      recipient: manager,
      payload: { kind: "confirmed" },
    });
    const sender = {
      sendEmail: vi
        .fn()
        .mockRejectedValueOnce(new Error("Relay unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    expect((await processJobs(db, { sender })).failed).toBe(1);
    await db
      .update(s.tutorSitInJobs)
      .set({ retryAt: new Date("2026-09-01") })
      .where(eq(s.tutorSitInJobs.key, "staff-test"));
    expect((await processJobs(db, { sender })).sent).toBe(1);
    expect(
      sender.sendEmail.mock.calls.map((args) => args[0].idempotencyKey),
    ).toEqual(["tutor-sit-ins:staff-test", "tutor-sit-ins:staff-test"]);
    expect(
      (await db.select().from(s.tutorSitInCommunications)).every(
        (c) => !c.parentInformedAt,
      ),
    ).toBe(true);
  });
  it("claims each delivery job once and retains credentials until event withdrawal finishes", async () => {
    const b = await booking();
    b.observation = await bindRecordedEvent(b.observation);
    const [job] = await db.select().from(s.tutorSitInJobs);
    const claimed = await Promise.all([
      claimJob(db, job.id, "worker-a"),
      claimJob(db, job.id, "worker-b"),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    await expect(disconnectCalendar(email, db)).rejects.toThrow("cancel");
    await db
      .update(s.tutorSitInObservations)
      .set({ current: false, calendarStatus: "cancelled" })
      .where(eq(s.tutorSitInObservations.id, b.observation.id));
    await expect(disconnectCalendar(email, db)).rejects.toThrow(
      "calendar jobs",
    );
    await db.update(s.tutorSitInJobs).set({ status: "sent" });
    await disconnectCalendar(email, db);
    expect(
      await db.select().from(s.tutorSitInCalendarConnections),
    ).toHaveLength(0);
  });
});

describe("Outlook account and booking persistence", () => {
  async function microsoft() {
    await db.update(s.tutorSitInCalendarConnections).set({
      provider: "microsoft",
      providerAccountId: "microsoft-head",
      accountEmail: "apivit.s@hotmail.com",
      googleSubject: null,
      googleEmail: null,
      scope: MICROSOFT_SCOPES.join(" "),
    });
  }
  function graphEvent(
    observation: Awaited<ReturnType<typeof booking>>["observation"],
    id = "Immutable+ID/Case",
  ) {
    return {
      id,
      subject: "BeGifted Sit-in · " + lesson.title + " · " + lesson.tutorName,
      body: {
        contentType: "text",
        content:
          "Quarterly tutor observation. Details: http://localhost:3000/tutor-sit-ins/" +
          observation.assignmentId,
      },
      location: { displayName: lesson.location },
      sensitivity: "private",
      start: { dateTime: lesson.start, timeZone: "UTC" },
      end: { dateTime: lesson.end, timeZone: "UTC" },
      attendees: [{ emailAddress: { address: "tutor@example.test" } }],
      singleValueExtendedProperties: [
        { id: OBSERVATION_PROPERTY, value: observation.id },
      ],
    };
  }
  const primary = {
    id: "primary",
    name: "Calendar",
    owner: { address: "apivit.s@hotmail.com" },
    canEdit: true,
    canShare: true,
  };
  function graph(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ) {
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://graph.microsoft.com/v1.0/me/calendar")
        return Response.json(primary);
      if (url.includes("/me/calendars?"))
        return Response.json({ value: [primary] });
      return handler(url, init);
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it.each(["apivit.s@hotmail.com", "observer@school.example"])(
    "connects verified personal/work account %s without changing site grants",
    async (mail) => {
      graph((url) =>
        url.includes("oauth2")
          ? Response.json({
              access_token: "ms-access",
              refresh_token: "ms-refresh",
              expires_in: 3600,
              scope: MICROSOFT_SCOPES.join(" "),
            })
          : Response.json({
              id: "new-ms-account",
              mail,
              userPrincipalName: mail,
            }),
      );
      const begin = beginCalendarOAuth(
        email,
        "http://localhost:3000",
        "microsoft",
      );
      const url = new URL(begin.url);
      expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")).toContain("offline_access");
      const state = verifyOAuthState(
        begin.cookie,
        url.searchParams.get("state")!,
        email,
        Date.now(),
        "microsoft",
      );
      expect(() =>
        verifyOAuthState(begin.cookie, url.searchParams.get("state")!, email),
      ).toThrow();
      await finishCalendarOAuth(email, "code", state, db);
      const connection = await calendarConnection(email, db);
      expect(connection).toMatchObject({
        provider: "microsoft",
        providerAccountId: "new-ms-account",
        accountEmail: mail,
        googleEmail: null,
      });
      expect(connection.accessTokenCiphertext).not.toBe("ms-access");
      expect((await accessForEmail(email, db)).role).toBe("observer");
      expect(await db.select().from(s.adminUsers)).toHaveLength(1);
    },
  );
  it("persists rotated refresh credentials and sends immutable UTC/text preferences", async () => {
    await microsoft();
    await db.update(s.tutorSitInCalendarConnections).set({
      expiresAt: new Date("2020-01-01"),
      refreshTokenCiphertext: encryptToken("old-refresh"),
    });
    const fetcher = graph((url) => {
      expect(url).toContain("oauth2/v2.0/token");
      return Response.json({
        access_token: "fresh-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: MICROSOFT_SCOPES.join(" "),
      });
    });
    await (await calendarProvider(email, db)).provider.list();
    const connection = await calendarConnection(email, db);
    expect(decryptToken(connection.refreshTokenCiphertext)).toBe(
      "rotated-refresh",
    );
    const headers = fetcher.mock.calls.find(([url]) =>
      String(url).includes("graph.microsoft.com"),
    )![1]!.headers as Record<string, string>;
    expect(headers.Prefer).toContain('IdType="ImmutableId"');
    expect(headers.Prefer).toContain('outlook.timezone="UTC"');
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2")),
    ).toHaveLength(1);
  });
  it("keeps an uncertain Outlook creation to one invitation and stamps provider identity", async () => {
    await microsoft();
    const b = await booking();
    expect(b.observation).toMatchObject({
      calendarProvider: null,
      calendarAccountId: null,
      eventId: null,
    });
    let existing: ReturnType<typeof graphEvent> | null = null,
      writes = 0;
    graph((_url, init) => {
      if (init?.method === "POST") {
        writes++;
        existing = graphEvent(b.observation);
        return Response.json({}, { status: 503 });
      }
      return Response.json({ value: existing ? [existing] : [] });
    });
    expect((await processJobs(db, { limit: 1 })).failed).toBe(1);
    await db.update(s.tutorSitInJobs).set({ retryAt: new Date("2026-09-01") });
    expect((await processJobs(db, { limit: 1 })).failed).toBe(0);
    expect(writes).toBe(1);
    const [observation] = await db.select().from(s.tutorSitInObservations);
    expect(observation).toMatchObject({
      calendarProvider: "microsoft",
      calendarAccountId: "microsoft-head",
      eventId: "Immutable+ID/Case",
      calendarStatus: "synced",
    });
  });
  it("keeps cleanup working after rollout rollback and retries cancellation safely", async () => {
    await microsoft();
    const b = await booking();
    b.observation = await bindRecordedEvent(b.observation, "microsoft");
    const event = graphEvent(b.observation);
    await db
      .update(s.tutorSitInObservations)
      .set({ eventId: event.id, calendarStatus: "synced" });
    await db.update(s.tutorSitInJobs).set({ status: "sent" });
    const [observation] = await db.select().from(s.tutorSitInObservations);
    await invalidateObservation(db, observation, "Cancelled", manager);
    await db
      .update(s.tutorSitInJobs)
      .set({ status: "sent" })
      .where(sql`kind <> 'calendar_delete'`);
    vi.stubEnv("TUTOR_SIT_INS_MICROSOFT_ENABLED", "false");
    let deletes = 0;
    graph((_url, init) => {
      if (init?.method === "DELETE") {
        deletes++;
        return Response.json({}, { status: 503 });
      }
      return deletes
        ? Response.json({}, { status: 404 })
        : Response.json(event);
    });
    expect((await processJobs(db, { limit: 1 })).failed).toBe(1);
    await db.update(s.tutorSitInJobs).set({ retryAt: new Date("2026-09-01") });
    expect((await processJobs(db, { limit: 1 })).failed).toBe(0);
    expect(deletes).toBe(1);
    expect(
      (await db.select().from(s.tutorSitInObservations))[0].calendarStatus,
    ).toBe("cancelled");
    expect(() =>
      beginCalendarOAuth(email, "http://localhost:3000", "microsoft"),
    ).toThrow("not enabled");
  });
  it("rejects account switches while exported bookings or old unfinished jobs exist", async () => {
    const b = await booking();
    b.observation = await bindRecordedEvent(b.observation);
    graph((url) =>
      url.includes("oauth2")
        ? Response.json({
            access_token: "new",
            refresh_token: "new",
            expires_in: 3600,
            scope: MICROSOFT_SCOPES.join(" "),
          })
        : Response.json({ id: "new-account", mail: "another@hotmail.com" }),
    );
    const begin = beginCalendarOAuth(
      email,
      "http://localhost:3000",
      "microsoft",
    );
    const state = verifyOAuthState(
      begin.cookie,
      new URL(begin.url).searchParams.get("state")!,
      email,
      Date.now(),
      "microsoft",
    );
    await expect(finishCalendarOAuth(email, "code", state, db)).rejects.toThrow(
      "calendar jobs",
    );
    vi.setSystemTime(new Date("2026-11-01"));
    await expect(disconnectCalendar(email, db)).rejects.toThrow(
      "calendar jobs",
    );
    await db.update(s.tutorSitInJobs).set({ status: "sent" });
    await finishCalendarOAuth(email, "code", state, db);
    await expect(calendarProvider(email, db, b.observation)).rejects.toThrow(
      "different calendar account",
    );
  });
  it("serializes account switches with active booking operations", async () => {
    await withObserverOperation(db, email, async () => {
      await expect(disconnectCalendar(email, db)).rejects.toThrow(
        "Another observation",
      );
    });
    expect(
      await db.select().from(s.tutorSitInCalendarConnections),
    ).toHaveLength(1);
  });
  it("keeps Wise booking available when Outlook delivery is disabled", async () => {
    await microsoft();
    vi.stubEnv("TUTOR_SIT_INS_MICROSOFT_ENABLED", "false");
    const b = await booking();
    expect(b.assignment.status).toBe("scheduled");
    expect((await processJobs(db, { limit: 1 })).failed).toBe(1);
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "scheduled",
    );
  });
  it("preserves uncertain historical writes when introducing optional Calendar bindings", async () => {
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TEMP TABLE tutor_sit_in_observations (calendar_id text NOT NULL, calendar_provider text NOT NULL DEFAULT 'google', calendar_status text, event_etag text, event_url text, event_id text, created_at timestamptz) ON COMMIT DROP",
      );
      await client.query(
        "CREATE TEMP TABLE tutor_sit_in_assignments (status text, suggestions jsonb, checked_at timestamptz) ON COMMIT DROP",
      );
      await client.query(
        "INSERT INTO tutor_sit_in_observations VALUES ('original','google','error',NULL,NULL,'persistent-id','2026-10-01')",
      );
      await client.query(
        "INSERT INTO tutor_sit_in_assignments VALUES ('scheduled','[{\"sessionId\":\"unchanged\"}]',now()), ('pending','[{\"verification\":\"wise_only\"}]',now())",
      );
      await client.query(
        readFileSync("drizzle/0093_sit_in_wise_scheduling.sql", "utf8"),
      );
      const o = (await client.query("SELECT * FROM tutor_sit_in_observations"))
        .rows[0];
      expect(o).toMatchObject({
        calendar_id: "original",
        calendar_provider: "google",
        event_id: "persistent-id",
        calendar_synced_at: null,
      });
      expect(o.calendar_attempted_at).toEqual(o.created_at);
      const a = (
        await client.query(
          "SELECT * FROM tutor_sit_in_assignments ORDER BY status",
        )
      ).rows;
      expect(a[0].suggestions).toEqual([]);
      expect(a[0].checked_at).toBeNull();
      expect(a[1].suggestions).toEqual([{ sessionId: "unchanged" }]);
      await client.query(
        "INSERT INTO tutor_sit_in_observations (calendar_id, calendar_provider) VALUES (NULL,NULL)",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("preserves historical Google fields in migration without touching ciphertext or selected calendars", async () => {
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TEMP TABLE tutor_sit_in_calendar_connections (email text PRIMARY KEY, google_email text NOT NULL, google_subject text NOT NULL, access_token_ciphertext text, busy_calendar_ids jsonb) ON COMMIT DROP",
      );
      await client.query(
        "CREATE TEMP TABLE tutor_sit_in_observations (observer_email text, calendar_id text, event_id text NOT NULL) ON COMMIT DROP",
      );
      await client.query(
        "CREATE UNIQUE INDEX sit_in_calendar_event ON tutor_sit_in_observations(observer_email, calendar_id, event_id)",
      );
      await client.query(
        "INSERT INTO tutor_sit_in_calendar_connections VALUES ($1,$2,$3,$4,$5)",
        [
          "head",
          "calendar@google.test",
          "old-sub",
          "unchanged-ciphertext",
          JSON.stringify(["primary", "selected"]),
        ],
      );
      await client.query(
        "INSERT INTO tutor_sit_in_observations VALUES ('head','primary','old-event')",
      );
      await client.query(
        readFileSync("drizzle/0092_sit_in_calendar_providers.sql", "utf8"),
      );
      expect(
        (await client.query("SELECT * FROM tutor_sit_in_calendar_connections"))
          .rows[0],
      ).toMatchObject({
        provider: "google",
        provider_account_id: "old-sub",
        account_email: "calendar@google.test",
        access_token_ciphertext: "unchanged-ciphertext",
        busy_calendar_ids: ["primary", "selected"],
      });
      expect(
        (await client.query("SELECT * FROM tutor_sit_in_observations")).rows[0],
      ).toMatchObject({
        calendar_provider: "google",
        calendar_account_id: "old-sub",
        event_id: "old-event",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
