import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/student-schedule/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/student-schedule/live")>();
  return { ...actual, fetchLiveMonthSessions: vi.fn() };
});

import type { WiseCreditSession } from "@/lib/credit-control/wise";
import type { Database } from "@/lib/db";
import {
  bangkokMonthInstantWindow,
  buildStudentSchedulePayload,
  deriveDisplaySubject,
  deriveSessionModality,
  getStudentMonthlySchedule,
  mergeLiveSessionsIntoRows,
  parseStudentDisplay,
  type StudentScheduleRow,
} from "@/lib/student-schedule/data";
import { fetchLiveMonthSessions } from "@/lib/student-schedule/live";
import { TEACHER_TBC, type StudentScheduleStudent } from "@/lib/student-schedule/types";

const STUDENT: StudentScheduleStudent = {
  studentKey: "aadhiya srisethi::nok srisethi",
  wiseStudentId: "stu_1",
  studentName: "Aadhiya (Aadhu.Sr) Srisethi",
  parentName: "Nok Srisethi",
  code: "Aadhu.Sr",
  shortName: "Aadhu",
};

function row(overrides: Partial<StudentScheduleRow> = {}): StudentScheduleRow {
  return {
    wiseSessionId: "ses_1",
    studentKey: STUDENT.studentKey,
    wiseStudentId: "stu_1",
    studentName: STUDENT.studentName,
    parentName: STUDENT.parentName,
    subject: "Mathematics",
    packageName: "Maths 20-pack",
    title: "",
    // 10:00 Bangkok on 4 Aug 2026.
    scheduledStartTime: new Date("2026-08-04T03:00:00Z"),
    scheduledEndTime: new Date("2026-08-04T04:30:00Z"),
    durationMinutes: 90,
    meetingStatus: "SCHEDULED",
    teacherName: "Kru Nok",
    ...overrides,
  };
}

function liveSession(overrides: Partial<WiseCreditSession> = {}): WiseCreditSession {
  return {
    _id: "ses_1",
    classId: { _id: "class_1", name: "Math Class", subject: "Math" },
    // 16:00 Bangkok on 4 Aug 2026 -- deliberately different from row()'s 10:00.
    scheduledStartTime: new Date("2026-08-04T09:00:00Z"),
    scheduledEndTime: new Date("2026-08-04T10:30:00Z"),
    meetingStatus: "UPCOMING",
    duration: 5_400_000,
    students: ["stu_1"],
    ...overrides,
  };
}

function build(rows: StudentScheduleRow[], monthKey = "2026-08") {
  return buildStudentSchedulePayload({
    rows,
    student: STUDENT,
    monthKey,
    generatedAt: new Date("2026-08-01T00:00:00Z"),
  });
}

describe("buildStudentSchedulePayload", () => {
  it("formats a session in Bangkok time", () => {
    const payload = build([row()]);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({
      dateKey: "2026-08-04",
      startLabel: "10:00",
      endLabel: "11:30",
      subject: "Mathematics",
      teacherName: "Kru Nok",
    });
    expect(payload.monthLabel).toBe("August 2026");
  });

  it("omits cancelled sessions in both Wise spellings", () => {
    const payload = build([
      row({ wiseSessionId: "a", meetingStatus: "CANCELLED" }),
      row({ wiseSessionId: "b", meetingStatus: "CANCELED" }),
      row({ wiseSessionId: "c", meetingStatus: "cancelled" }),
      row({ wiseSessionId: "d", meetingStatus: "ENDED" }),
    ]);
    expect(payload.sessions.map((session) => session.wiseSessionId)).toEqual(["d"]);
  });

  it("renders TEACHER_TBC rather than dropping a teacherless session", () => {
    const payload = build([
      row({ wiseSessionId: "a", teacherName: null }),
      row({ wiseSessionId: "b", teacherName: "   " }),
    ]);
    expect(payload.sessions).toHaveLength(2);
    expect(payload.sessions.every((s) => s.teacherName === TEACHER_TBC)).toBe(true);
  });

  it("shows a class once when a student holds two package rows for it", () => {
    const payload = build([
      row({ wiseSessionId: "dup", packageName: "Maths 20-pack" }),
      row({ wiseSessionId: "dup", packageName: "Maths top-up" }),
    ]);
    expect(payload.sessions).toHaveLength(1);
  });

  it("sorts chronologically regardless of input order", () => {
    const payload = build([
      row({ wiseSessionId: "late", scheduledStartTime: new Date("2026-08-20T03:00:00Z") }),
      row({ wiseSessionId: "early", scheduledStartTime: new Date("2026-08-02T03:00:00Z") }),
    ]);
    expect(payload.sessions.map((s) => s.wiseSessionId)).toEqual(["early", "late"]);
  });

  it("falls back to the package name when Wise gives no subject", () => {
    const payload = build([row({ subject: "  " })]);
    expect(payload.sessions[0].subject).toBe("Maths 20-pack");
  });

  it("prefers the session title over the level-band subject", () => {
    // Real BeGifted shape: `subject` is a level band, `title` names the class.
    const payload = build([
      row({ title: "In-Person Session-Biology HL", subject: "Y12-13 / G11-12 (Int.)" }),
    ]);
    expect(payload.sessions[0].subject).toBe("Biology HL");
  });

  it("tolerates a missing end time", () => {
    const payload = build([row({ scheduledEndTime: null })]);
    expect(payload.sessions[0].endLabel).toBe("");
    expect(payload.sessions[0].endTime).toBeNull();
  });

  it("returns an empty session list for a month with no classes", () => {
    const payload = build([]);
    expect(payload.sessions).toEqual([]);
    expect(payload.monthKey).toBe("2026-08");
  });
});

describe("deriveDisplaySubject", () => {
  const base = { subject: "Y12-13 / G11-12 (Int.)", packageName: "Ditdanai (Rei.Ok) Okada" };

  it("strips every attested modality prefix", () => {
    expect(deriveDisplaySubject({ ...base, title: "In-Person Session-Biology HL" })).toBe("Biology HL");
    expect(deriveDisplaySubject({ ...base, title: "Online Session - Math" })).toBe("Math");
    expect(deriveDisplaySubject({ ...base, title: "On-site Session - Science" })).toBe("Science");
    expect(deriveDisplaySubject({ ...base, title: "Live Session - Physics" })).toBe("Physics");
    expect(deriveDisplaySubject({ ...base, title: "In-Person Session – Chemistry" })).toBe("Chemistry");
  });

  it("passes an unrecognized title through untouched", () => {
    expect(deriveDisplaySubject({ ...base, title: "Physics Workshop" })).toBe("Physics Workshop");
  });

  it("keeps the full title when stripping would leave nothing", () => {
    expect(deriveDisplaySubject({ ...base, title: "Online Session - " })).toBe("Online Session -");
  });

  it("falls back through subject then packageName then Class when the title is blank", () => {
    expect(deriveDisplaySubject({ ...base, title: "  " })).toBe("Y12-13 / G11-12 (Int.)");
    expect(deriveDisplaySubject({ title: "", subject: " ", packageName: "Maths 20-pack" })).toBe("Maths 20-pack");
    expect(deriveDisplaySubject({ title: "", subject: " ", packageName: "" })).toBe("Class");
  });
});

describe("deriveSessionModality", () => {
  it("reads onsite off the two physical prefixes", () => {
    // Cross-checked against Wise: both sides are OFFLINE with a real room.
    expect(deriveSessionModality("In-Person Session-Biology HL")).toBe("onsite");
    expect(deriveSessionModality("On-site Session - Science")).toBe("onsite");
    expect(deriveSessionModality("in person session - math")).toBe("onsite");
    expect(deriveSessionModality("In-Person - English")).toBe("onsite");
  });

  it("counts Live as online, like Online", () => {
    // Both are Wise SCHEDULED with no room — "Live" is BeGifted's other word
    // for an online class, so it must not fall through to unknown.
    expect(deriveSessionModality("Live Session - Physics")).toBe("online");
    expect(deriveSessionModality("Online Session - Math")).toBe("online");
    expect(deriveSessionModality("Online Google Meet")).toBe("online");
  });

  it("fails closed on anything it cannot read", () => {
    expect(deriveSessionModality("Mock test ISEB - Baikao")).toBe("unknown");
    expect(deriveSessionModality("Quadratics Groundwork (Y8-9)")).toBe("unknown");
    expect(deriveSessionModality("")).toBe("unknown");
    expect(deriveSessionModality("   ")).toBe("unknown");
  });

  it("rides along on the payload", () => {
    const payload = build([
      row({ wiseSessionId: "a", title: "Live Session - Physics" }),
      row({ wiseSessionId: "b", title: "In-Person Session-Biology HL" }),
      row({ wiseSessionId: "c", title: "" }),
    ]);
    expect(payload.sessions.map((session) => session.modality)).toEqual([
      "online",
      "onsite",
      "unknown",
    ]);
  });
});

describe("bangkokMonthInstantWindow", () => {
  it("spans the Bangkok month, not the UTC month", () => {
    const { start, end } = bangkokMonthInstantWindow("2026-08");
    // Bangkok is UTC+7: August starts at 17:00 UTC on 31 July.
    expect(start.toISOString()).toBe("2026-07-31T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-31T17:00:00.000Z");
  });

  it("puts a late-UTC session on the next Bangkok day inside the right month", () => {
    // 2026-07-31T18:00Z is 2026-08-01 01:00 in Bangkok — August, not July.
    const instant = new Date("2026-07-31T18:00:00Z");
    const august = bangkokMonthInstantWindow("2026-08");
    const july = bangkokMonthInstantWindow("2026-07");

    expect(instant >= august.start && instant < august.end).toBe(true);
    expect(instant >= july.start && instant < july.end).toBe(false);

    const payload = build([row({ scheduledStartTime: instant })]);
    expect(payload.sessions[0].dateKey).toBe("2026-08-01");
    expect(payload.sessions[0].startLabel).toBe("01:00");
  });
});

describe("parseStudentDisplay", () => {
  it("extracts the bracketed code preserving its casing", () => {
    expect(parseStudentDisplay("Aadhiya (Aadhu.Sr) Srisethi")).toEqual({
      code: "Aadhu.Sr",
      shortName: "Aadhu",
    });
  });

  it("drops the family suffix for the short name", () => {
    expect(parseStudentDisplay("Bee (Bee.Sr)").shortName).toBe("Bee");
  });

  it("falls back to the first word when there is no code", () => {
    expect(parseStudentDisplay("Somchai Jaidee")).toEqual({
      code: null,
      shortName: "Somchai",
    });
  });
});

describe("mergeLiveSessionsIntoRows", () => {
  it("takes the live time/status/duration on a matched session, keeps the snapshot subject/package/teacher", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [row({ wiseSessionId: "ses_1" })],
      liveSessions: [liveSession({
        _id: "ses_1",
        scheduledStartTime: new Date("2026-08-04T09:00:00Z"),
        scheduledEndTime: new Date("2026-08-04T10:30:00Z"),
        meetingStatus: "RESCHEDULED",
        duration: 5_400_000,
      })],
      student: STUDENT,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      wiseSessionId: "ses_1",
      scheduledStartTime: new Date("2026-08-04T09:00:00Z"),
      scheduledEndTime: new Date("2026-08-04T10:30:00Z"),
      meetingStatus: "RESCHEDULED",
      durationMinutes: 90,
      subject: "Mathematics",
      packageName: "Maths 20-pack",
      teacherName: "Kru Nok",
    });
  });

  it("fills a blank snapshot title from the live session, but never overwrites one", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [
        row({ wiseSessionId: "ses_1", title: "" }),
        row({ wiseSessionId: "ses_2", title: "In-Person Session-Biology HL" }),
      ],
      liveSessions: [
        liveSession({ _id: "ses_1", title: "Online Session - Math" }),
        liveSession({ _id: "ses_2", title: "Some Other Title" }),
      ],
      student: STUDENT,
    });

    expect(merged.map((m) => m.title)).toEqual([
      "Online Session - Math",
      "In-Person Session-Biology HL",
    ]);
  });

  it("carries the live title onto a live-only session", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [],
      liveSessions: [liveSession({
        _id: "ses_new",
        title: "In-Person Session-Biology HL",
        classId: { _id: "class_2", name: "Science Class", subject: "Science" },
      })],
      student: STUDENT,
    });

    expect(merged[0].title).toBe("In-Person Session-Biology HL");
  });

  it("synthesizes a live-only session with no package, subject from classId.subject", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [],
      liveSessions: [liveSession({
        _id: "ses_new",
        classId: { _id: "class_2", name: "Science Class", subject: "Science" },
        userId: { _id: "teacher_1", name: "Kru Somchai" },
      })],
      student: STUDENT,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      wiseSessionId: "ses_new",
      packageName: "",
      subject: "Science",
      teacherName: "Kru Somchai",
      studentKey: STUDENT.studentKey,
      wiseStudentId: STUDENT.wiseStudentId,
    });
  });

  it("falls back to classId.name for subject when classId.subject is blank", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [],
      liveSessions: [liveSession({
        _id: "ses_new",
        classId: { _id: "class_2", name: "Science Class", subject: undefined },
      })],
      student: STUDENT,
    });

    expect(merged[0].subject).toBe("Science Class");
  });

  it("drops a snapshot-only session with no live counterpart", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [row({ wiseSessionId: "ses_gone" })],
      liveSessions: [],
      student: STUDENT,
    });

    expect(merged).toEqual([]);
  });

  it("propagates a live CANCELLED status on a matched session", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [row({ wiseSessionId: "ses_1", meetingStatus: "SCHEDULED" })],
      liveSessions: [liveSession({ _id: "ses_1", meetingStatus: "CANCELLED" })],
      student: STUDENT,
    });

    expect(merged[0].meetingStatus).toBe("CANCELLED");
  });

  it("synthesizes rows for every live session when the snapshot has none", () => {
    const merged = mergeLiveSessionsIntoRows({
      snapshotRows: [],
      liveSessions: [
        liveSession({ _id: "ses_a" }),
        liveSession({ _id: "ses_b" }),
      ],
      student: STUDENT,
    });

    expect(merged.map((m) => m.wiseSessionId).sort()).toEqual(["ses_a", "ses_b"]);
  });
});

describe("getStudentMonthlySchedule live-sweep modes", () => {
  const SNAPSHOT = { id: "snap-1", generatedAt: new Date("2026-08-01T00:00:00Z") };
  const STUDENT_ROW = {
    wiseStudentId: "stu_1",
    studentKey: STUDENT.studentKey,
    studentName: STUDENT.studentName,
    parentName: STUDENT.parentName,
  };

  /** Ordered select-result queue, consumed one per db.select() call. */
  function makeDb(selectResults: unknown[][]) {
    const queue = [...selectResults];
    let selects = 0;
    function chain(result: unknown[]) {
      const node: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "limit", "orderBy"]) node[m] = () => node;
      node.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
      node.catch = () => node;
      return node;
    }
    const db = {
      select: () => {
        selects += 1;
        return chain(queue.shift() ?? []);
      },
    };
    return { db: db as unknown as Database, selectCount: () => selects };
  }

  const sessionRow = () => row();
  const cancelledRow = () => row({ meetingStatus: "CANCELLED" });

  beforeEach(() => {
    vi.mocked(fetchLiveMonthSessions).mockReset();
    vi.mocked(fetchLiveMonthSessions).mockResolvedValue({ sessions: [liveSession()], ok: true });
  });

  it("sweeps and merges by default (mode omitted)", async () => {
    const { db } = makeDb([[SNAPSHOT], [STUDENT_ROW], [sessionRow()]]);
    const payload = await getStudentMonthlySchedule(db, { studentKey: STUDENT.studentKey, monthKey: "2026-08" });
    expect(fetchLiveMonthSessions).toHaveBeenCalledOnce();
    expect(payload?.sessions.length).toBeGreaterThan(0);
  });

  it("never sweeps in \"never\" mode and reports the snapshot's generatedAt", async () => {
    const { db } = makeDb([[SNAPSHOT], [STUDENT_ROW], [sessionRow()]]);
    const payload = await getStudentMonthlySchedule(db, {
      studentKey: STUDENT.studentKey, monthKey: "2026-08", liveSweep: "never",
    });
    expect(fetchLiveMonthSessions).not.toHaveBeenCalled();
    expect(payload?.generatedAt).toBe(SNAPSHOT.generatedAt.toISOString());
  });

  it("skips the sweep in \"rescue\" mode when the snapshot month has sessions", async () => {
    const { db } = makeDb([[SNAPSHOT], [STUDENT_ROW], [sessionRow()]]);
    const payload = await getStudentMonthlySchedule(db, {
      studentKey: STUDENT.studentKey, monthKey: "2026-08", liveSweep: "rescue",
    });
    expect(fetchLiveMonthSessions).not.toHaveBeenCalled();
    expect(payload?.sessions).toHaveLength(1);
    expect(payload?.generatedAt).toBe(SNAPSHOT.generatedAt.toISOString());
  });

  it("sweeps in \"rescue\" mode when the snapshot month is empty (GRP-BOT-05 edge)", async () => {
    const { db } = makeDb([[SNAPSHOT], [STUDENT_ROW], []]);
    const payload = await getStudentMonthlySchedule(db, {
      studentKey: STUDENT.studentKey, monthKey: "2026-08", liveSweep: "rescue",
    });
    expect(fetchLiveMonthSessions).toHaveBeenCalledOnce();
    expect(payload?.sessions).toHaveLength(1); // the live-only session was rescued
  });

  it("treats an all-cancelled snapshot month as empty and still sweeps", async () => {
    const { db } = makeDb([[SNAPSHOT], [STUDENT_ROW], [cancelledRow()]]);
    await getStudentMonthlySchedule(db, {
      studentKey: STUDENT.studentKey, monthKey: "2026-08", liveSweep: "rescue",
    });
    expect(fetchLiveMonthSessions).toHaveBeenCalledOnce();
  });

  it("fails soft when the rescue sweep itself fails", async () => {
    vi.mocked(fetchLiveMonthSessions).mockResolvedValue({ sessions: [], ok: false });
    const { db } = makeDb([[SNAPSHOT], [STUDENT_ROW], []]);
    const payload = await getStudentMonthlySchedule(db, {
      studentKey: STUDENT.studentKey, monthKey: "2026-08", liveSweep: "rescue",
    });
    expect(payload?.sessions).toHaveLength(0);
    expect(payload?.generatedAt).toBe(SNAPSHOT.generatedAt.toISOString());
  });

  it("consumes only the sessions query when preResolved context is supplied", async () => {
    const { db, selectCount } = makeDb([[sessionRow()]]);
    const payload = await getStudentMonthlySchedule(db, {
      studentKey: STUDENT.studentKey,
      monthKey: "2026-08",
      liveSweep: "never",
      preResolved: { snapshot: SNAPSHOT, student: STUDENT_ROW },
    });
    expect(selectCount()).toBe(1);
    expect(payload?.student.studentName).toBe(STUDENT.studentName);
    expect(payload?.student.parentName).toBe(STUDENT.parentName);
  });
});
