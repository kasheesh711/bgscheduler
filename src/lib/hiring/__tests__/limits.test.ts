import { describe, expect, it } from "vitest";
import { configSchema, type HiringConfig, type Subject } from "../model";
import {
  bangkokDayStart,
  bangkokWeekStart,
  blockingLimit,
  headWeekMocks,
  mergeManualOrder,
  onsiteMeters,
  preScreenMeters,
  rankQueue,
  releaseQueue,
  type LimitUsage,
  type QueueEntry,
} from "../limits";

const cfg = (extra: Partial<HiringConfig> = {}): HiringConfig => configSchema.parse(extra);
const usage = (extra: Partial<LimitUsage> = {}): LimitUsage => ({
  perDay: 0,
  perWeek: 0,
  waiting: 0,
  unbooked: 0,
  bySubject: {},
  ...extra,
});
const entry = (id: string, subject: Subject, score = 50, day = 1): QueueEntry => ({
  id,
  subject,
  score,
  createdAt: new Date(Date.UTC(2026, 9, day)),
});
const many = (n: number, subject: Subject = "Mathematics") =>
  Array.from({ length: n }, (_, i) => entry(`c${String(i).padStart(2, "0")}`, subject, 100 - i));
const ids = (rows: QueueEntry[]) => rows.map((r) => r.id);
// Wide weekly and waiting limits, so one limit at a time is under test.
const wide = { perWeek: 1000, waiting: 1000 };

describe("rankQueue", () => {
  it("orders by subject rank, then score, then earliest application, then id", () => {
    const config = cfg();
    const rows = [
      entry("a", "Physics", 90, 5),
      entry("b", "Mathematics", 10, 5),
      entry("c", "Mathematics", 80, 5),
      entry("e", "Mathematics", 80, 2),
      entry("d", "Mathematics", 80, 2),
    ];
    expect(ids(rankQueue(rows, config.subjectPriority))).toEqual(["d", "e", "c", "b", "a"]);
  });

  it("does not change the input and gives the same result for any input order", () => {
    const rows = [entry("x", "Physics", 1), entry("y", "Mathematics", 1), entry("z", "Mathematics", 1)];
    const copy = [...rows];
    const a = ids(rankQueue(rows, cfg().subjectPriority));
    expect(rows).toEqual(copy);
    expect(ids(rankQueue([...rows].reverse(), cfg().subjectPriority))).toEqual(a);
  });

  it("puts a subject missing from the priority list last", () => {
    const priority = [{ subject: "Physics" as const, hiring: true }];
    expect(ids(rankQueue([entry("m", "Mathematics", 99), entry("p", "Physics", 1)], priority))).toEqual(["p", "m"]);
  });
});

describe("manual queue order", () => {
  const drag = (row: QueueEntry, ahead: string[], movedAt = "2026-11-02T00:00:00Z") => ({ ...row, manual: { ahead, movedAt } });
  const [c0, c1, c2, c3] = many(4);
  it("places a dragged row after the people ahead of it, and leaves the others in rank order", () => {
    expect(ids(mergeManualOrder([c0, c1, c2, drag(c3, ["c00"])]))).toEqual(["c00", "c03", "c01", "c02"]);
    expect(ids(mergeManualOrder([c0, c1, c2, drag(c3, [])]))).toEqual(["c03", "c00", "c01", "c02"]);
  });
  it("keeps the place when the person ahead has left the queue", () => {
    expect(ids(mergeManualOrder([c1, c2, drag(c3, ["c00"])]))).toEqual(["c03", "c01", "c02"]);
    expect(ids(mergeManualOrder([c0, c2, drag(c3, ["c00", "c01"])]))).toEqual(["c00", "c03", "c02"]);
  });
  it("follows the current order when a re-rank changes who stood ahead", () => {
    const ranked = [c2, c0, c1, drag(c3, ["c00", "c01", "c02"])];
    expect(ids(mergeManualOrder(ranked))).toEqual(["c02", "c00", "c01", "c03"]);
  });
  it("keeps a person parked at the back behind later arrivals' earlier neighbours when everyone ahead has left", () => {
    const later = (id: string) => ({ ...entry(id, "Mathematics", 90), createdAt: new Date("2026-12-01T00:00:00Z") });
    expect(ids(mergeManualOrder([later("n1"), later("n2"), drag(c3, ["c00", "c01"])]))).toEqual(["n1", "n2", "c03"]);
    expect(ids(mergeManualOrder([later("n1"), c2, drag(c3, ["c00"])]))).toEqual(["n1", "c03", "c02"]);
  });
  it("lets the latest of two drags win", () => {
    const rows = [c0, drag(c1, ["c00", "c02"], "2026-11-01T00:00:00Z"), c2, drag(c3, ["c00"], "2026-11-02T00:00:00Z")];
    expect(ids(mergeManualOrder(rows))).toEqual(["c00", "c03", "c02", "c01"]);
  });
  it("gives a new arrival its automatic place, which can be above a dragged row", () => {
    const fresh = entry("new", "Mathematics", 99.5);
    const ranked = rankQueue([c0, c1, c2, drag(c3, ["c02"]), fresh], cfg().subjectPriority);
    expect(ids(mergeManualOrder(ranked))).toEqual(["c00", "new", "c01", "c02", "c03"]);
  });
  it("controls what the walk releases, and the limits still apply", () => {
    const config = cfg({ preScreenLimits: { perDay: 2, ...wide, perSubject: 1000 } });
    const { release, order } = releaseQueue("pre_screen", [c0, c1, c2, drag(c3, [])], usage(), config);
    expect(ids(release)).toEqual(["c03", "c00"]);
    expect(order).toEqual(["c03", "c00", "c01", "c02"]);
  });
  it("skips a dragged person whose subject is full, and the next person goes", () => {
    const config = cfg({ preScreenLimits: { perDay: 1, ...wide, perSubject: 1 } });
    const physics = entry("p", "Physics", 1);
    const { release, held } = releaseQueue("pre_screen", [c0, physics].map((r) => (r.id === "c00" ? drag(r, []) : r)), usage({ bySubject: { Mathematics: 1 } }), config);
    expect(ids(release)).toEqual(["p"]);
    expect(held[0]).toMatchObject({ id: "c00", position: 1, limit: "perSubject" });
  });
  it("never applies a drag to the onsite queue", () => {
    const config = cfg();
    const { order } = releaseQueue("onsite", [c0, c1, drag(c2, [])], usage(), config);
    expect(order).toEqual(["c00", "c01", "c02"]);
  });
});

describe("releaseQueue", () => {
  it("releases 5 of 40 at a daily limit of 5, and holds 35 with positions", () => {
    const config = cfg({ preScreenLimits: { perDay: 5, ...wide, perSubject: 1000 } });
    const { release, held } = releaseQueue("pre_screen", many(40), usage(), config);
    expect(release).toHaveLength(5);
    expect(ids(release)).toEqual(["c00", "c01", "c02", "c03", "c04"]);
    expect(held).toHaveLength(35);
    // The place counts released rows too, so it matches the numbered list on the screen.
    expect(held.map((h) => h.position)).toEqual(Array.from({ length: 35 }, (_, i) => i + 6));
    expect(new Set(held.map((h) => h.limit))).toEqual(new Set(["perDay"]));
  });

  it("releases 0 on a second run the same day", () => {
    const config = cfg({ preScreenLimits: { perDay: 5, ...wide, perSubject: 1000 } });
    const { release, held } = releaseQueue("pre_screen", many(40), usage({ perDay: 5 }), config);
    expect(release).toEqual([]);
    expect(held).toHaveLength(40);
  });

  it("applies the per-subject limit while walking the queue", () => {
    const config = cfg({ preScreenLimits: { perDay: 1000, ...wide, perSubject: 3 } });
    const rows = [...many(5, "Mathematics"), entry("p1", "Physics", 1), entry("p2", "Physics", 1)];
    const { release, held } = releaseQueue("pre_screen", rows, usage(), config);
    expect(ids(release)).toEqual(["c00", "c01", "c02", "p1", "p2"]);
    expect(held.map((h) => [h.id, h.position, h.limit])).toEqual([
      ["c03", 4, "perSubject"],
      ["c04", 5, "perSubject"],
    ]);
  });

  it("counts the subject use already recorded", () => {
    const config = cfg({ preScreenLimits: { perDay: 1000, ...wide, perSubject: 3 } });
    const { release } = releaseQueue("pre_screen", many(5), usage({ bySubject: { Mathematics: 2 } }), config);
    expect(ids(release)).toEqual(["c00"]);
  });

  it("excludes a not-hiring subject from release and from held", () => {
    const config = cfg({
      subjectPriority: [
        { subject: "Mathematics", hiring: true },
        { subject: "Physics", hiring: false },
      ],
    });
    const rows = [entry("m", "Mathematics"), entry("p", "Physics"), entry("c", "Chemistry")];
    const { release, held } = releaseQueue("pre_screen", rows, usage(), config);
    expect(ids(release)).toEqual(["m"]);
    expect(held).toEqual([]);
  });

  it("releases nothing when a limit is 0 or lowered below use", () => {
    const low = cfg({ preScreenLimits: { perDay: 2, ...wide, perSubject: 1000 } });
    expect(releaseQueue("pre_screen", many(3), usage({ perDay: 5 }), low).release).toEqual([]);
    const zero = cfg({ preScreenLimits: { perDay: 0, ...wide, perSubject: 1000 } });
    expect(releaseQueue("pre_screen", many(3), usage(), zero).release).toEqual([]);
  });

  it("counts a released row against the waiting limit", () => {
    const config = cfg({ preScreenLimits: { perDay: 1000, perWeek: 1000, waiting: 4, perSubject: 1000 } });
    const { release, held } = releaseQueue("pre_screen", many(6), usage({ waiting: 2 }), config);
    expect(release).toHaveLength(2);
    expect(held[0].limit).toBe("waiting");
  });

  it("uses the onsite limits for the onsite funnel and ignores perDay", () => {
    const config = cfg({
      preScreenLimits: { perDay: 0, perWeek: 0, waiting: 0, perSubject: 0 },
      onsiteLimits: { perWeek: 3, unbooked: 2, perHeadPerWeek: 0, perSubject: 1000 },
    });
    const { release, held } = releaseQueue("onsite", many(5), usage({ perDay: 99 }), config);
    expect(release).toHaveLength(2);
    expect(held[0].limit).toBe("unbooked");
  });

  it("gives the same answer twice for the same input", () => {
    const rows = many(12);
    const a = releaseQueue("pre_screen", rows, usage(), cfg());
    const b = releaseQueue("pre_screen", [...rows].reverse(), usage(), cfg());
    expect(b).toEqual(a);
  });

  it("does not change the usage it was given", () => {
    const u = usage();
    releaseQueue("pre_screen", many(3), u, cfg());
    expect(u).toEqual(usage());
  });
});

describe("blockingLimit", () => {
  it("names the blocking limit", () => {
    expect(blockingLimit("onsite", "Physics", usage({ unbooked: 2 }), cfg())).toBe("unbooked");
    expect(blockingLimit("pre_screen", "Physics", usage({ perDay: 5 }), cfg())).toBe("perDay");
    expect(blockingLimit("pre_screen", "Physics", usage({ perWeek: 15 }), cfg())).toBe("perWeek");
    expect(blockingLimit("pre_screen", "Physics", usage({ waiting: 15 }), cfg())).toBe("waiting");
    expect(blockingLimit("pre_screen", "Physics", usage({ bySubject: { Physics: 3 } }), cfg())).toBe("perSubject");
    expect(blockingLimit("pre_screen", "Physics", usage(), cfg())).toBeNull();
  });

  it("never lets a limit the funnel does not have be the blocker", () => {
    expect(blockingLimit("onsite", "Physics", usage({ perDay: 99, waiting: 99 }), cfg())).toBeNull();
    expect(blockingLimit("pre_screen", "Physics", usage({ unbooked: 99 }), cfg())).toBeNull();
  });
});

describe("Bangkok boundaries", () => {
  it("uses Bangkok boundaries", () => {
    expect(bangkokDayStart(new Date("2026-11-01T17:00:00Z")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(bangkokDayStart(new Date("2026-11-01T16:59:00Z")).toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(bangkokWeekStart(new Date("2026-11-01T16:59:00Z")).toISOString()).toBe("2026-10-25T17:00:00.000Z");
    expect(bangkokWeekStart(new Date("2026-11-01T17:00:00Z")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(bangkokWeekStart(new Date("2026-11-04T05:00:00Z")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("does not depend on the process time zone", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(bangkokDayStart(new Date("2026-11-01T17:00:00Z")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
      expect(bangkokWeekStart(new Date("2026-11-01T16:59:00Z")).toISOString()).toBe("2026-10-25T17:00:00.000Z");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe("meters", () => {
  const names = { Peat: "Peat", Ek: "Ek" };
  const config = cfg({
    interviewers: [
      { canonicalKey: "Peat", email: "p@example.com", subjects: ["Mathematics"] },
      { canonicalKey: "Ek", email: "e@example.com", subjects: ["Physics"] },
    ],
  });

  it("builds the pre-screen meters from usage and the limits, with a full one marked", () => {
    const rows = preScreenMeters(
      usage({ perDay: 5, perWeek: 12, waiting: 9, bySubject: { Mathematics: 2, Physics: 3 } }),
      config,
    );
    expect(rows).toEqual([
      { label: "Sent today", used: 5, max: 5, over: 0, pct: 100, full: true },
      { label: "Sent this week", used: 12, max: 15, over: 0, pct: 80, full: false },
      { label: "Waiting for reply", used: 9, max: 15, over: 0, pct: 60, full: false },
      { label: "Mathematics open", used: 2, max: 3, over: 0, pct: 67, full: false },
      { label: "Physics open", used: 3, max: 3, over: 0, pct: 100, full: true },
    ]);
  });

  it("builds the onsite meters, one per head, and counts a limit of 0 as full", () => {
    const rows = onsiteMeters(usage({ perWeek: 2, unbooked: 1, bySubject: { Mathematics: 1 } }), { Peat: 1 }, config, names);
    expect(rows.map((r) => [r.label, r.used, r.max])).toEqual([
      ["Invited this week", 2, 3],
      ["Not booked", 1, 2],
      ["Peat this week", 1, 2],
      ["Ek this week", 0, 2],
      ["Mathematics open", 1, 2],
    ]);
    const closed = onsiteMeters(usage(), {}, cfg({ onsiteLimits: { perWeek: 0, unbooked: 2, perHeadPerWeek: 2, perSubject: 2 } }), names);
    expect(closed[0]).toMatchObject({ used: 0, max: 0, pct: 100, full: true });
  });

  it("reports how far use is over a limit that was lowered, and still calls it full", () => {
    const rows = preScreenMeters(usage({ perDay: 17, perWeek: 3 }), cfg({ preScreenLimits: { perDay: 12, perWeek: 15, waiting: 15, perSubject: 3 } }));
    expect(rows[0]).toEqual({ label: "Sent today", used: 17, max: 12, over: 5, pct: 100, full: true });
    expect(rows[1].over).toBe(0);
  });

  it("counts this Bangkok week's confirmed mocks per head", () => {
    const at = new Date("2026-11-04T05:00:00Z");
    const mock = (interviewerKey: string | null, startTime: string, status = "confirmed", kind = "mock") => ({
      kind,
      status,
      interviewerKey,
      startTime: new Date(startTime),
    });
    expect(
      headWeekMocks(
        [
          mock("Peat", "2026-11-02T05:00:00Z"),
          mock("Peat", "2026-11-06T05:00:00Z"),
          mock("Ek", "2026-11-03T05:00:00Z"),
          mock("Peat", "2026-11-03T05:00:00Z", "cancelled"),
          mock("Peat", "2026-11-04T05:00:00Z", "no_show"),
          mock(null, "2026-11-04T05:00:00Z", "confirmed", "paper"),
          mock("Peat", "2026-11-09T05:00:00Z"),
          mock("Peat", "2026-11-01T16:59:00Z"),
        ],
        at,
      ),
    ).toEqual({ Peat: 2, Ek: 1 });
  });
});
