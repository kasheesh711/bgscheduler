import { describe, expect, it } from "vitest";
import {
  ACTIVE_BASE_PROBABILITY,
  baseGoneProbability,
  buildCalibrationCurve,
  daysBetweenDateKeys,
  type CalibrationCurve,
} from "../calibration";

const TODAY = "2026-10-01";

/** The Bangkok date key `days` before 1 Oct 2026. */
function daysBefore(days: number): string {
  return new Date(Date.UTC(2026, 9, 1) - days * 86_400_000).toISOString().slice(0, 10);
}

function probabilities(curve: CalibrationCurve): number[] {
  return curve.points.map((point) => point.goneProbability);
}

describe("daysBetweenDateKeys", () => {
  it("counts calendar days between two date keys", () => {
    expect(daysBetweenDateKeys("2026-03-01", "2026-10-01")).toBe(214);
    expect(daysBetweenDateKeys("2026-10-01", "2026-10-01")).toBe(0);
  });
});

describe("buildCalibrationCurve", () => {
  it("measures returns and still-idle gaps per threshold with Jeffreys smoothing", () => {
    const history = new Map<string, string[]>([
      ["T1", ["2026-09-30"]],
      ["T2", ["2026-09-20"]],
      ["T3", ["2026-08-01"]],
      ["T4", ["2026-06-01"]],
      ["T5", ["2026-05-01"]],
      ["T6", ["2026-04-01"]],
      ["T7", ["2026-03-01", "2026-05-15", "2026-09-29"]], // came back after 75 and 137 days
      ["T8", ["2026-07-01", "2026-08-10", "2026-09-30"]], // came back after 40 and 51 days
    ]);
    const curve = buildCalibrationCurve(history, TODAY);
    expect(curve.tutorsObserved).toBe(8);
    expect(curve.points.map((p) => [p.thresholdDays, p.returned, p.stillIdle, p.usedDefault])).toEqual([
      [21, 4, 4, false],
      [30, 4, 4, false],
      [45, 3, 4, false],
      [60, 2, 4, false],
      [90, 1, 3, true], // only 4 observations: the default stands
    ]);
    const [p21, p30, p45, p60, p90] = probabilities(curve);
    expect(p21).toBeCloseTo(0.5, 6); // 1 - (4 + 0.5) / (4 + 4 + 1)
    expect(p30).toBeCloseTo(0.5, 6);
    expect(p45).toBeCloseTo(0.5625, 6); // 1 - 3.5 / 8
    expect(p60).toBeCloseTo(0.642857, 5); // 1 - 2.5 / 7
    expect(p90).toBe(0.96);
  });

  it("never lets a longer gap look less final than a shorter one", () => {
    // Five tutors came back after 63-70 days; nobody is idle past 60 days today.
    const history = new Map([63, 64, 65, 66, 70].map((gap, index) => [`T${index}`, [daysBefore(50 + gap), daysBefore(50)]]));
    const curve = buildCalibrationCurve(history, TODAY);
    expect(curve.points[3]).toMatchObject({ thresholdDays: 60, returned: 5, stillIdle: 0, usedDefault: false });
    expect(curve.points[3].goneProbability).toBeCloseTo(0.5, 6); // raw 0.083 raised to the 45-day value
    expect(probabilities(curve)).toEqual([...probabilities(curve)].sort((a, b) => a - b));
  });

  it("falls back to the defaults when there is no history", () => {
    const curve = buildCalibrationCurve(new Map(), TODAY);
    expect(curve.tutorsObserved).toBe(0);
    expect(curve.points.every((point) => point.usedDefault)).toBe(true);
    expect(probabilities(curve)).toEqual([0.6, 0.7, 0.78, 0.9, 0.96]);
    expect(curve.historyStart).toBe("2026-02-28T17:00:00.000Z");
  });

  it("ignores duplicate and unsorted dates", () => {
    const curve = buildCalibrationCurve(new Map([["T1", ["2026-09-30", "2026-09-01", "2026-09-30"]]]), TODAY);
    expect(curve.tutorsObserved).toBe(1);
    expect(curve.points[0]).toMatchObject({ returned: 1, stillIdle: 0 });
  });
});

describe("baseGoneProbability", () => {
  const curve: CalibrationCurve = {
    tutorsObserved: 72,
    historyStart: "2026-02-28T17:00:00.000Z",
    points: [
      { thresholdDays: 21, returned: 13, stillIdle: 21, goneProbability: 0.61, usedDefault: false },
      { thresholdDays: 30, returned: 8, stillIdle: 19, goneProbability: 0.7, usedDefault: false },
      { thresholdDays: 45, returned: 4, stillIdle: 15, goneProbability: 0.78, usedDefault: false },
      { thresholdDays: 60, returned: 1, stillIdle: 15, goneProbability: 0.91, usedDefault: false },
      { thresholdDays: 90, returned: 0, stillIdle: 14, goneProbability: 0.97, usedDefault: false },
    ],
  };

  it("uses the largest threshold the gap has reached", () => {
    expect(baseGoneProbability(curve, 0)).toBe(ACTIVE_BASE_PROBABILITY);
    expect(baseGoneProbability(curve, 20)).toBe(ACTIVE_BASE_PROBABILITY);
    expect(baseGoneProbability(curve, 21)).toBe(0.61);
    expect(baseGoneProbability(curve, 59)).toBe(0.78);
    expect(baseGoneProbability(curve, 60)).toBe(0.91);
    expect(baseGoneProbability(curve, 400)).toBe(0.97);
  });
});
