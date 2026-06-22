import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstitutionCard } from "../institution-card";
import type { IpedsInstitutionListItem } from "@/lib/us-universities/types";

const ROW: IpedsInstitutionListItem = {
  unitId: 100,
  instName: "Example University",
  city: "Berkeley",
  stateAbbr: "CA",
  control: 1,
  instSize: 5,
  acceptanceRate: 24.5,
  satReadingP25: 660,
  satReadingP75: 730,
  enrollmentTotal: 31000,
  gradRateBach6yr: 91.2,
  avgNetPrice: 18200,
  acceptancePrevYear: 25.0,
} as unknown as IpedsInstitutionListItem;

describe("InstitutionCard", () => {
  it("renders name, location, badges, and formatted stats", () => {
    const html = renderToStaticMarkup(
      <InstitutionCard
        row={ROW}
        inCompare={false}
        compareFull={false}
        onSelect={() => {}}
        onAddCompare={() => {}}
      />,
    );
    expect(html).toContain("Example University");
    expect(html).toContain("Berkeley");
    expect(html).toContain("CA");
    expect(html).toContain("Public");
    expect(html).toContain("20,000 and above");
    expect(html).toContain("24.5%");
    expect(html).toContain("660–730");
    expect(html).toContain("31,000");
    expect(html).toContain("91.2%");
    expect(html).toContain("$18,200");
    expect(html).toContain("Add Example University to compare");
  });

  it("renders em-dashes for null metrics and omits unmapped badges (fail-closed)", () => {
    const sparse: IpedsInstitutionListItem = {
      unitId: 101,
      instName: "Sparse College",
      city: null,
      stateAbbr: "NY",
      control: null,
      instSize: null,
      acceptanceRate: null,
      satReadingP25: null,
      satReadingP75: null,
      enrollmentTotal: null,
      gradRateBach6yr: null,
      avgNetPrice: null,
      acceptancePrevYear: null,
    } as unknown as IpedsInstitutionListItem;
    const html = renderToStaticMarkup(
      <InstitutionCard
        row={sparse}
        inCompare={false}
        compareFull={false}
        onSelect={() => {}}
        onAddCompare={() => {}}
      />,
    );
    expect(html).toContain("Sparse College");
    expect(html).toContain("—");
    expect(html).not.toContain("Public");
    expect(html).not.toContain("Under 1,000");
  });

  it("shows Added and disables the button when already in compare", () => {
    const html = renderToStaticMarkup(
      <InstitutionCard
        row={ROW}
        inCompare
        compareFull={false}
        onSelect={() => {}}
        onAddCompare={() => {}}
      />,
    );
    expect(html).toContain("Added");
    expect(html).toContain("disabled");
    expect(html).toContain("is already in compare");
  });

  it("shows acceptance delta when prior-year data is present", () => {
    const rowWithDelta: IpedsInstitutionListItem = {
      ...ROW,
      acceptanceRate: 24.5,
      acceptancePrevYear: 25.0,
    };
    const html = renderToStaticMarkup(
      <InstitutionCard
        row={rowWithDelta}
        inCompare={false}
        compareFull={false}
        onSelect={() => {}}
        onAddCompare={() => {}}
      />,
    );
    // Delta should be visible when prior-year data exists
    expect(html).toContain("0.5pp");
  });

  it("omits acceptance delta when prior-year data is null (fail-closed)", () => {
    const rowNoPrevYear: IpedsInstitutionListItem = {
      ...ROW,
      acceptanceRate: 24.5,
      acceptancePrevYear: null,
    };
    const html = renderToStaticMarkup(
      <InstitutionCard
        row={rowNoPrevYear}
        inCompare={false}
        compareFull={false}
        onSelect={() => {}}
        onAddCompare={() => {}}
      />,
    );
    // Delta should be absent (render nothing) when prior-year is null
    // We verify by checking that there's no "Acceptance Δ" label
    expect(html).not.toContain("Acceptance Δ");
  });
});
