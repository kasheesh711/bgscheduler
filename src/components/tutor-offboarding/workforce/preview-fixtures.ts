/** Deterministic fictional data for local review and tests only. Never used as a production fallback. */
import type {
  WorkforceQuery,
  WorkforceReport,
} from "@/lib/tutor-offboarding/workforce/types";
import type {
  GrowthAssumptions,
  GrowthReport,
  GrowthCourse,
} from "@/lib/tutor-offboarding/workforce/growth/types";
import { workforceFixture, fixtureMetrics, metric } from "./fixtures";
export function workforcePreviewFixture(
  query?: WorkforceQuery,
): WorkforceReport {
  const report = workforceFixture();
  report.query = query ?? report.query;
  const roster = [51, 54, 56, 56, 58, 60, 61, 62],
    joined = [4, 3, 1, 4, 3, 2, 3, 1],
    departed = [1, 1, 1, 2, 1, 1, 2, 3],
    booked = [112, 151, 160, 154, 180, 201, 222, 12],
    usable = [null, null, 230, 235, 244, 260, 272, 16];
  report.months = roster.map((opening, i) => {
    const month = `2026-${String(i + 3).padStart(2, "0")}`,
      u = usable[i],
      b = booked[i];
    return {
      ...fixtureMetrics({
        offeredHours: metric(u === null ? null : u + 12),
        leaveHours: metric(u === null ? null : 12),
        usableHours: metric(u),
        bookedHours: metric(b),
        reservedHours: metric(b),
        recordedTeachingHours: metric(b * 0.83),
        creditConsumedHours: metric(b * 0.92),
        freeHours: metric(u === null ? null : Math.max(0, u - b)),
        reservedUtilizationPercent: metric(u === null ? null : (b / u) * 100),
        consumedUtilizationPercent: metric(
          u === null ? null : ((b * 0.92) / u) * 100,
        ),
        recordedTeachingUtilizationPercent: metric(
          u === null ? null : ((b * 0.83) / u) * 100,
        ),
        utilizationReservedHours: metric(u === null ? null : b),
        utilizationCreditConsumedHours: metric(u === null ? null : b * 0.92),
        utilizationRecordedTeachingHours: metric(u === null ? null : b * 0.83),
      }),
      month,
      openingRosterCount: metric(opening),
      closingRosterCount: metric(opening + joined[i] - departed[i]),
      joinsCount: metric(joined[i]),
      departuresCount: metric(departed[i]),
      pendingCount: metric(i === 7 ? 2 : i % 3),
      turnoverPercent: metric((departed[i] / opening) * 100),
      joinedPersonKeys: [],
      departedPersonKeys: [],
      pendingPersonKeys: [],
      partialMonth: i === 7,
    };
  });
  report.subjects = report.months.flatMap((m) =>
    ["Mathematics", "Physics", "Chemistry", "English"].flatMap((subject, j) => {
      const factor = [0.7, 0.5, 0.4, 0.65][j],
        u = m.usableHours.value === null ? null : m.usableHours.value * factor,
        b = m.bookedHours.value! * [0.4, 0.25, 0.15, 0.2][j],
        base = {
          ...fixtureMetrics({
            offeredHours: metric(u === null ? null : u + 2),
            leaveHours: metric(u === null ? null : 2),
            reservedHours: metric(b),
            creditConsumedHours: metric(b * 0.92),
            recordedTeachingHours: metric(b * 0.83),
            utilizationReservedHours: metric(u === null ? null : b),
            utilizationCreditConsumedHours: metric(
              u === null ? null : b * 0.92,
            ),
            utilizationRecordedTeachingHours: metric(
              u === null ? null : b * 0.83,
            ),
            reservedUtilizationPercent: metric(
              u === null || u === 0 ? null : (b / u) * 100,
            ),
            consumedUtilizationPercent: metric(
              u === null || u === 0 ? null : ((b * 0.92) / u) * 100,
            ),
            recordedTeachingUtilizationPercent: metric(
              u === null || u === 0 ? null : ((b * 0.83) / u) * 100,
            ),
            usableHours: metric(
              m.usableHours.value === null
                ? null
                : m.usableHours.value * factor,
            ),
            freeHours: metric(
              m.usableHours.value === null
                ? null
                : Math.max(
                    0,
                    m.usableHours.value * factor -
                      m.bookedHours.value! * [0.4, 0.25, 0.15, 0.2][j],
                  ),
            ),
            bookedHours: metric(
              m.bookedHours.value! * [0.4, 0.25, 0.15, 0.2][j],
            ),
          }),
          month: m.month,
          subject,
          modality: "all" as const,
        };
      const key = `${m.month}:${subject}`;
      return [
        {
          ...base,
          key,
          curriculum: null,
          level: null,
          depth: 0 as const,
          parentKey: null,
        },
        {
          ...base,
          key: `${key}:IGCSE`,
          curriculum: "IGCSE",
          level: null,
          depth: 1 as const,
          parentKey: key,
        },
        {
          ...base,
          key: `${key}:IGCSE:G10`,
          curriculum: "IGCSE",
          level: "G10",
          depth: 2 as const,
          parentKey: `${key}:IGCSE`,
        },
      ];
    }),
  );
  report.weekCells = [1, 2, 3, 4, 5, 6, 0].flatMap((day) =>
    Array.from({ length: 16 }, (_, i) => {
      const start = 540 + i * 30,
        offered = day === 6 || day === 0 ? 3 : 1.5,
        b = ((day * 3 + i * 2) % 9) / 8;
      const unknown = day === 4 && i < 2;
      return {
        ...fixtureMetrics({
          freeHours: metric(unknown ? null : Math.max(0, offered - b)),
          usableHours: metric(unknown ? null : offered),
          bookedHours: metric(b),
          creditConsumedHours: metric(b * 0.85),
          recordedTeachingHours: metric(b * 0.75),
        }),
        key: `${report.query.viewMonth}:${day}:${start}`,
        month: report.query.viewMonth,
        weekday: day,
        startMinute: start,
        endMinute: start + 30,
        coveredDates: day === 4 ? 3 : 4,
        calendarOccurrences: 4,
        monthlyTotals: {
          freeHours: metric(unknown ? null : (offered - b) * 4),
          bookedHours: metric(b * 4),
        },
        subject: null,
        curriculum: null,
        level: null,
        modality: "all" as const,
      };
    }),
  );
  const names = [
    "Aria",
    "River",
    "Jamie",
    "Noor",
    "Pim",
    "Alex",
    "Sage",
    "Kai",
  ];
  report.people = names.map((name, i) => {
    if (i === 0 || i === 1) return report.people[i];
    const rate = [0, 0, 92, 83, 72, 48, 28, null][i],
      u = rate === null ? null : 24 + i * 2,
      b = rate === null ? null : (u! * rate) / 100;
    return {
      ...fixtureMetrics({
        offeredHours: metric(u === null ? null : u + 2),
        leaveHours: metric(u === null ? null : 2),
        usableHours: metric(u),
        bookedHours: metric(b),
        reservedHours: metric(b),
        freeHours: metric(u === null ? null : Math.max(0, u - b!)),
        creditConsumedHours: metric(b === null ? null : b * 0.88),
        recordedTeachingHours: metric(b === null ? null : b * 0.8),
        utilizationReservedHours: metric(b),
        utilizationCreditConsumedHours: metric(b === null ? null : b * 0.88),
        utilizationRecordedTeachingHours: metric(b === null ? null : b * 0.8),
        reservedUtilizationPercent: metric(rate),
        consumedUtilizationPercent: metric(rate === null ? null : rate * 0.88),
        recordedTeachingUtilizationPercent: metric(
          rate === null ? null : rate * 0.8,
        ),
      }),
      canonicalKey: name.toLowerCase(),
      displayName: name,
      role: i === 4 ? ("teaching_admin" as const) : ("tutor" as const),
      rosterState: "active" as const,
      joinedAt: null,
      departedAt: null,
      pendingDeparture: false,
      months: [],
      reasonCodes: [],
    };
  });
  if (report.query.role !== "all")
    report.people = report.people.filter((p) => p.role === report.query.role);
  if (report.query.subject)
    report.subjects = report.subjects.filter(
      (r) => r.subject === report.query.subject,
    );
  report.totals = fixtureMetrics({
    offeredHours: metric(null),
    usableHours: metric(null),
    freeHours: metric(null),
    bookedHours: metric(booked.reduce((a, b) => a + b, 0)),
  });
  return report;
}
const COURSES: GrowthCourse[] = [
  {
    courseKey: "Mathematics|IGCSE|G10",
    subject: "Mathematics",
    curriculum: "IGCSE",
    level: "G10",
  },
  {
    courseKey: "Physics|IGCSE|G10",
    subject: "Physics",
    curriculum: "IGCSE",
    level: "G10",
  },
  {
    courseKey: "Chemistry|IGCSE|G10",
    subject: "Chemistry",
    curriculum: "IGCSE",
    level: "G10",
  },
  {
    courseKey: "English|Alevel|G12",
    subject: "English",
    curriculum: "A level",
    level: "G12",
  },
];
export function growthPreviewFixture(
  filters: WorkforceQuery = workforceFixture().query,
  assumptions: GrowthAssumptions = { bufferPercent: 0 },
): GrowthReport {
  const courses = COURSES.filter(
    (c) =>
      (!filters.subject || c.subject === filters.subject) &&
      (!filters.curriculum || c.curriculum === filters.curriculum) &&
      (!filters.level || c.level === filters.level),
  );
  const quality = workforceFixture().quality;
  const common = ["2026-06", "2026-07", "2026-08"],
    history = [
      "2026-03",
      "2026-04",
      "2026-05",
      ...common,
      "2026-09",
      "2026-10",
    ];
  const means = [2, 3, 5, null],
    base = [70, 55, 45, 30],
    mix = [1.2, 1.05, 1.1, 1.15],
    loss = [1, 0.8, 1.5, 0.5];
  const value = (
    course: GrowthCourse,
    key: string,
    measured: number | null,
  ) => ({
    value:
      (
        assumptions.subjects?.[course.courseKey] as
          Record<string, number> | undefined
      )?.[key] ?? measured,
    source:
      (
        assumptions.subjects?.[course.courseKey] as
          Record<string, number> | undefined
      )?.[key] !== undefined
        ? ("override" as const)
        : measured === null
          ? ("unavailable" as const)
          : ("measured" as const),
    measured: metric(measured),
  });
  const inputs = courses.map((c) => {
    const i = COURSES.findIndex((v) => v.courseKey === c.courseKey);
    return {
      ...c,
      baseStudentHours: value(c, "baseStudentHours", base[i]),
      newStudentHours: value(c, "newStudentHours", means[i]),
      reactivatedStudentHours: value(c, "reactivatedStudentHours", 0.5),
      churnStudentHours: value(c, "churnStudentHours", loss[i]),
      cancellationFraction: value(c, "cancellationFraction", 0.08),
      studentHoursPerTutorHour: value(c, "studentHoursPerTutorHour", mix[i]),
    };
  });
  const forecastMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date("2026-10-01T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + i);
    return d.toISOString().slice(0, 7);
  });
  const months = inputs.flatMap((input) =>
    forecastMonths.map((month, k) => {
      const index = COURSES.findIndex((c) => c.courseKey === input.courseKey),
        known = [
          input.baseStudentHours,
          input.newStudentHours,
          input.reactivatedStudentHours,
          input.churnStudentHours,
          input.cancellationFraction,
          input.studentHoursPerTutorHour,
        ].every((v) => v.value !== null),
        book = known
          ? Math.max(
              0,
              input.baseStudentHours.value! +
                (k + 1) *
                  (input.newStudentHours.value! +
                    input.reactivatedStudentHours.value! -
                    input.churnStudentHours.value!),
            )
          : null,
        tutor =
          book === null ? null : book / input.studentHoursPerTutorHour.value!,
        credit =
          tutor === null
            ? null
            : tutor * (1 - input.cancellationFraction.value!),
        committed = k < 3 ? Math.max(0, 30 - index * 5 - k * 7) : 0,
        extra =
          tutor === null
            ? null
            : Math.max(
                0,
                (Math.max(tutor, committed) - [50, 42, 32, 25][index]) / 4.33,
              );
      return {
        ...input,
        key: `forecast:${month}:${input.courseKey}`,
        month,
        bookedStudentHours: metric(book),
        creditStudentHours: metric(
          book === null ? null : book * (1 - input.cancellationFraction.value!),
        ),
        bookedTutorHours: metric(tutor),
        creditTutorHours: metric(credit),
        flatStudentHours: metric(base[index]),
        knownCommittedTutorHours: metric(committed),
        capacityRequiredTutorHours: metric(
          tutor === null ? null : Math.max(tutor, committed),
        ),
        additionalWeeklyHours: metric(extra),
        bufferedAdditionalWeeklyHours: metric(
          extra === null ? null : extra * (1 + assumptions.bufferPercent / 100),
        ),
      };
    }),
  );
  const hiring = months.map((m) => {
    const i = COURSES.findIndex((c) => c.courseKey === m.courseKey),
      matching = [3, 2.5, 2, 0][i],
      extra = m.additionalWeeklyHours.value,
      eq = extra === null || matching === 0 ? null : extra / matching;
    return {
      ...m,
      eligibleTutors: 10 - i,
      knownAvailabilityTutors: 8 - i,
      averageOfferedWeeklyHours: metric(8 - i),
      averageMatchingWeeklyHours: metric(matching),
      extraWeeklyHours: m.additionalWeeklyHours,
      tutorEquivalents: metric(eq),
      roundedHiringEstimate: metric(eq === null ? null : Math.ceil(eq)),
      bufferedTutorEquivalents: metric(
        eq === null ? null : eq * (1 + assumptions.bufferPercent / 100),
      ),
      bufferedRoundedHiringEstimate: metric(
        eq === null
          ? null
          : Math.ceil(eq * (1 + assumptions.bufferPercent / 100)),
      ),
      benchmarkPersonKeys: [],
      reasonCodes: eq === null ? ["matching_availability_unavailable"] : [],
    };
  });
  const allocations = forecastMonths.map((month) => {
    const ms = months.filter((m) => m.month === month),
      known = ms.every((m) => m.additionalWeeklyHours.value !== null),
      required = known
        ? ms.reduce((s, m) => s + m.capacityRequiredTutorHours.value!, 0)
        : null,
      shared = required === null ? null : Math.max(0, (required - 120) / 4.33);
    return {
      month,
      requiredHours: metric(required),
      allocatedHours: metric(
        required === null ? null : Math.min(required, 120),
      ),
      additionalWeeklyHours: metric(shared),
      bufferedAdditionalWeeklyHours: metric(
        shared === null ? null : shared * (1 + assumptions.bufferPercent / 100),
      ),
      cells: ms.flatMap((m) =>
        [1, 2, 3, 4, 5, 6, 0].flatMap((day) =>
          [960, 990, 1020, 1050].map((start) => {
            const weight = day === 6 ? 2 : 1,
              extra = m.additionalWeeklyHours.value,
              v = extra === null ? null : (extra * weight) / 32;
            return {
              ...m,
              key: `gap:${month}:${m.courseKey}:${day}:${start}`,
              weekday: day,
              startMinute: start,
              endMinute: start + 30,
              requiredHours: metric(v === null ? null : v + 0.3),
              allocatedHours: metric(v === null ? null : 0.3),
              additionalWeeklyHours: metric(v),
              bufferedAdditionalWeeklyHours: metric(
                v === null ? null : v * (1 + assumptions.bufferPercent / 100),
              ),
            };
          }),
        ),
      ),
      observedAt: ["2026-10-01T05:00:00Z"],
      reasonCodes: known ? [] : ["missing_automatic_inputs"],
    };
  });
  return {
    schemaVersion: 1,
    reportRevision: "fictional-growth-v1",
    generatedAt: "2026-10-01T05:00:00Z",
    query: {
      filters: { ...filters, role: "all", modality: "all" },
      assumptions,
    },
    quality,
    flows: {
      commonWindow: common,
      quality,
      lifecycleEvents: [],
      patterns: [],
      averages: courses.map((c) => {
        const i = COURSES.findIndex((v) => v.courseKey === c.courseKey);
        return {
          ...c,
          months: common,
          newStudentHours: metric(means[i]),
          reactivatedStudentHours: metric(0.5),
          churnStudentHours: metric(loss[i]),
          cancellationFraction: metric(0.08),
          cancellationNumerator: metric(8),
          cancellationDenominator: metric(100),
          studentHoursPerTutorHour: metric(mix[i]),
        };
      }),
      months: courses.flatMap((c) => {
        const i = COURSES.findIndex((v) => v.courseKey === c.courseKey);
        return history.map((month, j) => {
          const newH =
              j === 0 ? 8 : ([3, 5, 1, 2, [3, 6, 12, 5][i], 4, 6][j - 1] ?? 5),
            react = j === 5 || j === 1 ? 1.5 : 0,
            churn = [
              0,
              0.5,
              1,
              loss[i] * 0.5,
              loss[i],
              loss[i] * 1.5,
              loss[i] * 0.5,
              0,
            ][j];
          return {
            ...c,
            key: `flow:${month}:${c.courseKey}`,
            month,
            newlyObservedStudents: metric(
              i === 3 && j === 3 ? null : Math.ceil(newH / 2),
            ),
            reactivatedStudents: metric(react ? 1 : 0),
            churnedStudents: metric(churn ? 1 : 0),
            newStudentHours: metric(
              i === 3 && j === 3 ? null : newH,
              "Cohort history incomplete",
            ),
            reactivatedStudentHours: metric(react),
            churnStudentHours: metric(churn),
            bookedStudentHours: metric(base[i] + (j - 6) * 3),
            creditStudentHours: metric((base[i] + (j - 6) * 3) * 0.92),
            cancellationStudentHours: metric((base[i] + (j - 6) * 3) * 0.08),
            bookedTutorHours: metric((base[i] + (j - 6) * 3) / mix[i]),
            creditTutorHours: metric(((base[i] + (j - 6) * 3) * 0.92) / mix[i]),
            cancellationTutorHours: metric(
              ((base[i] + (j - 6) * 3) * 0.08) / mix[i],
            ),
            newTutorHours: metric(i === 3 && j === 3 ? null : newH / mix[i]),
            reactivatedTutorHours: metric(react / mix[i]),
            trialStudentHours: metric(j % 3),
            pretestStudentHours: metric(j % 2),
            mature: j < 6,
            provisional: j >= 6,
            startingCohortExcluded: j === 0,
            contributors: { studentIds: [], sessionIds: [], eventKeys: [] },
          };
        });
      }),
    },
    forecast: {
      baseMonth: "2026-09",
      inputs,
      months,
      allocations,
      hiring,
      bufferPercent: assumptions.bufferPercent,
      assumptions: [
        "Fictional preview only. English deliberately lacks an automatic new-demand input.",
        "Common mature window: June–August 2026. Recent observations are provisional.",
        "First-month cohort demand continues monthly. Availability patterns continue.",
      ],
      quality,
    },
  };
}
