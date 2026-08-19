// ----------------------------------------------------------------------------
// Credit-digest suite: the pure run-out classifier and the once-daily sender.
// ----------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

import { computeCreditRunouts, sendLineCreditDigest } from "@/lib/line/credit-digest";
import type { Database } from "@/lib/db";

const TODAY = "2026-08-05";
const NOW = new Date("2026-08-05T02:03:00Z"); // 09:03 Bangkok
const SNAP = { id: "snap-1", generatedAt: new Date("2026-08-05T01:50:00Z") };

/** A Bangkok mid-morning instant on the given Bangkok date. */
function bkk(dateKey: string, hour = 10): Date {
  return new Date(`${dateKey}T${String(hour).padStart(2, "0")}:00:00+07:00`);
}

function pkg(overrides: Record<string, unknown> = {}) {
  return {
    studentKey: "teethad (copter.th) thamprida::kanokwan thamprida",
    packageKey: "pkg-1",
    studentName: "Teethad (Copter.Th) Thamprida",
    subject: "Physics",
    packageName: "Physics 10",
    remainingCredits: 1.5,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    packageKey: "pkg-1",
    scheduledStartTime: bkk("2026-08-06"),
    durationMinutes: 90,
    ...overrides,
  };
}

const NO_INACTIVE = new Set<string>();

describe("computeCreditRunouts", () => {
  it("flags a package whose class drains it to ≤ 0 within the window", () => {
    const { runsOut, alreadyOut } = computeCreditRunouts({
      packages: [pkg()], // 1.5 credits, one 90-min class tomorrow → 0
      sessions: [session()],
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(alreadyOut).toHaveLength(0);
    expect(runsOut).toEqual([{
      exhaustDateBkk: "2026-08-06",
      label: "Copter.Th",
      subject: "Physics",
      remainingCredits: 1.5,
      studentKey: pkg().studentKey,
    }]);
  });

  it("walks multiple sessions with duration/60 deductions to find the exhaust day", () => {
    // 2.5 credits, one 60-min class on each of the next three days → dies day 3.
    const sessions = ["2026-08-06", "2026-08-07", "2026-08-08"].map((day) =>
      session({ scheduledStartTime: bkk(day), durationMinutes: 60 }));

    const { runsOut } = computeCreditRunouts({
      packages: [pkg({ remainingCredits: 2.5 })],
      sessions,
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(runsOut).toEqual([expect.objectContaining({ exhaustDateBkk: "2026-08-08" })]);
  });

  it("ignores a package that only exhausts beyond the window", () => {
    const { runsOut } = computeCreditRunouts({
      packages: [pkg({ remainingCredits: 1 })],
      sessions: [session({ scheduledStartTime: bkk("2026-08-20"), durationMinutes: 60 })],
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(runsOut).toHaveLength(0);
  });

  it("buckets an already-negative package with booked classes as already out", () => {
    const { runsOut, alreadyOut } = computeCreditRunouts({
      packages: [pkg({ remainingCredits: -1.5 })],
      sessions: [session({ scheduledStartTime: bkk(TODAY, 16) })], // later today
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(runsOut).toHaveLength(0);
    expect(alreadyOut).toEqual([{
      label: "Copter.Th",
      subject: "Physics",
      remainingCredits: -1.5,
      nextClassBkk: TODAY,
      studentKey: pkg().studentKey,
    }]);
  });

  it("does not report a dead package with no upcoming classes", () => {
    const result = computeCreditRunouts({
      packages: [pkg({ remainingCredits: 0 })],
      sessions: [],
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(result).toEqual({ runsOut: [], alreadyOut: [] });
  });

  it("skips students on the inactive list", () => {
    const { runsOut } = computeCreditRunouts({
      packages: [pkg()],
      sessions: [session()],
      inactiveStudentKeys: new Set([pkg().studentKey]),
      todayBkk: TODAY,
    });

    expect(runsOut).toHaveLength(0);
  });

  it("buckets sessions by the Bangkok calendar day, not the UTC one", () => {
    // 23:30 UTC on the 5th = 06:30 Bangkok on the 6th → strictly-future, so a
    // 1-credit package with this 60-min class dies on the Bangkok 6th.
    const { runsOut } = computeCreditRunouts({
      packages: [pkg({ remainingCredits: 1 })],
      sessions: [session({
        scheduledStartTime: new Date("2026-08-05T23:30:00Z"),
        durationMinutes: 60,
      })],
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(runsOut).toEqual([expect.objectContaining({ exhaustDateBkk: "2026-08-06" })]);
  });

  it("excludes today's class from the projection (dashboard parity)", () => {
    // 0.5 credits with only today's class: positive balance, nothing strictly
    // future → not flagged today. Tomorrow's digest catches it as already-out
    // if classes remain.
    const { runsOut, alreadyOut } = computeCreditRunouts({
      packages: [pkg({ remainingCredits: 0.5 })],
      sessions: [session({ scheduledStartTime: bkk(TODAY, 17), durationMinutes: 60 })],
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(runsOut).toHaveLength(0);
    expect(alreadyOut).toHaveLength(0);
  });

  it("sorts run-outs by date then label", () => {
    const { runsOut } = computeCreditRunouts({
      packages: [
        pkg({ packageKey: "late", studentName: "Zed (Zed.Aa) A", remainingCredits: 1 }),
        pkg({ packageKey: "early", studentName: "Ann (Ann.Bb) B", remainingCredits: 1 }),
      ],
      sessions: [
        session({ packageKey: "late", scheduledStartTime: bkk("2026-08-08"), durationMinutes: 60 }),
        session({ packageKey: "early", scheduledStartTime: bkk("2026-08-06"), durationMinutes: 60 }),
      ],
      inactiveStudentKeys: NO_INACTIVE,
      todayBkk: TODAY,
    });

    expect(runsOut.map((row) => row.label)).toEqual(["Ann.Bb", "Zed.Aa"]);
  });
});

// ── sendLineCreditDigest ────────────────────────────────────────────────

/**
 * Chainable stand-in with select queue + insert/update recording. Inserts can
 * be made to throw (the 23505 concurrent-create race).
 */
function makeDb(selectResults: unknown[][], options: { insertError?: unknown } = {}) {
  const queue = [...selectResults];
  const inserts: unknown[] = [];
  const updates: unknown[] = [];

  function chain(result: unknown[]) {
    const node: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy"]) {
      node[method] = () => node;
    }
    node.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
    node.catch = () => node;
    return node;
  }

  const db = {
    select: () => chain(queue.shift() ?? []),
    insert: () => ({
      values: (row: unknown) => {
        if (options.insertError) return { returning: () => Promise.reject(options.insertError) };
        inserts.push(row);
        return { returning: () => Promise.resolve([{ id: "run-1" }]) };
      },
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  return { db: db as unknown as Database, inserts, updates };
}

const STAFF_GROUP = { groupId: "Cstaff000000000000000000000000001" };

/**
 * Select queue for a full send: terminal-check, snapshot, the 4-way load,
 * then the admin-ownership lookup (raw credit_control_admin_ownership rows;
 * consumed only when at least one package was flagged).
 */
function fullQueue({
  packages = [pkg()],
  sessions = [session()],
  inactive = [] as Array<{ studentKey: string }>,
  groups = [STAFF_GROUP],
  ownership = [] as Array<{ studentKey: string; adminKey: string }>,
} = {}) {
  return [[], [SNAP], packages, sessions, inactive, groups, ownership];
}

function okPush() {
  return vi.fn().mockResolvedValue({ retryKey: "r", sentMessageId: "m", response: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_CHANNEL_SECRET = "secret";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "token";
  delete process.env.ENABLE_LINE_SCHEDULER;
});

describe("sendLineCreditDigest", () => {
  it("pushes one digest per registered group and finalizes the run", async () => {
    const push = okPush();
    const { db, inserts, updates } = makeDb(fullQueue());

    const result = await sendLineCreditDigest(db, NOW, { push, baseUrl: "https://example.test" });

    expect(result.status).toBe("sent");
    expect(result).toMatchObject({
      digestDate: TODAY, runsOutCount: 1, alreadyOutCount: 0,
      groupCount: 1, attempted: 1, success: 1, failed: 0,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ digestDate: TODAY, idempotencyKey: `line-credit-digest:${TODAY}` });
    expect(updates.at(-1)).toMatchObject({ status: "sent", successCount: 1 });

    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0][0];
    expect(arg.to).toBe(STAFF_GROUP.groupId);
    expect(arg.retryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(arg.text).toContain("⚠️ Credit runout — next 7 days (5/8/2026)");
    expect(arg.text).toContain("6/8 (Thu)");
    expect(arg.text).toContain("• Copter.Th — Physics (1.5 left)");
    // No ownership rows → the solo Unassigned section keeps the legacy shape.
    expect(arg.text).not.toContain("👤");
    expect(arg.text).toContain("Dashboard: https://example.test/credit-control");
  });

  it("sections the digest by assigned admin from the ownership table", async () => {
    const push = okPush();
    const otherStudent = {
      ...pkg(),
      studentKey: "ann (ann.bb) b::parent b",
      packageKey: "pkg-2",
      studentName: "Ann (Ann.Bb) B",
      subject: "Biology",
    };
    const { db } = makeDb(fullQueue({
      packages: [pkg(), otherStudent],
      sessions: [
        session(),
        session({ packageKey: "pkg-2", scheduledStartTime: bkk("2026-08-07"), durationMinutes: 90 }),
      ],
      ownership: [
        { studentKey: pkg().studentKey, adminKey: "kem" },
        // Ann has no ownership row → Unassigned.
      ],
    }));

    const result = await sendLineCreditDigest(db, NOW, { push, baseUrl: "https://example.test" });

    expect(result.status).toBe("sent");
    const text: string = push.mock.calls[0][0].text;
    const kemAt = text.indexOf("👤 Kem");
    const unassignedAt = text.indexOf("👤 Unassigned");
    expect(kemAt).toBeGreaterThan(-1);
    expect(unassignedAt).toBeGreaterThan(kemAt);
    expect(text.slice(kemAt, unassignedAt)).toContain("• Copter.Th — Physics (1.5 left)");
    expect(text.slice(unassignedAt)).toContain("• Ann.Bb — Biology (1.5 left)");
  });

  it("uses the same retry key for the same date and group on every run", async () => {
    const pushA = okPush();
    const pushB = okPush();
    const a = makeDb(fullQueue());
    const b = makeDb(fullQueue());

    await sendLineCreditDigest(a.db, NOW, { push: pushA, baseUrl: "https://example.test" });
    await sendLineCreditDigest(b.db, NOW, { push: pushB, baseUrl: "https://example.test" });

    expect(pushA.mock.calls[0][0].retryKey).toBe(pushB.mock.calls[0][0].retryKey);
  });

  it("sends the all-clear heartbeat when nothing is running out", async () => {
    const push = okPush();
    const { db, updates } = makeDb(fullQueue({ packages: [], sessions: [] }));

    const result = await sendLineCreditDigest(db, NOW, { push, baseUrl: "https://example.test" });

    expect(result.status).toBe("sent");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].text).toContain("✅ Credit check (5/8/2026) — no students running out");
    expect(updates.at(-1)).toMatchObject({ status: "sent" });
  });

  it("short-circuits when a run already exists for the date", async () => {
    const push = okPush();
    const { db, inserts } = makeDb([[{ id: "existing" }]]);

    const result = await sendLineCreditDigest(db, NOW, { push });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("already recorded");
    expect(inserts).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("skips without a terminal row when no snapshot is active", async () => {
    const push = okPush();
    const { db, inserts } = makeDb([[], []]);

    const result = await sendLineCreditDigest(db, NOW, { push });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("No active credit-control snapshot");
    expect(inserts).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("records a terminal skipped run when no group is registered", async () => {
    const push = okPush();
    const { db, inserts, updates } = makeDb(fullQueue({ groups: [] }));

    const result = await sendLineCreditDigest(db, NOW, { push });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("/credit setup");
    expect(inserts).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ status: "skipped" });
    expect(push).not.toHaveBeenCalled();
  });

  it("treats a lost concurrent-create race as skipped", async () => {
    const push = okPush();
    const { db } = makeDb(fullQueue(), { insertError: Object.assign(new Error("dup"), { code: "23505" }) });

    const result = await sendLineCreditDigest(db, NOW, { push });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("concurrently");
    expect(push).not.toHaveBeenCalled();
  });

  it("marks partial when one of two groups fails", async () => {
    const push = vi.fn()
      .mockResolvedValueOnce({ retryKey: "r", sentMessageId: "m", response: {} })
      .mockRejectedValueOnce(new Error("push down"));
    const { db, updates } = makeDb(fullQueue({
      groups: [STAFF_GROUP, { groupId: "Cstaff000000000000000000000000002" }],
    }));

    const result = await sendLineCreditDigest(db, NOW, { push });

    expect(result.status).toBe("partial");
    expect(result).toMatchObject({ attempted: 2, success: 1, failed: 1 });
    expect(updates.at(-1)).toMatchObject({ status: "partial", failedCount: 1, lastError: "push down" });
  });

  it("skips when the LINE scheduler is disabled", async () => {
    process.env.ENABLE_LINE_SCHEDULER = "false";
    const push = okPush();
    const { db } = makeDb([]);

    const result = await sendLineCreditDigest(db, NOW, { push });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("disabled");
    expect(push).not.toHaveBeenCalled();
  });
});
