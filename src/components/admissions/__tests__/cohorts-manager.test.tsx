import { isValidElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  COHORT_GRADUATION_YEARS,
  COHORT_GRADUATION_YEAR_MAX,
  COHORT_GRADUATION_YEAR_MIN,
  CohortRow,
  CohortsManager,
  DUPLICATE_COHORT_ERROR,
  EMPTY_COHORT_FORM,
  buildCohortPayload,
  formatPushResult,
  requestCohortCreate,
  requestPushNewItems,
} from "../cohorts-manager";
import type { CohortRowProps } from "../cohorts-manager";
import type { AdmissionsCohortDto } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const COHORT_2027: AdmissionsCohortDto = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  name: "Class of 2027",
  graduationYear: 2027,
};

const COHORT_2028: AdmissionsCohortDto = {
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  name: "Class of 2028",
  graduationYear: 2028,
};

// ── Test utilities ──────────────────────────────────────────────────────

/** Request init shape recorded by the fetch stub. */
interface RecordedInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

type FetchStub = (
  url: string,
  init?: RecordedInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Stubs global fetch with a single canned JSON response; returns the spy. */
function stubFetch(options: { ok?: boolean; status?: number; payload?: unknown } = {}) {
  const ok = options.ok ?? true;
  const status = options.status ?? (ok ? 200 : 500);
  const payload = options.payload ?? null;
  const fetchMock = vi.fn<FetchStub>(async () => ({
    ok,
    status,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBodyOf(fetchMock: ReturnType<typeof stubFetch>): unknown {
  return JSON.parse(fetchMock.mock.calls[0]![1]!.body);
}

/**
 * Depth-first element-tree search by data-testid. Works without a DOM: the
 * hook-free CohortRow is invoked directly, so its Button elements (and
 * their onClick props) sit in the returned element tree.
 */
function findByTestId(node: unknown, testId: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node as unknown[]) {
      const found = findByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props["data-testid"] === testId) {
    return node as ReactElement<Record<string, unknown>>;
  }
  return findByTestId(props.children, testId);
}

function makeRowProps(overrides: Partial<CohortRowProps> = {}): CohortRowProps {
  return {
    cohort: COHORT_2027,
    busy: false,
    pushMessage: null,
    onEditTemplate: vi.fn(),
    onRequestPush: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe("buildCohortPayload", () => {
  it("rejects a blank name", () => {
    const result = buildCohortPayload({ name: "  ", graduationYear: "2027" });
    expect(result).toEqual({ ok: false, error: "Cohort name is required." });
    expect(EMPTY_COHORT_FORM).toEqual({ name: "", graduationYear: "" });
  });

  it("rejects a missing or out-of-range graduation year", () => {
    for (const graduationYear of ["", "abc", "2023", "2041"]) {
      const result = buildCohortPayload({ name: "Class of X", graduationYear });
      expect(result.ok).toBe(false);
    }
  });

  it("builds a trimmed body with the year coerced to a number", () => {
    const result = buildCohortPayload({ name: "  Class of 2027 ", graduationYear: "2027" });
    expect(result).toEqual({
      ok: true,
      body: { name: "Class of 2027", graduationYear: 2027 },
    });
  });
});

describe("COHORT_GRADUATION_YEARS", () => {
  it("spans 2024–2040 inclusive, ascending", () => {
    expect(COHORT_GRADUATION_YEAR_MIN).toBe(2024);
    expect(COHORT_GRADUATION_YEAR_MAX).toBe(2040);
    expect(COHORT_GRADUATION_YEARS).toHaveLength(17);
    expect(COHORT_GRADUATION_YEARS[0]).toBe(2024);
    expect(COHORT_GRADUATION_YEARS[16]).toBe(2040);
  });
});

describe("formatPushResult", () => {
  it("renders the exact inline summary line", () => {
    expect(formatPushResult({ casesUpdated: 3, tasksCreated: 12 })).toBe(
      "3 cases updated, 12 tasks created",
    );
    expect(formatPushResult({ casesUpdated: 0, tasksCreated: 0 })).toBe(
      "0 cases updated, 0 tasks created",
    );
  });
});

// ── Create flow ─────────────────────────────────────────────────────────

describe("requestCohortCreate", () => {
  it("POSTs the validated body and reports success", async () => {
    const fetchMock = stubFetch({ payload: { cohort: COHORT_2027 } });
    const result = await requestCohortCreate({ name: " Class of 2027 ", graduationYear: "2027" });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admissions/cohorts");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(requestBodyOf(fetchMock)).toEqual({ name: "Class of 2027", graduationYear: 2027 });
  });

  it("maps a 409 to the inline duplicate-name error", async () => {
    stubFetch({ ok: false, status: 409, payload: { error: "Conflict" } });
    const result = await requestCohortCreate({ name: "Class of 2027", graduationYear: "2027" });
    expect(result).toEqual({ ok: false, error: DUPLICATE_COHORT_ERROR });
    expect(DUPLICATE_COHORT_ERROR).toBe("A cohort with this name already exists.");
  });

  it("never reaches the wire for an invalid form", async () => {
    const fetchMock = stubFetch();
    const result = await requestCohortCreate({ name: "", graduationYear: "2027" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces other response JSON errors and network failures", async () => {
    stubFetch({ ok: false, status: 403, payload: { error: "Forbidden" } });
    const denied = await requestCohortCreate({ name: "Class of 2027", graduationYear: "2027" });
    expect(denied).toEqual({ ok: false, error: "Forbidden" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const network = await requestCohortCreate({ name: "Class of 2027", graduationYear: "2027" });
    expect(network).toEqual({ ok: false, error: "boom" });
  });
});

// ── Push flow (CM-21) ───────────────────────────────────────────────────

describe("requestPushNewItems", () => {
  it("POSTs the push action to the cohort's templates route and formats the summary", async () => {
    const fetchMock = stubFetch({
      payload: { templateId: "t-1", templateVersion: 2, casesUpdated: 3, tasksCreated: 12 },
    });
    const result = await requestPushNewItems(COHORT_2027.id);
    expect(result).toEqual({ ok: true, message: "3 cases updated, 12 tasks created" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/admissions/cohorts/${COHORT_2027.id}/templates`,
    );
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(requestBodyOf(fetchMock)).toEqual({ action: "push_new_items" });
  });

  it("maps a 404 (no published template) to a friendly inline error", async () => {
    stubFetch({ ok: false, status: 404, payload: { error: "Not found" } });
    const result = await requestPushNewItems(COHORT_2027.id);
    expect(result).toEqual({
      ok: false,
      error: "This cohort has no published template to push yet.",
    });
  });

  it("surfaces other response JSON errors", async () => {
    stubFetch({ ok: false, status: 403, payload: { error: "Forbidden" } });
    const result = await requestPushNewItems(COHORT_2027.id);
    expect(result).toEqual({ ok: false, error: "Forbidden" });
  });
});

// ── Row action wiring (element-tree traversal, no DOM) ──────────────────

describe("CohortRow wiring", () => {
  it("fires onEditTemplate with the cohort id from the edit-template button", () => {
    const onEditTemplate = vi.fn();
    const row = CohortRow(makeRowProps({ onEditTemplate }));
    const button = findByTestId(row, `cohort-edit-template-${COHORT_2027.id}`);
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(onEditTemplate).toHaveBeenCalledWith(COHORT_2027.id);
  });

  it("routes Push new items through onRequestPush (confirm dialog, never direct)", () => {
    const onRequestPush = vi.fn();
    const row = CohortRow(makeRowProps({ onRequestPush }));
    const button = findByTestId(row, `cohort-push-${COHORT_2027.id}`);
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(onRequestPush).toHaveBeenCalledWith(COHORT_2027);
  });

  it("disables both actions while the row is busy", () => {
    const row = CohortRow(makeRowProps({ busy: true }));
    const edit = findByTestId(row, `cohort-edit-template-${COHORT_2027.id}`);
    const push = findByTestId(row, `cohort-push-${COHORT_2027.id}`);
    expect(edit!.props.disabled).toBe(true);
    expect(push!.props.disabled).toBe(true);
  });

  it("renders the inline push-result line only when a message is present", () => {
    const withMessage = renderToStaticMarkup(
      <table>
        <tbody>
          <CohortRow {...makeRowProps({ pushMessage: "3 cases updated, 12 tasks created" })} />
        </tbody>
      </table>,
    );
    expect(withMessage).toContain(`data-testid="cohort-push-result-${COHORT_2027.id}"`);
    expect(withMessage).toContain("3 cases updated, 12 tasks created");

    const withoutMessage = renderToStaticMarkup(
      <table>
        <tbody>
          <CohortRow {...makeRowProps()} />
        </tbody>
      </table>,
    );
    expect(withoutMessage).not.toContain(
      `data-testid="cohort-push-result-${COHORT_2027.id}"`,
    );
  });
});

// ── Manager markup ──────────────────────────────────────────────────────

describe("CohortsManager", () => {
  function renderManager(cohorts: AdmissionsCohortDto[] = [COHORT_2027, COHORT_2028]) {
    return renderToStaticMarkup(
      <CohortsManager cohorts={cohorts} onEditTemplate={() => undefined} />,
    );
  }

  it("renders the cohort table with names, years, and per-row actions", () => {
    const html = renderManager();
    expect(html).toContain('data-testid="cohorts-manager"');
    expect(html).toContain(`data-testid="cohort-row-${COHORT_2027.id}"`);
    expect(html).toContain(`data-testid="cohort-row-${COHORT_2028.id}"`);
    expect(html).toContain("Class of 2027");
    expect(html).toContain(">2028<");
    expect(html).toContain(`data-testid="cohort-edit-template-${COHORT_2027.id}"`);
    expect(html).toContain(`data-testid="cohort-push-${COHORT_2028.id}"`);
  });

  it("offers the 2024–2040 year choices and disables submit on the empty form", () => {
    const html = renderManager();
    expect(html).toContain('data-testid="cohort-add-form"');
    expect(html).toContain('value="2024"');
    expect(html).toContain('value="2040"');
    expect(html).not.toContain('value="2041"');
    const submit = html.match(/<button[^>]*data-testid="cohort-submit"[^>]*>/);
    expect(submit).not.toBeNull();
    expect(submit![0]).toContain("disabled");
  });

  it("keeps the push-confirmation dialog closed until requested", () => {
    const html = renderManager();
    expect(html).toContain(`data-testid="cohort-push-${COHORT_2027.id}"`);
    expect(html).not.toContain('data-testid="cohort-push-dialog"');
    expect(html).not.toContain('data-testid="cohort-push-confirm"');
  });

  it("shows the empty state when no cohorts exist", () => {
    const html = renderManager([]);
    expect(html).toContain("No cohorts yet. Add the first one above.");
    expect(html).not.toContain('data-testid="cohorts-table"');
  });
});
