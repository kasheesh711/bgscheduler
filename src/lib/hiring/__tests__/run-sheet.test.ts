import { describe, expect, it } from "vitest";
import {
  adminPrintListMessage,
  buildRunSheet,
  headUpcomingMessage,
  headVisits,
  MOCK_ONLY,
  needsReview,
  NO_MARK_SCHEME,
  NO_PASS_MARK,
  UNRECORDED_OWNER,
  unrecordedVisits,
  NO_ROOM,
  pastVisits,
  printDays,
  staffGap,
  replayRunSheet,
  upcoming,
  type RunSheetBooking,
  type RunSheetInput,
} from "../run-sheet";

const now = new Date("2026-11-18T02:00:00Z"); // 09:00 Bangkok
const booking = (over: Partial<RunSheetBooking>): RunSheetBooking => ({
  id: "b",
  candidateId: "c1",
  kind: "paper",
  subjects: ["Mathematics"],
  interviewerKey: null,
  startTime: "2026-11-18T03:00:00.000Z",
  status: "confirmed",
  visitId: null,
  ...over,
});
const base: RunSheetInput = {
  bookings: [],
  candidates: [
    { id: "c1", name: "Kim", visitSubject: null },
    { id: "c2", name: "Mai", visitSubject: "English Language" },
    { id: "c3", name: "Nat", visitSubject: null },
  ],
  config: {
    interviewers: [
      { canonicalKey: "Peat", subjects: ["Mathematics", "Physics"], email: "peat@x.com" },
      { canonicalKey: "Ek", subjects: ["Mathematics", "Physics"], email: "ek@x.com" },
      { canonicalKey: "Tito", subjects: ["English Language"], email: "tito@x.com" },
      { canonicalKey: "Gift", subjects: ["Economics"], email: "gift@x.com" },
    ],
    paperPassRules: [{ subject: "Mathematics" }],
  },
  library: [
    { id: "qp-m", kind: "question_paper", subject: "Mathematics", name: "Maths QP.pdf", status: "ready" },
    { id: "ms-m", kind: "mark_scheme", subject: "Mathematics", name: "Maths MS.pdf", status: "ready" },
    { id: "qp-e", kind: "question_paper", subject: "Economics", name: "Econ QP.pdf", status: "pending" },
  ],
  tutors: [{ canonicalKey: "Peat", name: "Peat Smith", email: null }],
  now,
};

describe("buildRunSheet", () => {
  it("groups a paper and mock into one visit and takes the booked head", () => {
    const rows = buildRunSheet({
      ...base,
      bookings: [
        booking({ id: "p", visitId: "v1" }),
        booking({ id: "m", kind: "mock", visitId: "v1", interviewerKey: "Peat", startTime: "2026-11-18T04:00:00.000Z" }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      visitId: "v1",
      date: "2026-11-18",
      paperStart: "10:00",
      mockStart: "11:00",
      candidateName: "Kim",
      subject: "Mathematics",
      hod: { key: "Peat", name: "Peat Smith", email: "peat@x.com", source: "booked" },
      hodReason: null,
      paper: { id: "qp-m", name: "Maths QP.pdf", markScheme: true },
      paperReason: null,
      room: null,
      roomReason: NO_ROOM,
      issues: [],
    });
  });

  it("takes the single roster head for a paper-only visit and marks a missing paper", () => {
    const [row] = buildRunSheet({ ...base, bookings: [booking({ candidateId: "c2", subjects: [] })] });
    expect(row.subject).toBe("English Language");
    expect(row.hod).toEqual({ key: "Tito", name: "Tito", email: "tito@x.com", source: "roster" });
    expect(row.paper).toBeNull();
    expect(row.paperReason).toBe("Needs review: no question paper for English Language in the paper library");
    expect(row.issues).toEqual([NO_MARK_SCHEME, NO_PASS_MARK]);
  });

  it("never picks between two roster heads, and never uses a paper that is not ready", () => {
    const rows = buildRunSheet({
      ...base,
      bookings: [booking({ id: "a" }), booking({ id: "b2", candidateId: "c3", subjects: ["Economics"] })],
    });
    expect(rows[0].hod).toBeNull();
    expect(rows[0].hodReason).toBe("Needs review: 2 heads take Mathematics");
    expect(rows[1].paper).toBeNull();
    expect(rows[1].hod?.key).toBe("Gift");
  });

  it("says no head and no subject instead of a guess", () => {
    const rows = buildRunSheet({
      ...base,
      bookings: [booking({ id: "x", subjects: ["Thai"] }), booking({ id: "y", candidateId: "c3", subjects: [] })],
    });
    expect(rows[0].hodReason).toBe("Needs review: no head takes Thai");
    expect(rows[1].subject).toBeNull();
    expect(rows[1].hodReason).toBe("Needs review: no subject");
    expect(rows[1].paperReason).toBe("Needs review: no subject");
  });

  it("keeps cancelled visits out of upcoming, ignores calls, and counts them in replay", () => {
    const rows = buildRunSheet({
      ...base,
      bookings: [
        booking({ id: "c", status: "cancelled" }),
        booking({ id: "call", kind: "call" }),
        booking({ id: "old", startTime: "2026-11-06T03:00:00.000Z", status: "no_show" }),
      ],
    });
    expect(rows).toHaveLength(2);
    expect(upcoming(rows, "2026-11-18")).toHaveLength(0);
    expect(pastVisits(rows, "2026-11-18").map((r) => r.visitId)).toEqual(["old"]);
    expect(replayRunSheet(rows).visits).toBe(2);
  });
});

describe("views and previews", () => {
  const rows = buildRunSheet({
    ...base,
    bookings: [
      booking({ id: "p1", visitId: "v1" }),
      booking({ id: "m1", kind: "mock", visitId: "v1", interviewerKey: "Peat", startTime: "2026-11-18T04:00:00.000Z" }),
      booking({ id: "p2", candidateId: "c2", subjects: [], startTime: "2026-11-19T03:00:00.000Z" }),
      booking({ id: "p3", candidateId: "c3", subjects: ["Physics"], startTime: "2026-11-25T03:00:00.000Z" }),
      booking({ id: "far", candidateId: "c3", startTime: "2026-12-20T03:00:00.000Z" }),
    ],
  });

  it("prints for today, tomorrow and the next 7 days only", () => {
    expect(printDays(rows, "2026-11-18")).toEqual(["2026-11-18", "2026-11-19", "2026-11-25"]);
  });

  it("the Aya preview lists the same visits as the day view", () => {
    for (const date of printDays(rows, "2026-11-18")) {
      const day = upcoming(rows, date).filter((r) => r.date === date);
      const text = adminPrintListMessage(rows, date);
      for (const r of day) expect(text).toContain(r.candidateName);
      expect(text.split("\n").length - 1).toBe(day.length);
    }
    expect(adminPrintListMessage(rows, "2026-11-18")).toContain("Room: " + NO_ROOM);
  });

  it("the head preview lists the same visits as the head view", () => {
    for (const head of ["Peat", "Ek", "Tito", "Gift"]) {
      const visits = headVisits(rows, head, "2026-11-18");
      const text = headUpcomingMessage(rows, head, "2026-11-18");
      expect(text.split("\n").length - 1).toBe(visits.length);
      for (const r of visits) expect(text).toContain(r.candidateName);
    }
    // Peat runs the Maths mock and sees the paper-only Physics visit; Ek sees only that paper-only visit.
    expect(headVisits(rows, "Peat", "2026-11-18").map((r) => r.visitId)).toEqual(["v1", "p3", "far"]);
    expect(headVisits(rows, "Ek", "2026-11-18").map((r) => r.visitId)).toEqual(["p3", "far"]);
    expect(headUpcomingMessage(rows, "Gift", "2026-11-18")).toContain("no upcoming visits");
  });

  it("replay counts every gap with an owner", () => {
    const replay = replayRunSheet(rows);
    expect(replay).toMatchObject({ visits: 4, withHod: 2, withPaper: 2, withBoth: 1, withRoom: 0 });
    expect(replay.gaps[NO_ROOM]).toBe(4);
    for (const gap of Object.keys(replay.gaps)) expect(replay.owners[gap]).toMatch(/^(Kevin|HR):/);
  });
});

describe("review fixes", () => {
  it("never names a roster head for a mock booked with no head", () => {
    const [row] = buildRunSheet({
      ...base,
      bookings: [booking({ id: "m", candidateId: "c2", kind: "mock", subjects: ["English Language"], interviewerKey: null })],
    });
    expect(row.hod).toBeNull();
    expect(row.hodReason).toBe("Needs review: no head is booked for this mock");
  });
  it("ignores a library file with no status (fail-closed)", () => {
    const [row] = buildRunSheet({
      ...base,
      library: [{ id: "qp-m", kind: "question_paper", subject: "Mathematics", name: "Maths QP.pdf" }],
      bookings: [booking({})],
    });
    expect(row.paper).toBeNull();
    expect(row.issues).toContain(NO_MARK_SCHEME);
  });

  it("flags a booking with several subjects instead of dropping them", () => {
    const [row] = buildRunSheet({ ...base, bookings: [booking({ subjects: ["Mathematics", "Physics"] })] });
    expect(row.subject).toBe("Mathematics");
    expect(row.issues).toContain("Needs review: 2 subjects (Mathematics, Physics), only Mathematics is shown");
    expect(replayRunSheet([row]).owners[row.issues[0]]).toBe("HR: book one subject per visit");
  });

  it("shows a mock-only visit with no paper to print and no paper gap", () => {
    const [row] = buildRunSheet({
      ...base,
      bookings: [booking({ id: "m", kind: "mock", interviewerKey: "Peat" })],
    });
    expect(row.paper).toBeNull();
    expect(row.paperReason).toBe(MOCK_ONLY);
    expect(row.issues).toEqual([]);
    expect(staffGap(row)).toBe(false);
    expect(needsReview(row)).toBe(true); // still no room
    expect(replayRunSheet([row]).gaps[MOCK_ONLY]).toBeUndefined();
    expect(adminPrintListMessage([row], "2026-11-18")).toContain(`Paper: ${MOCK_ONLY}.`);
  });

  it("falls back to the roster head when the mock part is cancelled", () => {
    const [row] = buildRunSheet({
      ...base,
      bookings: [
        booking({ id: "p", visitId: "v", candidateId: "c2", subjects: ["English Language"] }),
        booking({ id: "m", kind: "mock", visitId: "v", candidateId: "c2", subjects: ["English Language"], interviewerKey: "Peat", status: "cancelled" }),
      ],
    });
    expect(row.mockStart).toBeNull();
    expect(row.hod).toMatchObject({ key: "Tito", source: "roster" });
    expect(row.status).toBe("confirmed");
  });

  it("says when the candidate record is missing", () => {
    const [row] = buildRunSheet({ ...base, bookings: [booking({ candidateId: "gone" })] });
    expect(row.candidateName).toBe("Needs review: candidate record not found");
  });

  it("puts a 17:30Z booking on the next Bangkok day", () => {
    const [row] = buildRunSheet({ ...base, bookings: [booking({ startTime: "2026-11-18T17:30:00.000Z" })] });
    expect(row.date).toBe("2026-11-19");
    expect(row.paperStart).toBe("00:30");
  });

  it("names the head from the tutor list in the head preview, even with only paper-only visits", () => {
    const rows = buildRunSheet({ ...base, bookings: [booking({ subjects: ["Physics"] })] });
    expect(headUpcomingMessage(rows, "Peat", "2026-11-18", base.tutors)).toMatch(/^Peat Smith: 1 upcoming visit\./);
  });
});

describe("booked-stage candidates with no booking row", () => {
  const stageIn = (stage: string, updatedAt = "2026-11-10T00:00:00Z") => ({
    ...base,
    candidates: [{ id: "c1", name: "Kim", visitSubject: "Mathematics", stage, updatedAt }],
  });
  it.each(["onsite_booked", "paper_booked", "mock_booked"])("lists %s in unrecordedVisits, never as a dated row", (stage) => {
    const input = stageIn(stage);
    expect(buildRunSheet(input)).toHaveLength(0);
    const [u] = unrecordedVisits(input);
    expect(u.candidateName).toBe("Kim");
    expect(u.stage).toBe(stage);
    expect(u.head).toContain("2 heads take Mathematics");
    expect(u.paper).toBe("Maths QP.pdf");
    expect(u.owner).toBe(UNRECORDED_OWNER);
    const replay = replayRunSheet([], unrecordedVisits(input).length);
    expect(replay.visits).toBe(0);
    expect(replay.unrecordedVisits).toBe(1);
  });
  it("skips a candidate with a confirmed booking, a non-booked stage, or an update older than 8 weeks", () => {
    expect(unrecordedVisits({ ...stageIn("onsite_booked"), bookings: [booking({})] })).toHaveLength(0);
    expect(unrecordedVisits(stageIn("invited"))).toHaveLength(0);
    expect(unrecordedVisits(stageIn("onsite_booked", "2026-08-01T00:00:00Z"))).toHaveLength(0);
  });
});
