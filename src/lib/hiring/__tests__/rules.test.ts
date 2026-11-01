import { describe, expect, it } from "vitest";
import {
  baseConfigSchema,
  configRuleErrors,
  configSchema,
  SUBJECTS,
  VISIT_LINK_DAYS,
  type HiringConfig,
} from "../model";
import { answerKey } from "../scoring";
import {
  daysOf,
  fullPriority,
  hasSavedHours,
  headDayState,
  LIMIT_FIELDS,
  minutesToTime,
  movePriority,
  sendingNotice,
  setHiring,
  setLimit,
  setWorkRightsAccepted,
  settingsProblems,
  startsSending,
  timeToMinutes,
  weekWith,
  workRightsRows,
} from "../rules";
import type { Week } from "@/lib/tutor-attendance/model";

const base = (extra: Record<string, unknown> = {}): HiringConfig => configSchema.parse(extra);
const win = { start: "10:00", end: "16:00" };
const MON_FRI: Week = [null, win, win, win, win, win, null];

describe("config rules", () => {
  it("accepts the defaults, so every stored config from before these rules still parses", () => {
    expect(configSchema.safeParse({}).success).toBe(true);
    expect(configRuleErrors(base())).toEqual([]);
    // An old stored row with only some keys.
    expect(configSchema.safeParse({ enabled: false, profileThreshold: 55 }).success).toBe(true);
    expect(VISIT_LINK_DAYS).toBe(30);
  });
  it("refuses a visit that ends at or before its start", () => {
    expect(configSchema.safeParse({ visitStartMinute: 600, visitEndMinute: 600 }).success).toBe(false);
    expect(configSchema.safeParse({ visitStartMinute: 700, visitEndMinute: 600 }).success).toBe(false);
    expect(configSchema.safeParse({ visitStartMinute: 600, visitEndMinute: 601 }).success).toBe(true);
  });
  it.each(["preScreenFollowUp", "onsiteFollowUp"])("needs the reminder before the end in %s", (key) => {
    expect(configSchema.safeParse({ [key]: { remindDays: 7, expireDays: 7 } }).success).toBe(false);
    expect(configSchema.safeParse({ [key]: { remindDays: 8, expireDays: 7 } }).success).toBe(false);
    expect(configSchema.safeParse({ [key]: { remindDays: 6, expireDays: 7 } }).success).toBe(true);
  });
  it("keeps the onsite expiry within the 30 days the link lives", () => {
    expect(configSchema.safeParse({ onsiteFollowUp: { remindDays: 3, expireDays: 30 } }).success).toBe(true);
    const bad = configSchema.safeParse({ onsiteFollowUp: { remindDays: 3, expireDays: 31 } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("30 days");
    // The form has no link, so its expiry may be longer.
    expect(configSchema.safeParse({ preScreenFollowUp: { remindDays: 3, expireDays: 60 } }).success).toBe(true);
  });
  it("refuses a subject twice in the priority list", () => {
    const list = [
      { subject: "Physics", hiring: true },
      { subject: "Mathematics", hiring: true },
      { subject: "Physics", hiring: false },
    ];
    expect(configSchema.safeParse({ subjectPriority: list }).success).toBe(false);
    expect(configSchema.safeParse({ subjectPriority: list.slice(0, 2) }).success).toBe(true);
  });
  it("lets a stored config that breaks a rule load, and names the problems so a save can repair it", () => {
    const stored = {
      visitStartMinute: 900,
      visitEndMinute: 600,
      onsiteFollowUp: { remindDays: 40, expireDays: 40 },
      subjectPriority: [
        { subject: "Physics", hiring: true },
        { subject: "Physics", hiring: true },
      ],
    };
    expect(configSchema.safeParse(stored).success).toBe(false);
    const loaded = baseConfigSchema.parse(stored);
    expect(loaded.visitEndMinute).toBe(600);
    const messages = configRuleErrors(loaded).map((e) => e.message);
    expect(messages).toHaveLength(4);
    expect(settingsProblems(loaded)).toEqual(expect.arrayContaining(messages));
    // The repaired config saves.
    const fixed = { ...loaded, visitEndMinute: 960, onsiteFollowUp: { remindDays: 3, expireDays: 7 }, subjectPriority: loaded.subjectPriority.slice(0, 1) };
    expect(configSchema.safeParse(fixed).success).toBe(true);
    expect(configRuleErrors(fixed)).toEqual([]);
  });
});

describe("limit fields", () => {
  it("edits each limit and returns a config the server accepts", () => {
    const config = base();
    expect(LIMIT_FIELDS.map((f) => f.id)).toEqual([
      "pre.perDay",
      "pre.perWeek",
      "pre.waiting",
      "pre.perSubject",
      "pre.remindDays",
      "pre.expireDays",
      "on.perWeek",
      "on.unbooked",
      "on.perHeadPerWeek",
      "on.perSubject",
      "on.remindDays",
      "on.expireDays",
    ]);
    for (const field of LIMIT_FIELDS) {
      // A reminder day must stay before the end day, so those two take smaller numbers.
      const n = field.id.endsWith("remindDays") ? 2 : field.id.endsWith("expireDays") ? 20 : 25;
      const next = setLimit(config, field.id, n);
      expect(field.get(next)).toBe(n);
      // Nothing else moved.
      for (const other of LIMIT_FIELDS.filter((f) => f.id !== field.id)) expect(other.get(next)).toBe(other.get(config));
      expect(configSchema.safeParse(next).success).toBe(true);
    }
    // Each limit lands in the key the queue reads.
    expect(setLimit(config, "pre.perDay", 9).preScreenLimits.perDay).toBe(9);
    expect(setLimit(config, "on.perHeadPerWeek", 4).onsiteLimits.perHeadPerWeek).toBe(4);
    expect(setLimit(config, "on.expireDays", 20).onsiteFollowUp.expireDays).toBe(20);
  });
  it("reports a number outside its range, a total that is not 100 and a missing pass score range", () => {
    expect(settingsProblems(base())).toEqual([]);
    expect(settingsProblems(setLimit(base(), "pre.perDay", 1001))[0]).toMatch(/Maximum sent each day/);
    expect(settingsProblems(setLimit(base(), "on.expireDays", 31)).join(" ")).toMatch(/30 days/);
    const weights = base().preScreenWeights;
    expect(settingsProblems({ ...base(), preScreenWeights: { ...weights, degree: 11 } }).join(" ")).toMatch(/Pre-screen weights total 101/);
    expect(settingsProblems({ ...base(), preScreenThreshold: 101 }).join(" ")).toMatch(/Pre-screen pass score/);
    expect(settingsProblems({ ...base(), preScreenThreshold: 0 })).toEqual([]);
  });
  it("converts visit times to minutes and back", () => {
    expect(minutesToTime(600)).toBe("10:00");
    expect(minutesToTime(965)).toBe("16:05");
    expect(minutesToTime(1440)).toBe("23:59");
    expect(timeToMinutes("10:30")).toBe(630);
    expect(timeToMinutes("")).toBeNull();
  });
});

describe("subject priority", () => {
  const list = [
    { subject: "Physics" as const, hiring: true },
    { subject: "Mathematics" as const, hiring: true },
  ];
  it("shows a subject missing from the list as not hiring, at the end, which is how the queue treats it", () => {
    const full = fullPriority(list);
    expect(full.slice(0, 2)).toEqual(list);
    expect(full).toHaveLength(SUBJECTS.length);
    expect(full.slice(2).every((p) => !p.hiring)).toBe(true);
    expect(new Set(full.map((p) => p.subject)).size).toBe(SUBJECTS.length);
  });
  it("moves a subject up and down, stops at the ends, and marks one not hiring", () => {
    expect(movePriority(list, 1, -1).map((p) => p.subject)).toEqual(["Mathematics", "Physics"]);
    expect(movePriority(list, 0, 1).map((p) => p.subject)).toEqual(["Mathematics", "Physics"]);
    expect(movePriority(list, 0, -1)).toEqual(list);
    expect(movePriority(list, 1, 1)).toEqual(list);
    expect(setHiring(list, 0, false)[0]).toEqual({ subject: "Physics", hiring: false });
    // The input is not changed.
    expect(list[0].hiring).toBe(true);
    // The whole list saves.
    expect(configSchema.safeParse({ subjectPriority: movePriority(movePriority(fullPriority(list), 2, -1), 1, -1) }).success).toBe(true);
  });
});

describe("accepted work-rights answers", () => {
  const ACCEPTED = "I have permanent work rights with no restrictions";
  const RESIDENT = "I am a long term / permanent resident with eligibility for a work permit";
  it("uses one key for the import and the check", () => {
    expect(answerKey("  I Have permanent  ")).toBe("i have permanent");
    // Full-width letters fold to plain ones.
    expect(answerKey("Ｉ have")).toBe("i have");
  });
  it("lists every seen answer with a tick box, and a new answer starts unticked", () => {
    const config = base({ seenWorkRights: [RESIDENT, ACCEPTED] });
    expect(workRightsRows(config)).toEqual([
      { answer: ACCEPTED, accepted: true },
      { answer: RESIDENT, accepted: false },
    ]);
    // An accepted answer that was never seen still shows.
    expect(workRightsRows(base())).toEqual([{ answer: ACCEPTED, accepted: true }]);
    // The same answer with other spacing or case is one row.
    expect(workRightsRows(base({ seenWorkRights: [ACCEPTED.toUpperCase().replace(/ /g, "  ")] }))).toHaveLength(1);
  });
  it("ticks and unticks by key", () => {
    const config = base({ seenWorkRights: [RESIDENT] });
    const ticked = setWorkRightsAccepted(config, RESIDENT, true);
    expect(ticked.acceptedWorkRights).toEqual([ACCEPTED, RESIDENT]);
    expect(workRightsRows(ticked).every((r) => r.accepted)).toBe(true);
    expect(setWorkRightsAccepted(ticked, RESIDENT, true).acceptedWorkRights).toHaveLength(2);
    expect(setWorkRightsAccepted(ticked, RESIDENT.toUpperCase(), false).acceptedWorkRights).toEqual([ACCEPTED]);
    expect(setWorkRightsAccepted(config, ACCEPTED, false).acceptedWorkRights).toEqual([]);
  });
});

describe("head days", () => {
  it("reads Monday to Friday from a week whose index 0 is Sunday", () => {
    expect(daysOf(MON_FRI)).toEqual([true, true, true, true, true]);
    // A Sunday-only week shows no weekday.
    expect(daysOf([win, null, null, null, null, null, null])).toEqual([false, false, false, false, false]);
    expect(daysOf([null, null, win, null, null, win, null])).toEqual([false, true, false, false, true]);
    expect(daysOf(null)).toEqual([false, false, false, false, false]);
  });
  it("writes Monday to Friday into indexes 1 to 5, keeps saved hours, defaults new days and leaves the weekend", () => {
    const early = { start: "09:00", end: "12:00" };
    const current: Week = [win, early, null, null, null, null, early];
    const week = weekWith([true, true, false, true, false], current);
    expect(week[0]).toEqual(win);
    expect(week[1]).toEqual(early);
    expect(week[2]).toEqual(win);
    expect(week[3]).toBeNull();
    expect(week[4]).toEqual(win);
    expect(week[5]).toBeNull();
    expect(week[6]).toEqual(early);
    expect(week).toHaveLength(7);
    // Gift: no saved week, so Monday to Friday get 10:00 to 16:00.
    expect(weekWith([true, true, true, true, true], null)).toEqual(MON_FRI);
    expect(weekWith([false, false, false, false, false], null)).toEqual(Array(7).fill(null));
  });
  it("tells an enrolled head from an unenrolled one, and uses the newest saved version", () => {
    const head = { canonicalKey: "Peat" };
    const v = (effectiveFrom: string, week: Week, revision: number) => ({ id: effectiveFrom, canonicalKey: "Peat", effectiveFrom, week, revision });
    const state = headDayState(head, [{ canonicalKey: "Peat", active: true }], [v("2026-09-01", MON_FRI, 1), v("2026-11-03", [null, win, null, null, null, null, null], 2)]);
    expect(state.state).toBe("enrolled");
    expect(state.from).toBe("2026-11-03");
    expect(daysOf(state.week)).toEqual([true, false, false, false, false]);
    expect(headDayState({ canonicalKey: "Gift", fallbackWeek: MON_FRI }, [], [])).toEqual({ state: "fallback", week: MON_FRI, from: null });
    expect(headDayState({ canonicalKey: "Gift" }, [], [])).toEqual({ state: "fallback", week: null, from: null });
    expect(headDayState(head, [{ canonicalKey: "Peat", active: false }], []).state).toBe("ended");
    expect(headDayState(head, [{ canonicalKey: "Peat", active: true }], []).week).toBeNull();
  });
  it("warns only when no weekday has saved hours", () => {
    expect(hasSavedHours(MON_FRI)).toBe(true);
    expect(hasSavedHours(null)).toBe(false);
    expect(hasSavedHours([win, null, null, null, null, null, win])).toBe(false);
  });
});

describe("automation switch notice", () => {
  const off = { enabled: false, deliveryEnabled: false };
  it("shows only when a switch goes from off to on", () => {
    expect(startsSending(off, { enabled: true, deliveryEnabled: false })).toBe(true);
    expect(startsSending(off, { enabled: false, deliveryEnabled: true })).toBe(true);
    expect(startsSending(off, off)).toBe(false);
    expect(startsSending({ enabled: true, deliveryEnabled: true }, { enabled: true, deliveryEnabled: true })).toBe(false);
    // Turning one off is not a start.
    expect(startsSending({ enabled: true, deliveryEnabled: true }, { enabled: true, deliveryEnabled: false })).toBe(false);
  });
  it("says it starts sending, within the numbers on the page", () => {
    const text = sendingNotice(base());
    expect(text).toMatch(/starts sending/i);
    expect(text).toContain("5 pre-screen forms a day");
    expect(text).toContain("15 a week");
    expect(text).toContain("3 onsite invitations a week");
  });
});
