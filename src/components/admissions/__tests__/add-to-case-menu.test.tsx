import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AddToCaseMenu,
  AddToCasePicker,
  addToCaseNotice,
  addableCases,
  buildAddToCasePayload,
  caseCollegesEndpoint,
  caseDisplayName,
  filterCaseOptions,
  loadCaseload,
  submitAddToCase,
  type AddToCaseCandidate,
} from "../add-to-case-menu";

// ── Fixtures ────────────────────────────────────────────────────────────

const ACTIVE_PLOY: AddToCaseCandidate = {
  caseId: "11111111-aaaa-4aaa-8aaa-111111111111",
  studentName: "Ploy Srisuk",
  preferredName: "Ploy",
  cohortName: "Class of 2027",
  status: "active",
};

const ACTIVE_BEAM: AddToCaseCandidate = {
  caseId: "22222222-bbbb-4bbb-8bbb-222222222222",
  studentName: "Beam Chaiyo",
  preferredName: null,
  cohortName: "Class of 2028",
  status: "active",
};

const COMMITTED_NIN: AddToCaseCandidate = {
  caseId: "33333333-cccc-4ccc-8ccc-333333333333",
  studentName: "Nin Wong",
  preferredName: null,
  cohortName: "Class of 2027",
  status: "committed",
};

const ARCHIVED_MAY: AddToCaseCandidate = {
  caseId: "44444444-dddd-4ddd-8ddd-444444444444",
  studentName: "May Tan",
  preferredName: null,
  cohortName: "Class of 2026",
  status: "archived",
};

const ALL_CASES = [ACTIVE_PLOY, ACTIVE_BEAM, COMMITTED_NIN, ARCHIVED_MAY];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noop = () => {};

function renderPicker(
  overrides: Partial<Parameters<typeof AddToCasePicker>[0]> = {},
): string {
  return renderToStaticMarkup(
    <AddToCasePicker
      cases={addableCases(ALL_CASES)}
      query=""
      onQueryChange={noop}
      onPick={noop}
      loading={false}
      loadFailed={false}
      onRetry={noop}
      submittingCaseId={null}
      notice={null}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe("addableCases", () => {
  it("keeps only active cases, preserving order", () => {
    expect(addableCases(ALL_CASES)).toEqual([ACTIVE_PLOY, ACTIVE_BEAM]);
  });

  it("returns an empty list when no case is active", () => {
    expect(addableCases([COMMITTED_NIN, ARCHIVED_MAY])).toEqual([]);
  });
});

describe("filterCaseOptions", () => {
  const active = [ACTIVE_PLOY, ACTIVE_BEAM];

  it("returns every case for a blank query", () => {
    expect(filterCaseOptions(active, "")).toEqual(active);
    expect(filterCaseOptions(active, "   ")).toEqual(active);
  });

  it("matches the full student name case-insensitively", () => {
    expect(filterCaseOptions(active, "beam")).toEqual([ACTIVE_BEAM]);
    expect(filterCaseOptions(active, "SRISUK")).toEqual([ACTIVE_PLOY]);
  });

  it("matches the preferred name and the cohort name", () => {
    expect(filterCaseOptions(active, "ploy")).toEqual([ACTIVE_PLOY]);
    expect(filterCaseOptions(active, "2028")).toEqual([ACTIVE_BEAM]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCaseOptions(active, "zzz")).toEqual([]);
  });
});

describe("caseDisplayName", () => {
  it("prefers the preferred name when set", () => {
    expect(caseDisplayName(ACTIVE_PLOY)).toBe("Ploy");
  });

  it("falls back to the full name for null or blank preferred names", () => {
    expect(caseDisplayName(ACTIVE_BEAM)).toBe("Beam Chaiyo");
    expect(caseDisplayName({ ...ACTIVE_PLOY, preferredName: "  " })).toBe("Ploy Srisuk");
  });
});

describe("addToCaseNotice", () => {
  it("maps 2xx to the success toast with the student name", () => {
    expect(addToCaseNotice(200, "Ploy")).toEqual({
      kind: "success",
      message: "Added to Ploy's list",
    });
  });

  it("maps 409 to the duplicate-conflict toast", () => {
    expect(addToCaseNotice(409, "Ploy")).toEqual({
      kind: "conflict",
      message: "Already on the list",
    });
  });

  it("maps any other status to a generic retryable error", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      expect(addToCaseNotice(status, "Ploy").kind).toBe("error");
    }
  });
});

describe("buildAddToCasePayload / caseCollegesEndpoint", () => {
  it("posts the unitId with the default Regular Decision round", () => {
    expect(buildAddToCasePayload(166027)).toEqual({ unitId: 166027, round: "rd" });
  });

  it("targets the case's colleges endpoint", () => {
    expect(caseCollegesEndpoint(ACTIVE_PLOY.caseId)).toBe(
      `/api/admissions/cases/${ACTIVE_PLOY.caseId}/colleges`,
    );
  });
});

// ── loadCaseload (mocked fetch) ─────────────────────────────────────────

describe("loadCaseload", () => {
  it("returns granted with active cases only on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ cases: ALL_CASES }, 200));
    await expect(loadCaseload(fetchImpl as typeof fetch)).resolves.toEqual({
      kind: "granted",
      cases: [ACTIVE_PLOY, ACTIVE_BEAM],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/admissions/cases");
  });

  it("returns denied on 403 and 401 (non-staff hides fail-closed)", async () => {
    for (const status of [403, 401]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "Forbidden" }, status));
      await expect(loadCaseload(fetchImpl as typeof fetch)).resolves.toEqual({ kind: "denied" });
    }
  });

  it("returns error (never granted) on other failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    await expect(loadCaseload(fetchImpl as typeof fetch)).resolves.toEqual({ kind: "error" });
  });

  it("returns error on network failure", async () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(loadCaseload(fetchImpl as typeof fetch)).resolves.toEqual({ kind: "error" });
  });

  it("treats a malformed payload as an empty caseload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ cases: "nope" }, 200));
    await expect(loadCaseload(fetchImpl as typeof fetch)).resolves.toEqual({
      kind: "granted",
      cases: [],
    });
  });
});

// ── submitAddToCase (mocked fetch) ──────────────────────────────────────

describe("submitAddToCase", () => {
  it("POSTs {unitId, round:'rd'} to the case's colleges endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ college: {} }, 200));
    await submitAddToCase(166027, ACTIVE_PLOY, fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/admissions/cases/${ACTIVE_PLOY.caseId}/colleges`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: 166027, round: "rd" }),
      },
    );
  });

  it("maps 200 to the success toast naming the student", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ college: {} }, 200));
    await expect(submitAddToCase(166027, ACTIVE_PLOY, fetchImpl as typeof fetch)).resolves.toEqual({
      kind: "success",
      message: "Added to Ploy's list",
    });
  });

  it("maps 409 to the 'Already on the list' toast", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "Conflict" }, 409));
    await expect(submitAddToCase(166027, ACTIVE_PLOY, fetchImpl as typeof fetch)).resolves.toEqual({
      kind: "conflict",
      message: "Already on the list",
    });
  });

  it("maps a network failure to the generic error toast", async () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(submitAddToCase(166027, ACTIVE_PLOY, fetchImpl as typeof fetch)).resolves.toEqual({
      kind: "error",
      message: "Could not add to case — try again",
    });
  });
});

// ── AddToCasePicker rendering ───────────────────────────────────────────

describe("AddToCasePicker", () => {
  it("renders one option per active case with student and cohort names", () => {
    const html = renderPicker();
    expect(html).toContain(`add-to-case-option-${ACTIVE_PLOY.caseId}`);
    expect(html).toContain(`add-to-case-option-${ACTIVE_BEAM.caseId}`);
    expect(html).toContain("Ploy");
    expect(html).toContain("Beam Chaiyo");
    expect(html).toContain("Class of 2027");
    expect(html).toContain("Class of 2028");
  });

  it("applies the search query to the option list", () => {
    const html = renderPicker({ query: "beam" });
    expect(html).toContain(`add-to-case-option-${ACTIVE_BEAM.caseId}`);
    expect(html).not.toContain(`add-to-case-option-${ACTIVE_PLOY.caseId}`);
  });

  it("shows the 409 conflict notice", () => {
    const html = renderPicker({ notice: addToCaseNotice(409, "Ploy") });
    expect(html).toContain('data-testid="add-to-case-notice"');
    expect(html).toContain("Already on the list");
  });

  it("shows the success notice with the student name", () => {
    const html = renderPicker({ notice: addToCaseNotice(200, "Ploy") });
    expect(html).toContain("Added to Ploy");
  });

  it("shows the loading state", () => {
    const html = renderPicker({ loading: true });
    expect(html).toContain("Loading cases…");
    expect(html).not.toContain("add-to-case-option-");
  });

  it("shows the load-failed state with a Retry control", () => {
    const html = renderPicker({ loadFailed: true });
    expect(html).toContain("Could not load cases.");
    expect(html).toContain("Retry");
  });

  it("shows the empty state when there are no active cases", () => {
    const html = renderPicker({ cases: [] });
    expect(html).toContain("No active cases.");
  });

  it("disables options while a submit is in flight", () => {
    const html = renderPicker({ submittingCaseId: ACTIVE_PLOY.caseId });
    const option = html.match(
      new RegExp(`<button[^>]*data-testid="add-to-case-option-${ACTIVE_BEAM.caseId}"[^>]*>`),
    );
    expect(option).not.toBeNull();
    expect(option![0]).toContain("disabled");
  });
});

// ── AddToCaseMenu rendering ─────────────────────────────────────────────

describe("AddToCaseMenu", () => {
  it("renders the labeled trigger by default", () => {
    const html = renderToStaticMarkup(
      <AddToCaseMenu unitId={166027} instName="Harvard University" />,
    );
    expect(html).toContain("Add to case");
    expect(html).toContain("Add Harvard University to a case");
  });

  it("renders an icon-only trigger in compact mode", () => {
    const html = renderToStaticMarkup(
      <AddToCaseMenu unitId={166027} instName="Harvard University" compact />,
    );
    expect(html).toContain('aria-label="Add Harvard University to a case"');
    expect(html).not.toContain(">Add to case<");
  });

  it("renders nothing once caseload access is denied (403, fail-closed)", () => {
    const html = renderToStaticMarkup(
      <AddToCaseMenu unitId={166027} instName="Harvard University" initialAccess="denied" />,
    );
    expect(html).toBe("");
  });
});
