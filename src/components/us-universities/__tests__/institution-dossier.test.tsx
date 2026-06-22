import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InstitutionProfile } from "@/lib/us-universities/types";
import {
  InstitutionDossier,
  dossierExternalLinks,
  normalizeUrl,
} from "../institution-dossier";

// Minimal profile: only fields the dossier reads. Cast keeps the existing
// component tests independent of the full Drizzle row shape.
function makeProfile(overrides: Partial<InstitutionProfile> = {}): InstitutionProfile {
  return {
    unitId: 166027,
    instName: "Test University",
    alias: "TU",
    city: "Cambridge",
    stateAbbr: "MA",
    region: 1,
    control: 2,
    instSize: 4,
    locale: 11,
    carnegieBasic: 15,
    hbcu: false,
    landGrant: false,
    website: "www.example.edu",
    admissionsUrl: "https://admit.example.edu",
    netPriceCalcUrl: null,
    acceptanceRate: 12.5,
    yieldRate: null,
    satReadingP25: 700,
    satReadingP75: 770,
    satMathP25: null,
    satMathP75: null,
    actCompositeP25: null,
    actCompositeP75: null,
    satSubmitPct: null,
    actSubmitPct: null,
    admConsiderations: { ADMCON1: 1 },
    tuitionInState: 55000,
    tuitionOutState: null,
    totalPriceInState: 80000,
    totalPriceOutState: null,
    roomBoardAmt: 18000,
    avgNetPrice: null,
    appFeeUg: null,
    gradRateBach6yr: 96,
    gradRateTotal: null,
    retentionFt: null,
    transferOutRate: null,
    studentFacultyRatio: 7,
    omAward8yr: null,
    omStillEnrolled8yr: null,
    pctWomen: null,
    pctWhite: 40,
    pctBlack: 10,
    pctHispanic: null,
    pctAsianPacIsl: 20,
    pctAmInd: null,
    pctTwoOrMore: null,
    pctUnknown: null,
    pctNonresident: null,
    pctInState: null,
    pctOutOfState: null,
    enrollmentTotal: 20000,
    enrollmentUg: null,
    enrollmentGrad: null,
    completions: [],
    topMajors: [{ cip2: "11", label: "Computer & Information Sciences", count: 500 }],
    admissionsTrend: [
      {
        dataYear: "2022-23",
        acceptanceRate: 13.0,
        yieldRate: 80.0,
        applicantsTotal: 26_000,
        admitsTotal: 3_380,
        enrolledTotal: 2_700,
        satReadingP25: 690,
        satReadingP75: 760,
        satMathP25: 740,
        satMathP75: 800,
        actCompositeP25: 34,
        actCompositeP75: 36,
      },
      {
        dataYear: "2023-24",
        acceptanceRate: 12.5,
        yieldRate: 82.0,
        applicantsTotal: 28_000,
        admitsTotal: 3_500,
        enrolledTotal: 2_870,
        satReadingP25: 700,
        satReadingP75: 770,
        satMathP25: 750,
        satMathP75: 800,
        actCompositeP25: 34,
        actCompositeP75: 36,
      },
    ],
    ...overrides,
  } as InstitutionProfile;
}

describe("normalizeUrl", () => {
  it("prefixes a bare host with https://", () => {
    expect(normalizeUrl("www.example.edu")).toBe("https://www.example.edu");
  });
  it("leaves an absolute http(s) url untouched", () => {
    expect(normalizeUrl("https://x.edu")).toBe("https://x.edu");
    expect(normalizeUrl("http://x.edu")).toBe("http://x.edu");
  });
  it("returns null for null/undefined/blank", () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });
});

describe("dossierExternalLinks", () => {
  it("includes only present links, normalized, in canonical order", () => {
    const links = dossierExternalLinks({
      website: "www.example.edu",
      admissionsUrl: "https://admit.example.edu",
      netPriceCalcUrl: null,
    });
    expect(links.map((l) => l.key)).toEqual(["website", "admissions"]);
    expect(links[0].href).toBe("https://www.example.edu");
    expect(links[1].href).toBe("https://admit.example.edu");
  });
  it("returns an empty list when no urls are present", () => {
    expect(
      dossierExternalLinks({ website: null, admissionsUrl: null, netPriceCalcUrl: null }),
    ).toEqual([]);
  });
});

describe("InstitutionDossier", () => {
  it("renders the cover band with name, alias, location, and badges", () => {
    const html = renderToStaticMarkup(
      <InstitutionDossier profile={makeProfile()} backHref="/us-universities?page=1" compareIds={[]} />,
    );
    expect(html).toContain("Test University");
    expect(html).toContain("TU");
    expect(html).toContain("Cambridge");
    expect(html).toContain("MA");
    expect(html).toContain("Private nonprofit"); // CONTROL_LABELS[2]
    expect(html).toContain("R1: Doctoral – Very high research"); // carnegieLabel(15)
  });

  it("renders the back link and an oversized acceptance-rate headline stat", () => {
    const html = renderToStaticMarkup(
      <InstitutionDossier profile={makeProfile()} backHref="/us-universities?page=1" compareIds={[]} />,
    );
    expect(html).toContain("href=\"/us-universities?page=1\"");
    expect(html).toContain("12.5%");
  });

  it("omits a section when all its fields are absent (fail-closed)", () => {
    const html = renderToStaticMarkup(
      <InstitutionDossier
        profile={makeProfile({
          pctWomen: null, pctWhite: null, pctBlack: null, pctHispanic: null,
          pctAsianPacIsl: null, pctAmInd: null, pctTwoOrMore: null, pctUnknown: null,
          pctNonresident: null, pctInState: null, pctOutOfState: null,
        })}
        backHref="/us-universities"
        compareIds={[]}
      />,
    );
    // No "Student body" heading rendered when every demographic field is null.
    expect(html).not.toContain(">Student body<");
  });

  it("renders external action links via normalizeUrl", () => {
    const html = renderToStaticMarkup(
      <InstitutionDossier profile={makeProfile()} backHref="/us-universities" compareIds={[]} />,
    );
    expect(html).toContain("href=\"https://www.example.edu\"");
    expect(html).toContain("href=\"https://admit.example.edu\"");
  });

  it("renders the admissions trend section when admissionsTrend has data", () => {
    const html = renderToStaticMarkup(
      <InstitutionDossier profile={makeProfile()} backHref="/us-universities" compareIds={[]} />,
    );
    expect(html).toContain("Admissions over time");
    expect(html).toContain("2022-23");
    expect(html).toContain("2023-24");
  });

  it("suppresses the admissions trend section when admissionsTrend is empty", () => {
    const html = renderToStaticMarkup(
      <InstitutionDossier
        profile={makeProfile({ admissionsTrend: [] })}
        backHref="/us-universities"
        compareIds={[]}
      />,
    );
    expect(html).not.toContain("Admissions over time");
  });
});
