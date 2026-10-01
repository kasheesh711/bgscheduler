import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailContent, DetailMetrics } from "../detail-drawer";
import { QualityContent } from "../quality-panel";
import { weekCellLabel } from "../week-heatmap";
import {
  drilldownFixture,
  workforceFixture,
  fixtureMetrics,
  metric,
} from "../fixtures";
import { sortPeople } from "../utilization-table";
import { rateFormula } from "../presentation";
describe("workforce detail evidence", () => {
  it("fixture utilization numerators agree with displayed rates", () => {
    for (const person of workforceFixture().people) {
      const net = person.usableHours.value!;
      expect(person.reservedUtilizationPercent.value).toBeCloseTo(
        (person.utilizationReservedHours.value! / net) * 100,
      );
      expect(person.consumedUtilizationPercent.value).toBeCloseTo(
        (person.utilizationCreditConsumedHours.value! / net) * 100,
      );
      expect(person.recordedTeachingUtilizationPercent.value).toBeCloseTo(
        (person.utilizationRecordedTeachingHours.value! / net) * 100,
      );
      expect(person.offeredHours.value! - person.leaveHours.value!).toBe(net);
    }
  });
  it("explains 45-minute group credit and seven shared hours without doubling tutor time", () => {
    const html = renderToStaticMarkup(
      <DetailContent detail={drilldownFixture()} />,
    );
    expect(html).toContain("45 minutes");
    expect(html).toContain("seven shared free hours");
    expect(html).toContain("Physics group");
    expect(html).toContain("2 student bookings");
    expect(html).toContain("one class and two student bookings");
  });
  it("uses coverage-matched rate basis and identifies full-range totals separately", () => {
    const row = fixtureMetrics({
      bookedHours: metric(100),
      utilizationReservedHours: metric(1),
      usableHours: metric(8),
    });
    expect(rateFormula(row, "reservedUtilizationPercent")).toContain(
      "1 h ÷ 8 h",
    );
    expect(rateFormula(row, "reservedUtilizationPercent")).not.toContain(
      "100 h ÷",
    );
    const html = renderToStaticMarkup(<DetailMetrics row={row} />);
    expect(html).toContain("Full-range totals: 100 h");
    expect(html).toContain("same observed dates");
  });
  it("week cells retain monthly totals and supported occurrence counts", () => {
    expect(
      weekCellLabel(workforceFixture().weekCells[0], "freeHours"),
    ).toContain(
      "28 h monthly total; 4 supported dates of 4 calendar occurrences",
    );
  });
  it("explains missing historical capacity and exact-label mapping limits", () => {
    const html = renderToStaticMarkup(
      <QualityContent report={workforceFixture()} />,
    );
    expect(html).toContain(
      "Current schedules are not used to reconstruct past capacity",
    );
    expect(html).toContain("Y2-8 is a course category");
    expect(html).toContain("Observed 1 Oct 2026");
  });
  it("sorts unavailable utilization after known zero rather than treating them as equal", () => {
    const people = workforceFixture().people;
    people[0].consumedUtilizationPercent = metric(null);
    people[1].consumedUtilizationPercent = metric(0);
    expect(
      sortPeople(people, "consumedUtilizationPercent", "asc").map(
        (p) => p.displayName,
      ),
    ).toEqual(["River", "Aria"]);
  });
});
