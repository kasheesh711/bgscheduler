import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UtilizationTable } from "../utilization-table";
import { metric, workforceFixture } from "../fixtures";

describe("tutor capacity chart", () => {
  it("uses selected-month metrics and keeps raw credit visible beside supported calculations", () => {
    const people = workforceFixture().people;
    people[0].months[0] = {
      ...people[0].months[0],
      usableHours: metric(4),
      reservedHours: metric(12),
      utilizationReservedHours: metric(8),
      creditConsumedHours: {
        ...metric(9),
        completeness: "partial",
        creditCoverage: {
          totalClasses: 5,
          computedClasses: 3,
          estimatedClasses: 1,
          unknownClasses: 2,
          returnedParticipants: 7,
          verifiedCreditParticipants: 4,
          unknownCreditParticipants: 3,
        },
      },
      utilizationCreditConsumedHours: metric(2),
      reservedUtilizationPercent: metric(200),
      consumedUtilizationPercent: metric(50),
      coverageHours: metric(24),
      expectedCoverageHours: metric(168),
      coveragePercent: metric(14.3),
    };

    const html = renderToStaticMarkup(
      <UtilizationTable
        people={people}
        selectedMonth="2026-10"
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("2026-10");
    expect(html).toContain("Booked · covered dates");
    expect(html).toContain("Credit used · covered dates");
    expect(html).toContain("Credit-used this month: 9 h · partial estimate");
    expect(html).toContain("Availability history coverage: 14.3%");
    expect(html).toContain("3 computed of 5 classes; 1 estimated, 2 unknown");
    expect(html).toContain("8 h ÷ 4 h × 100 = 200%");
    expect(html).toContain("2 h ÷ 4 h × 100 = 50%");
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it("shows ten people first and exposes the rest with a show-more control", () => {
    const people = workforceFixture().people;
    const expanded = Array.from({ length: 12 }, (_, index) => ({
      ...people[index % people.length],
      freeHours: metric(1),
      canonicalKey: `person-${index}`,
      displayName: `Tutor ${String(index + 1).padStart(2, "0")}`,
    }));
    const html = renderToStaticMarkup(
      <UtilizationTable people={expanded} onSelect={vi.fn()} />,
    );

    expect(html).toContain("Tutor 01");
    expect(html).toContain("Tutor 10");
    expect(html).not.toContain(">Tutor 11</span>");
    expect(html).toContain("Show more (2 remaining)");
  });

  it("keeps raw credit hours visible when historical capacity is unavailable", () => {
    const person = workforceFixture().people[0];
    person.months[0] = {
      ...person.months[0],
      usableHours: metric(null),
      coverageHours: metric(null),
      expectedCoverageHours: metric(168),
      coveragePercent: metric(null),
      utilizationReservedHours: metric(null),
      utilizationCreditConsumedHours: metric(null),
      creditConsumedHours: metric(5),
      reservedUtilizationPercent: metric(null),
      consumedUtilizationPercent: metric(null),
    };
    const html = renderToStaticMarkup(
      <UtilizationTable
        people={[person]}
        selectedMonth="2026-10"
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("Availability was not recorded for this month");
    expect(html).toContain("Credit-used this month: 5 h full-period total");
    expect(html).toContain("Unavailable");
  });

  it("does not fall back to full-range totals when the selected month is absent", () => {
    const person = workforceFixture().people[0];
    person.months = [];
    person.bookedHours = metric(123);
    person.creditConsumedHours = metric(19);
    const html = renderToStaticMarkup(
      <UtilizationTable
        people={[person]}
        selectedMonth="2026-08"
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("2026-08");
    expect(html).toContain("Credit-used this month: Unavailable full-period total");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("123 h");
    expect(html).not.toContain("19 h");
  });
});
