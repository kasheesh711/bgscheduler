import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  ASK_STATUS_ACTION_LABELS,
  ASK_STATUS_LABELS,
  RecommendersPanel,
  countScoreSends,
  findCollegeDoc,
  unlinkedColleges,
  type RecommenderPanelCollege,
} from "../recommenders-panel";
import type {
  AdmissionsCollegeDocDto,
  AdmissionsRecommenderWithCollegesDto,
} from "@/lib/admissions/recommenders";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

const COLLEGES: RecommenderPanelCollege[] = [
  { id: "11111111-aaaa-4aaa-8aaa-111111111111", instName: "Harvard University" },
  { id: "22222222-bbbb-4bbb-8bbb-222222222222", instName: "Tufts University" },
];
const [HARVARD, TUFTS] = COLLEGES;

function makeRecommender(
  overrides: Partial<AdmissionsRecommenderWithCollegesDto> & { id: string },
): AdmissionsRecommenderWithCollegesDto {
  return {
    caseId: CASE_ID,
    name: "Recommender",
    roleSubject: null,
    contact: null,
    askStatus: "planned",
    colleges: [],
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    ...overrides,
  };
}

// Planned recommender, not yet linked anywhere.
const PLANNED_REC = makeRecommender({
  id: "r1111111-1111-4111-8111-111111111111",
  name: "Kru Somchai",
  roleSubject: "Physics teacher",
});

// Agreed recommender with one submitted and one pending college letter.
const AGREED_REC = makeRecommender({
  id: "r2222222-2222-4222-8222-222222222222",
  name: "Ms. Fields",
  askStatus: "agreed",
  contact: "fields@example.com",
  colleges: [
    {
      id: "l1111111-1111-4111-8111-111111111111",
      recommenderId: "r2222222-2222-4222-8222-222222222222",
      listItemId: HARVARD.id,
      submitted: true,
      submittedAt: "2026-11-01T03:00:00.000Z",
      createdAt: "2026-10-01T03:00:00.000Z",
      updatedAt: "2026-11-01T03:00:00.000Z",
    },
    {
      id: "l2222222-2222-4222-8222-222222222222",
      recommenderId: "r2222222-2222-4222-8222-222222222222",
      listItemId: TUFTS.id,
      submitted: false,
      submittedAt: null,
      createdAt: "2026-10-01T03:00:00.000Z",
      updatedAt: "2026-10-01T03:00:00.000Z",
    },
  ],
});

function makeDoc(
  overrides: Partial<AdmissionsCollegeDocDto> & { id: string },
): AdmissionsCollegeDocDto {
  return {
    listItemId: HARVARD.id,
    docType: "transcript",
    testSittingId: null,
    sent: false,
    sentAt: null,
    createdAt: "2026-10-01T03:00:00.000Z",
    updatedAt: "2026-10-01T03:00:00.000Z",
    ...overrides,
  };
}

const DOCS: AdmissionsCollegeDocDto[] = [
  makeDoc({
    id: "d1111111-1111-4111-8111-111111111111",
    docType: "transcript",
    sent: true,
    sentAt: "2026-10-02T03:00:00.000Z",
  }),
  makeDoc({ id: "d2222222-2222-4222-8222-222222222222", docType: "school_report" }),
  makeDoc({
    id: "d3333333-3333-4333-8333-333333333333",
    docType: "score_send",
    testSittingId: "s1111111-1111-4111-8111-111111111111",
    sent: true,
    sentAt: "2026-10-03T03:00:00.000Z",
  }),
  makeDoc({
    id: "d4444444-4444-4444-8444-444444444444",
    docType: "score_send",
    testSittingId: "s2222222-2222-4222-8222-222222222222",
  }),
];

function renderPanel(overrides: {
  recommenders?: AdmissionsRecommenderWithCollegesDto[];
  collegeDocs?: AdmissionsCollegeDocDto[];
  colleges?: RecommenderPanelCollege[];
  viewerRole?: CaseRole;
} = {}): string {
  return renderToStaticMarkup(
    <RecommendersPanel
      caseId={CASE_ID}
      recommenders={overrides.recommenders ?? [PLANNED_REC, AGREED_REC]}
      collegeDocs={overrides.collegeDocs ?? DOCS}
      colleges={overrides.colleges ?? COLLEGES}
      viewerRole={overrides.viewerRole ?? "counselor"}
    />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("findCollegeDoc", () => {
  it("finds the transcript / school-report row for a college", () => {
    expect(findCollegeDoc(DOCS, HARVARD.id, "transcript")?.sent).toBe(true);
    expect(findCollegeDoc(DOCS, HARVARD.id, "school_report")?.sent).toBe(false);
  });

  it("returns null when the college has no row of that type", () => {
    expect(findCollegeDoc(DOCS, TUFTS.id, "transcript")).toBeNull();
  });
});

describe("countScoreSends", () => {
  it("tallies sent vs total score-send rows per college", () => {
    expect(countScoreSends(DOCS, HARVARD.id)).toEqual({ sent: 1, total: 2 });
  });

  it("returns zeros for a college with no score sends", () => {
    expect(countScoreSends(DOCS, TUFTS.id)).toEqual({ sent: 0, total: 0 });
  });
});

describe("unlinkedColleges", () => {
  it("returns only colleges the recommender is not linked to", () => {
    expect(unlinkedColleges(AGREED_REC, COLLEGES)).toEqual([]);
    expect(unlinkedColleges(PLANNED_REC, COLLEGES)).toEqual(COLLEGES);
  });
});

// ── Panel rendering ─────────────────────────────────────────────────────

describe("RecommendersPanel", () => {
  it("chips each recommender with its ask status", () => {
    const html = renderPanel();
    expect(html).toContain(`data-testid="ask-status-${PLANNED_REC.id}"`);
    expect(html).toContain(ASK_STATUS_LABELS.planned);
    expect(html).toContain(ASK_STATUS_LABELS.agreed);
  });

  it("offers staff only the forward moves of the ask machine (CM-50)", () => {
    const html = renderPanel();
    // planned → asked is the only move; agreed is terminal (no buttons).
    expect(html).toContain(ASK_STATUS_ACTION_LABELS.asked);
    expect(html).not.toContain(ASK_STATUS_ACTION_LABELS.declined);
    expect(html).not.toContain(ASK_STATUS_ACTION_LABELS.planned);
  });

  it("offers agree/decline moves from the asked state", () => {
    const asked = makeRecommender({
      id: "r3333333-3333-4333-8333-333333333333",
      name: "Coach Lek",
      askStatus: "asked",
    });
    const html = renderPanel({ recommenders: [asked] });
    expect(html).toContain(ASK_STATUS_ACTION_LABELS.agreed);
    expect(html).toContain(ASK_STATUS_ACTION_LABELS.declined);
  });

  it("renders per-college submission checkboxes with their checked state", () => {
    const html = renderPanel();
    const submittedBox = html.match(
      new RegExp(
        `<input[^>]*data-testid="submission-${AGREED_REC.id}-${HARVARD.id}"[^>]*>`,
      ),
    );
    expect(submittedBox).not.toBeNull();
    expect(submittedBox![0]).toContain("checked");
    const pendingBox = html.match(
      new RegExp(
        `<input[^>]*data-testid="submission-${AGREED_REC.id}-${TUFTS.id}"[^>]*>`,
      ),
    );
    expect(pendingBox).not.toBeNull();
    expect(pendingBox![0]).not.toContain("checked");
  });

  it("renders transcript / school-report toggles and the score-send count", () => {
    const html = renderPanel();
    const transcript = html.match(
      new RegExp(`<input[^>]*data-testid="doc-transcript-${HARVARD.id}"[^>]*>`),
    );
    expect(transcript).not.toBeNull();
    expect(transcript![0]).toContain("checked");
    const report = html.match(
      new RegExp(`<input[^>]*data-testid="doc-school-report-${HARVARD.id}"[^>]*>`),
    );
    expect(report).not.toBeNull();
    expect(report![0]).not.toContain("checked");
    expect(html).toContain("1/2 sent");
    expect(html).toContain("none recorded");
  });

  it("renders read-only for students: no composer, no moves, disabled checkboxes", () => {
    const html = renderPanel({ viewerRole: "student" });
    expect(html).not.toContain('data-testid="recommender-add"');
    expect(html).not.toContain(ASK_STATUS_ACTION_LABELS.asked);
    expect(html).not.toContain('data-testid="link-select-');
    const box = html.match(
      new RegExp(
        `<input[^>]*data-testid="submission-${AGREED_REC.id}-${HARVARD.id}"[^>]*>`,
      ),
    );
    expect(box).not.toBeNull();
    expect(box![0]).toContain("disabled");
  });

  it("shows the link-college control only for recommenders with unlinked colleges", () => {
    const html = renderPanel();
    expect(html).toContain(`data-testid="link-select-${PLANNED_REC.id}"`);
    expect(html).not.toContain(`data-testid="link-select-${AGREED_REC.id}"`);
  });
});
