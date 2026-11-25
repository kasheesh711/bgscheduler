import { describe, expect, it } from "vitest";
import { availabilityFraction, hardStops, meetsTimeRule } from "../scoring";
import { configSchema, preScreenSchema } from "../model";
import { emptyWeek, parseWeekHours, weekHoursCount, weekHoursSchema, weekHoursText } from "../week-hours";

const pre = (availability: string) =>
  preScreenSchema.parse({
    sourceRow: 0, submittedAt: "", degree: "Bachelor's", field: "Maths", subjects: "Mathematics", curricula: "", yearGroups: "",
    english: "Native", englishEvidence: "", experience: "", portfolio: "", availability, weeklyHours: "20-40", motivation: "", teachingApproach: "",
  });

describe("week hours (the booking page grid)", () => {
  it("writes runs of hours per day, weekdays then the weekend, and reads them back exactly", () => {
    const week = [[15, 16, 17, 18, 19, 20], [], [8, 9, 10, 11, 17, 18, 19, 20], [], [], [9, 10, 11, 12, 13, 14, 15, 16], [20]];
    const text = weekHoursText(week);
    expect(text).toBe("Weekdays: Mon 15:00-21:00; Wed 08:00-12:00 & 17:00-21:00, Weekend: Sat 09:00-17:00; Sun 20:00-21:00");
    expect(parseWeekHours(text)).toEqual(week);
    expect(weekHoursCount(week)).toBe(23);
  });
  it("round-trips every single cell and a full week", () => {
    for (let d = 0; d < 7; d++)
      for (let h = 8; h <= 20; h++) {
        const week = emptyWeek();
        week[d] = [h];
        expect(parseWeekHours(weekHoursText(week))).toEqual(week);
      }
    const full = emptyWeek().map(() => [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(parseWeekHours(weekHoursText(full))).toEqual(full);
  });
  it("sorts and de-duplicates the grid, and refuses an empty week or an hour outside 08:00-21:00", () => {
    expect(weekHoursSchema.parse([[18, 17, 18], [], [], [], [], [], []])).toEqual([[17, 18], [], [], [], [], [], []]);
    expect(weekHoursSchema.safeParse(emptyWeek()).success).toBe(false);
    expect(weekHoursSchema.safeParse([[21], [], [], [], [], [], []]).success).toBe(false);
    expect(weekHoursSchema.safeParse([[], [], [], [], [], []]).success).toBe(false);
  });
  it("sorts and de-duplicates hand-edited text", () => {
    expect(parseWeekHours("Weekdays: Mon 13:00-14:00 & 10:00-11:00 & 10:00-12:00")?.[0]).toEqual([10, 11, 13]);
  });
  it("needs a weekday hour that starts at 15:00 or later: one that ends at 15:00 does not count", () => {
    const config = configSchema.parse({ acceptedWorkRights: ["yes"], interviewers: [] });
    const stops = (week: number[][]) => hardStops(pre(weekHoursText(week)), "yes", ["Mathematics"], config).stops;
    expect(stops([[12, 13, 14], [], [], [], [], [9], []])).toContain("Needs a weekend day and a weekday after 15:00.");
    expect(stops([[12, 13, 14, 15], [], [], [], [], [9], []])).not.toContain("Needs a weekend day and a weekday after 15:00.");
  });
  it("is not confused with a Google Form answer", () => {
    expect(parseWeekHours("Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)")).toBeNull();
    expect(parseWeekHours("Weekdays: Sat 09:00-10:00")).toBeNull();
  });
  it("gives the same weekend and late-weekday reading to the grid text and to the old option reader's words", () => {
    const config = configSchema.parse({ acceptedWorkRights: ["yes"], interviewers: [] });
    const stops = (text: string) => hardStops(pre(text), "yes", ["Mathematics"], config).stops;
    expect(stops(weekHoursText([[17], [], [], [], [], [10], []]))).not.toContain("Needs a weekend day and a weekday after 15:00.");
    expect(stops(weekHoursText([[10], [], [], [], [], [10], []]))).toContain("Needs a weekend day and a weekday after 15:00.");
    expect(stops(weekHoursText([[17], [], [], [], [], [], []]))).toContain("Needs a weekend day and a weekday after 15:00.");
    // The Google Form answers still read as before.
    expect(stops("Weekday Evening (17:00-21:00), Weekend Morning (before 12:00)")).not.toContain("Needs a weekend day and a weekday after 15:00.");
    expect(availabilityFraction(pre(weekHoursText([[17], [], [], [], [], [10], []])))).toBeCloseTo(1);
  });
  it("keeps the words an older option reader needs (the Mac worker can run older code for a while)", () => {
    // The old reader: per comma part, /weekend|saturday|sunday/ and /weekday/ with a time after 15:00.
    const old = (text: string) => {
      const options = text.split(",");
      return {
        weekend: options.some((o) => /weekend|saturday|sunday/i.test(o)),
        weekdayLate: options.some((o) => /weekday/i.test(o) && /afternoon|evening|\b(?:1[5-9]|2[0-3]):/i.test(o)),
      };
    };
    expect(old(weekHoursText([[17, 18], [], [], [], [], [9], []]))).toEqual({ weekend: true, weekdayLate: true });
    expect(old(weekHoursText([[9, 10], [], [], [], [], [], [9]]))).toEqual({ weekend: true, weekdayLate: false });
    expect(old(weekHoursText([[17], [], [], [], [], [], []]))).toEqual({ weekend: false, weekdayLate: true });
    // Known gap until the Mac worker runs this code: the old reader sees "15:00" at the end of a 12:00-15:00 range as late.
    expect(old(weekHoursText([[12, 13, 14], [], [], [], [], [9], []])).weekdayLate).toBe(true);
  });
});

describe("grid text that does not parse (code review r23)", () => {
  it("fails closed: no weekend and no weekday-after-15:00 flag is guessed", () => {
    expect(meetsTimeRule(weekHoursText([[15], [], [], [], [], [9], []]))).toBe(true);
    // Hand-edited in the sheet: "9:00" is not the grid's two-digit form.
    expect(meetsTimeRule("Weekdays: Mon 9:00-16:00, Weekend: Sat 09:00-10:00")).toBe(false);
    // Old Google Form option text is still read as before.
    expect(meetsTimeRule("Weekday Evening (17:00-21:00), Weekend Morning (09:00-12:00)")).toBe(true);
  });
});
