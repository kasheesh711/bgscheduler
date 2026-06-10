import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CHURN_RULE_TEXT,
  STATUS_BADGE_VARIANTS,
  StudentDetailBody,
  StudentDetailPanel,
  computeTimelineSegments,
  daysBetweenIso,
  deriveConversionMarker,
} from "../student-detail-panel";
import type {
  SlimTransaction,
  StudentDirectoryEntry,
  StudentLiveStatus,
} from "@/lib/sales-dashboard/types";

const TODAY = "2026-06-10";

function student(overrides: Partial<StudentDirectoryEntry> = {}): StudentDirectoryEntry {
  return {
    key: "nong a",
    displayName: "Nong A",
    displayNameVariants: ["Nong A"],
    firstSeen: "2026-01-05",
    lastPaymentDate: "2026-05-01",
    totalRevenue: 24_000,
    txnCount: 2,
    addTxnCount: 1,
    programs: ["Math"],
    reps: ["Aoeng"],
    latestValidUntil: "2026-06-15",
    status: "Active",
    decisionDate: "2026-06-29",
    ...overrides,
  };
}

function txn(overrides: Partial<SlimTransaction> = {}): SlimTransaction {
  return {
    date: "2026-01-05",
    student: "Nong A",
    studentKey: "nong a",
    rep: "Aoeng",
    program: "Math",
    packageLabel: "20 hours",
    band: "20h",
    hours: 20,
    amount: 12_000,
    enrollmentType: "New Student",
    validUntil: "2026-03-05",
    sourceMonth: "2026-01",
    numberOfStudents: 1,
    kind: "normal",
    ...overrides,
  };
}

describe("STATUS_BADGE_VARIANTS", () => {
  it("maps every live status, with Churned destructive and Active primary", () => {
    const statuses: StudentLiveStatus[] = ["Active", "Retained", "Churned", "Pending", "Trial-only"];
    for (const status of statuses) {
      expect(STATUS_BADGE_VARIANTS[status]).toBeDefined();
    }
    expect(STATUS_BADGE_VARIANTS.Churned).toBe("destructive");
    expect(STATUS_BADGE_VARIANTS.Active).toBe("default");
  });
});

describe("daysBetweenIso", () => {
  it("computes whole-day differences across month boundaries", () => {
    expect(daysBetweenIso("2026-01-05", "2026-01-19")).toBe(14);
    expect(daysBetweenIso("2026-02-25", "2026-03-04")).toBe(7);
  });
});

describe("deriveConversionMarker", () => {
  it("returns null when no trial exists", () => {
    expect(deriveConversionMarker([txn()])).toBeNull();
  });

  it("marks a converted trial with the day count", () => {
    const marker = deriveConversionMarker([
      txn({ date: "2026-01-19", enrollmentType: "New Student" }),
      txn({ date: "2026-01-05", enrollmentType: "Trial", validUntil: null }),
    ]);
    expect(marker).toEqual({ trialDate: "2026-01-05", convertedDate: "2026-01-19", daysToConvert: 14 });
  });

  it("marks an unconverted trial and ignores additional rows", () => {
    const marker = deriveConversionMarker([
      txn({ date: "2026-01-05", enrollmentType: "Trial", validUntil: null }),
      txn({ date: "2026-02-01", kind: "additional", enrollmentType: "", salesType: "Books" }),
    ]);
    expect(marker).toEqual({ trialDate: "2026-01-05", convertedDate: null, daysToConvert: null });
  });

  it("anchors on the first trial and requires conversion strictly after it", () => {
    const marker = deriveConversionMarker([
      txn({ date: "2026-01-01", enrollmentType: "New Student" }),
      txn({ date: "2026-02-01", enrollmentType: "Trial", validUntil: null }),
      txn({ date: "2026-03-01", enrollmentType: "New Student" }),
    ]);
    expect(marker).toEqual({ trialDate: "2026-02-01", convertedDate: "2026-03-01", daysToConvert: 28 });
  });
});

describe("computeTimelineSegments", () => {
  it("attaches durations with a 1-day floor", () => {
    const segments = computeTimelineSegments([
      { from: "2026-01-01", until: "2026-01-31", status: "covered" },
      { from: "2026-01-31", until: "2026-01-31", status: "gap" },
    ]);
    expect(segments[0].days).toBe(30);
    expect(segments[1].days).toBe(1);
  });
});

describe("StudentDetailBody rendering", () => {
  it("renders the coverage timeline, conversion marker, and churn rule", () => {
    const html = renderToStaticMarkup(
      <StudentDetailBody
        student={student()}
        today={TODAY}
        journeyRows={[
          txn({ date: "2026-01-05", enrollmentType: "Trial", validUntil: null }),
          txn({ date: "2026-01-19", enrollmentType: "New Student", validUntil: "2026-03-05" }),
          txn({ date: "2026-04-20", enrollmentType: "Renewal", validUntil: "2026-06-15" }),
        ]}
        journeyTotal={3}
        journeyLoading={false}
        journeyError=""
      />,
    );
    expect(html).toContain("Renewal timeline");
    expect(html).toContain("Covered");
    expect(html).toContain("Gap");
    expect(html).toContain("Open coverage");
    expect(html).toContain("Trial 2026-01-05 → converted 2026-01-19 (14 days)");
    // The apostrophe in CHURN_RULE_TEXT is HTML-escaped in static markup, so
    // assert on an apostrophe-free fragment of the rule.
    expect(CHURN_RULE_TEXT).toContain("no payment lands within 14 days after");
    expect(html).toContain("no payment lands within 14 days after");
    expect(html).toContain("recomputed (live)");
    expect(html).toContain("Purchase history");
  });

  it("shows the nickname caveat only when multiple variants collapsed", () => {
    const withVariants = renderToStaticMarkup(
      <StudentDetailBody
        student={student({ displayNameVariants: ["Nong A", "NongA"] })}
        today={TODAY}
        journeyRows={[]}
        journeyTotal={0}
        journeyLoading={false}
        journeyError=""
      />,
    );
    expect(withVariants).toContain("Matched by nickname");
    expect(withVariants).toContain("NongA");

    const single = renderToStaticMarkup(
      <StudentDetailBody
        student={student()}
        today={TODAY}
        journeyRows={[]}
        journeyTotal={0}
        journeyLoading={false}
        journeyError=""
      />,
    );
    expect(single).not.toContain("Matched by nickname");
  });

  it("explains an empty timeline instead of rendering nothing", () => {
    const html = renderToStaticMarkup(
      <StudentDetailBody
        student={student({ status: "Trial-only", latestValidUntil: null, decisionDate: null })}
        today={TODAY}
        journeyRows={[txn({ enrollmentType: "Trial", validUntil: null })]}
        journeyTotal={1}
        journeyLoading={false}
        journeyError=""
      />,
    );
    expect(html).toContain("No package coverage to chart");
    expect(html).toContain("never converted");
  });

  it("shows a skeleton while the journey loads and surfaces fetch errors", () => {
    const loadingHtml = renderToStaticMarkup(
      <StudentDetailBody
        student={student()}
        today={TODAY}
        journeyRows={null}
        journeyTotal={0}
        journeyLoading
        journeyError=""
      />,
    );
    expect(loadingHtml).toContain("animate-pulse");

    const errorHtml = renderToStaticMarkup(
      <StudentDetailBody
        student={student()}
        today={TODAY}
        journeyRows={null}
        journeyTotal={0}
        journeyLoading={false}
        journeyError="Student journey request failed (500)"
      />,
    );
    expect(errorHtml).toContain("Student journey request failed (500)");
  });

  it("flags a truncated timeline when more rows exist than were fetched", () => {
    const html = renderToStaticMarkup(
      <StudentDetailBody
        student={student()}
        today={TODAY}
        journeyRows={[txn()]}
        journeyTotal={1200}
        journeyLoading={false}
        journeyError=""
      />,
    );
    expect(html).toContain("Timeline built from the most recent 1 of 1,200 transactions.");
  });
});

describe("StudentDetailPanel", () => {
  it("renders nothing while no student is selected", () => {
    const html = renderToStaticMarkup(
      <StudentDetailPanel student={null} today={TODAY} onClose={() => undefined} />,
    );
    expect(html).not.toContain("Renewal timeline");
    expect(html).not.toContain("Purchase history");
  });
});
