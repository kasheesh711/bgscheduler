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
  overview,
} from "../service";
import {
  generateAssignments,
  invalidateObservation,
  claimJob,
  detail,
  withObserverOperation,
} from "../repository";
import { EMPTY_REPORT, RUBRIC } from "../rubric";
import { type Lesson, HEADS } from "../model";
import { encryptToken } from "@/lib/sales-dashboard/google-oauth";
import {
  CALENDAR_SCOPES,
  googleBusy,
  disconnectCalendar,
  beginCalendarOAuth,
  verifyOAuthState,
} from "../calendar";
import {
  processJobs,
  eventMatches,
  observationEmail,
  reconcileObservation,
} from "../worker";
import { loadSources, verifyLiveLesson, type Sources } from "../sources";
vi.mock("../sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources")>()),
  loadSources: vi.fn(),
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
    expect(await db.select().from(s.tutorSitInJobs)).toHaveLength(1);
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
      id: observation.eventId,
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
  it("invalidates a direct Google edit and retains cancellation acknowledgements and report history", async () => {
    const b = await booking();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...event(b.observation),
          start: { dateTime: "2026-10-05T03:30:00Z" },
        }),
      ),
    );
    await reconcileObservation(db, b.assignment, b.observation, sources, now);
    expect((await db.select().from(s.tutorSitInAssignments))[0].status).toBe(
      "needs_rescheduling",
    );
    expect((await db.select().from(s.tutorSitInObservations))[0].current).toBe(
      false,
    );
    const jobs = await db.select().from(s.tutorSitInJobs);
    expect(jobs.some((j) => j.kind === "calendar_delete")).toBe(true);
    expect(jobs.some((j) => j.kind === "head_alert")).toBe(true);
    const communications = await db.select().from(s.tutorSitInCommunications);
    expect(communications.filter((c) => c.kind === "cancelled")).toHaveLength(
      2,
    );
    expect(await db.select().from(s.tutorSitInReports)).toHaveLength(1);
  });
  it("does not subtract a merged own-event interval and accidentally hide another conflict", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("calendarList"))
        return Response.json({
          items: [
            {
              id: "head-calendar",
              summary: "Primary",
              primary: true,
              accessRole: "owner",
            },
          ],
        });
      return Response.json({
        items: [
          {
            id: "own-event",
            start: { dateTime: lesson.start },
            end: { dateTime: lesson.end },
          },
          {
            id: "personal",
            start: { dateTime: "2026-10-05T03:30:00Z" },
            end: { dateTime: "2026-10-05T04:00:00Z" },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const busy = await googleBusy(
      email,
      new Date(lesson.start),
      new Date(lesson.end),
      db,
      { calendarId: "primary", eventId: "own-event" },
    );
    expect(busy).toEqual([
      {
        start: new Date("2026-10-05T03:30:00Z"),
        end: new Date("2026-10-05T04:00:00Z"),
      },
    ]);
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
    await db
      .update(s.tutorSitInObservations)
      .set({ calendarStatus: "synced" })
      .where(eq(s.tutorSitInObservations.id, b.observation.id));
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
    await disconnectCalendar(email, db);
    expect(
      await db.select().from(s.tutorSitInCalendarConnections),
    ).toHaveLength(0);
  });
});
