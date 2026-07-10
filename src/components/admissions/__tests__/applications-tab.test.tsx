import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => "/admissions/6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa"),
  useSearchParams: vi.fn(() => null),
}));

import {
  APPEND_EVENT_TYPES,
  ApplicationsTab,
  COMMITTED_CONFIRM_MESSAGE,
  DECISION_EVENT_LABELS,
  canRequestCommit,
  sortEventsAscending,
} from "../applications-tab";
import type {
  AdmissionsApplicationEventDto,
  AdmissionsCollegeListRowDto,
} from "@/lib/admissions/colleges";
import type { CaseRole } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const CASE_ID = "6a1f4c1e-2222-4444-8888-aaaaaaaaaaaa";

function makeCollege(
  overrides: Partial<AdmissionsCollegeListRowDto> & { id: string },
): AdmissionsCollegeListRowDto {
  return {
    caseId: CASE_ID,
    unitId: null,
    instName: "College",
    city: null,
    stateAbbr: null,
    country: "US",
    isManual: false,
    round: "rd",
    deadline: null,
    appStatus: "researching",
    category: "unset",
    firstChoiceMajor: null,
    secondChoiceMajor: null,
    admissionsUrl: null,
    portalUrl: null,
    aidOffered: null,
    aidNotes: null,
    createdAt: "2026-07-01T03:00:00.000Z",
    updatedAt: "2026-07-01T03:00:00.000Z",
    stats: null,
    stale: false,
    completeness: null,
    ...overrides,
  };
}

const HARVARD = makeCollege({
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  instName: "Harvard University",
  round: "rea",
  deadline: "2026-11-01",
});

const TUFTS = makeCollege({
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  instName: "Tufts University",
  round: "rd",
});

function makeEvent(
  overrides: Partial<AdmissionsApplicationEventDto> & { id: string },
): AdmissionsApplicationEventDto {
  return {
    listItemId: HARVARD.id,
    event: "submitted",
    eventDate: "2026-11-01",
    notes: null,
    createdAt: "2026-11-01T03:00:00.000Z",
    ...overrides,
  };
}

// A deferred → accepted chain, deliberately supplied OUT of order.
const CHAIN_UNORDERED: AdmissionsApplicationEventDto[] = [
  makeEvent({
    id: "e3333333-3333-4333-8333-333333333333",
    event: "accepted",
    eventDate: "2027-03-28",
    notes: "Regular-round admit after the deferral.",
    createdAt: "2027-03-28T03:00:00.000Z",
  }),
  makeEvent({
    id: "e1111111-1111-4111-8111-111111111111",
    event: "submitted",
    eventDate: "2026-11-01",
    createdAt: "2026-11-01T03:00:00.000Z",
  }),
  makeEvent({
    id: "e2222222-2222-4222-8222-222222222222",
    event: "deferred",
    eventDate: "2026-12-15",
    createdAt: "2026-12-15T03:00:00.000Z",
  }),
];

function renderTab(overrides: {
  colleges?: AdmissionsCollegeListRowDto[];
  committedListItemId?: string | null;
  committedCollegeName?: string | null;
  eventsByItem?: Record<string, AdmissionsApplicationEventDto[]>;
  viewerRole?: CaseRole;
} = {}): string {
  return renderToStaticMarkup(
    <ApplicationsTab
      caseId={CASE_ID}
      colleges={overrides.colleges ?? [HARVARD, TUFTS]}
      committedListItemId={overrides.committedListItemId ?? null}
      committedCollegeName={overrides.committedCollegeName ?? null}
      eventsByItem={overrides.eventsByItem ?? { [HARVARD.id]: CHAIN_UNORDERED }}
      viewerRole={overrides.viewerRole ?? "counselor"}
    />,
  );
}

// ── Pure helpers ────────────────────────────────────────────────────────

describe("sortEventsAscending", () => {
  it("orders by eventDate ascending without mutating the input", () => {
    const input = [...CHAIN_UNORDERED];
    const sorted = sortEventsAscending(input);
    expect(sorted.map((event) => event.event)).toEqual([
      "submitted",
      "deferred",
      "accepted",
    ]);
    // Input untouched (accepted still first).
    expect(input[0].event).toBe("accepted");
  });

  it("breaks same-day ties by createdAt (insertion order)", () => {
    const sameDay = [
      makeEvent({
        id: "e5555555-5555-4555-8555-555555555555",
        event: "accepted",
        eventDate: "2027-03-28",
        createdAt: "2027-03-28T09:00:00.000Z",
      }),
      makeEvent({
        id: "e4444444-4444-4444-8444-444444444444",
        event: "waitlisted",
        eventDate: "2027-03-28",
        createdAt: "2027-03-28T03:00:00.000Z",
      }),
    ];
    expect(sortEventsAscending(sameDay).map((event) => event.event)).toEqual([
      "waitlisted",
      "accepted",
    ]);
  });

  it("returns an empty list for no events", () => {
    expect(sortEventsAscending([])).toEqual([]);
  });
});

describe("canRequestCommit", () => {
  it("requires a selection", () => {
    expect(canRequestCommit("", null)).toBe(false);
  });

  it("allows a first commit", () => {
    expect(canRequestCommit(HARVARD.id, null)).toBe(true);
  });

  it("blocks any commit while another college holds the pointer (CM-44)", () => {
    expect(canRequestCommit(TUFTS.id, HARVARD.id)).toBe(false);
    expect(canRequestCommit(HARVARD.id, HARVARD.id)).toBe(false);
  });
});

describe("APPEND_EVENT_TYPES", () => {
  it("offers every decision event EXCEPT committed (CM-44 routes it separately)", () => {
    expect(APPEND_EVENT_TYPES).not.toContain("committed");
    expect(APPEND_EVENT_TYPES).toHaveLength(
      Object.keys(DECISION_EVENT_LABELS).length - 1,
    );
  });
});

// ── Tab rendering ───────────────────────────────────────────────────────

describe("ApplicationsTab timelines", () => {
  it("renders the decision chain oldest-first regardless of input order", () => {
    const html = renderTab();
    const timelineStart = html.indexOf(`data-testid="timeline-${HARVARD.id}"`);
    expect(timelineStart).toBeGreaterThan(-1);
    const timeline = html.slice(timelineStart);
    const submittedAt = timeline.indexOf("Submitted");
    const deferredAt = timeline.indexOf("Deferred");
    const acceptedAt = timeline.indexOf("Accepted");
    expect(submittedAt).toBeGreaterThan(-1);
    expect(deferredAt).toBeGreaterThan(submittedAt);
    expect(acceptedAt).toBeGreaterThan(deferredAt);
    // Both chain rows survive (append-only — deferred is not replaced).
    expect(timeline).toContain("Regular-round admit after the deferral.");
  });

  it("formats event dates D/M and shows an empty state for event-less colleges", () => {
    const html = renderTab();
    expect(html).toContain("15/12/2026");
    const tuftsCard = html.slice(html.indexOf(`application-card-${TUFTS.id}`));
    expect(tuftsCard).toContain("No decision events yet.");
  });

  it("shows the add-event action for staff only", () => {
    expect(renderTab()).toContain(`data-testid="add-event-${HARVARD.id}"`);
    expect(renderTab({ viewerRole: "student" })).not.toContain(
      `data-testid="add-event-${HARVARD.id}"`,
    );
  });
});

describe("ApplicationsTab committed selector (CM-44)", () => {
  it("offers the selector to staff with the confirm action disabled until a pick", () => {
    const html = renderTab();
    expect(html).toContain('data-testid="committed-select"');
    const button = html.match(/<button[^>]*data-testid="committed-request"[^>]*>/);
    expect(button).not.toBeNull();
    expect(button![0]).toContain("disabled");
  });

  it("hides the selector from students", () => {
    const html = renderTab({ viewerRole: "student" });
    expect(html).not.toContain('data-testid="committed-select"');
    expect(html).toContain("No committed college yet.");
  });

  it("shows the committed banner and per-card badge once a college is committed", () => {
    const html = renderTab({
      committedListItemId: HARVARD.id,
      committedCollegeName: "Harvard University",
    });
    expect(html).toContain('data-testid="committed-banner"');
    expect(html).toContain("Committed to Harvard University");
    expect(html).not.toContain('data-testid="committed-select"');
    const harvardCard = html.slice(
      html.indexOf(`application-card-${HARVARD.id}`),
      html.indexOf(`application-card-${TUFTS.id}`),
    );
    expect(harvardCard).toContain("Committed");
  });

  it("keeps the matriculation confirm copy stable", () => {
    expect(COMMITTED_CONFIRM_MESSAGE).toBe(
      "This marks the final matriculation choice.",
    );
  });
});
