import { isValidElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })),
}));

import {
  CounselorRow,
  CounselorsManager,
  EMPTY_COUNSELOR_FORM,
  buildCounselorPayload,
  requestCounselorCreate,
  requestCounselorDeactivate,
  requestCounselorReactivate,
  requestCounselorRename,
} from "../counselors-manager";
import type { CounselorRowProps } from "../counselors-manager";
import type { AdmissionsCounselorDto } from "@/lib/admissions/types";

// ── Fixtures ────────────────────────────────────────────────────────────

const ACTIVE_COUNSELOR: AdmissionsCounselorDto = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  email: "amy@example.com",
  name: "Amy Counselor",
  active: true,
  createdAt: "2026-07-01T03:00:00.000Z",
  updatedAt: "2026-07-01T03:00:00.000Z",
};

const INACTIVE_COUNSELOR: AdmissionsCounselorDto = {
  id: "22222222-bbbb-4bbb-8bbb-222222222222",
  email: "ben@example.com",
  name: "Ben Former",
  active: false,
  createdAt: "2026-07-02T03:00:00.000Z",
  updatedAt: "2026-07-02T03:00:00.000Z",
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
 * hook-free CounselorRow is invoked directly, so its host/Button elements
 * (and their onClick/onSubmit props) sit in the returned element tree.
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

function makeRowProps(overrides: Partial<CounselorRowProps> = {}): CounselorRowProps {
  return {
    counselor: ACTIVE_COUNSELOR,
    busy: false,
    editing: false,
    editName: "",
    onEditNameChange: vi.fn(),
    onStartEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onRequestDeactivate: vi.fn(),
    onReactivate: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Pure helpers ────────────────────────────────────────────────────────

describe("buildCounselorPayload", () => {
  it("rejects malformed emails (mirrors the route's z.string().email())", () => {
    for (const email of ["", "not-an-email", "a@b", "two words@example.com"]) {
      const result = buildCounselorPayload({ email, name: "Amy" });
      expect(result.ok).toBe(false);
    }
    expect(EMPTY_COUNSELOR_FORM).toEqual({ email: "", name: "" });
  });

  it("rejects a blank name", () => {
    const result = buildCounselorPayload({ email: "amy@example.com", name: "   " });
    expect(result).toEqual({ ok: false, error: "Counselor name is required." });
  });

  it("lowercases and trims the email and trims the name", () => {
    const result = buildCounselorPayload({
      email: "  Amy@Example.COM ",
      name: "  Amy Counselor ",
    });
    expect(result).toEqual({
      ok: true,
      body: { email: "amy@example.com", name: "Amy Counselor" },
    });
  });
});

// ── Add flow ────────────────────────────────────────────────────────────

describe("requestCounselorCreate", () => {
  it("POSTs the normalized body with active: true and reports success", async () => {
    const fetchMock = stubFetch({ payload: { counselor: ACTIVE_COUNSELOR } });
    const result = await requestCounselorCreate({
      email: " Amy@Example.com ",
      name: " Amy Counselor ",
    });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admissions/counselors");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(requestBodyOf(fetchMock)).toEqual({
      email: "amy@example.com",
      name: "Amy Counselor",
      active: true,
    });
  });

  it("never reaches the wire for an invalid form", async () => {
    const fetchMock = stubFetch();
    const result = await requestCounselorCreate({ email: "nope", name: "Amy" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the response JSON error field on failure", async () => {
    stubFetch({ ok: false, status: 403, payload: { error: "Forbidden" } });
    const result = await requestCounselorCreate({ email: "amy@example.com", name: "Amy" });
    expect(result).toEqual({ ok: false, error: "Forbidden" });
  });

  it("falls back to a generic message when the error payload is not a string", async () => {
    stubFetch({ ok: false, status: 400, payload: { error: { fieldErrors: {} } } });
    const result = await requestCounselorCreate({ email: "amy@example.com", name: "Amy" });
    expect(result).toEqual({ ok: false, error: "Failed to add the counselor." });
  });

  it("reports network failures as inline errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const result = await requestCounselorCreate({ email: "amy@example.com", name: "Amy" });
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});

// ── Rename / deactivate / reactivate flows ──────────────────────────────

describe("requestCounselorRename", () => {
  it("PATCHes the trimmed name while preserving the current active flag", async () => {
    const fetchMock = stubFetch({ payload: { counselor: INACTIVE_COUNSELOR } });
    const result = await requestCounselorRename(INACTIVE_COUNSELOR, "  Ben Renamed ");
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("PATCH");
    expect(requestBodyOf(fetchMock)).toEqual({
      email: "ben@example.com",
      name: "Ben Renamed",
      active: false,
    });
  });

  it("rejects a blank name without calling fetch", async () => {
    const fetchMock = stubFetch();
    const result = await requestCounselorRename(ACTIVE_COUNSELOR, "   ");
    expect(result).toEqual({ ok: false, error: "Counselor name is required." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("requestCounselorDeactivate", () => {
  it("PATCHes the pure deactivation body { email, active: false }", async () => {
    const fetchMock = stubFetch({ payload: { counselor: INACTIVE_COUNSELOR } });
    const result = await requestCounselorDeactivate("amy@example.com");
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("PATCH");
    expect(requestBodyOf(fetchMock)).toEqual({ email: "amy@example.com", active: false });
  });

  it("surfaces a 404 error payload for an unknown email", async () => {
    stubFetch({ ok: false, status: 404, payload: { error: "Not found" } });
    const result = await requestCounselorDeactivate("ghost@example.com");
    expect(result).toEqual({ ok: false, error: "Not found" });
  });
});

describe("requestCounselorReactivate", () => {
  it("PATCHes the upsert body { email, name, active: true }", async () => {
    const fetchMock = stubFetch({ payload: { counselor: ACTIVE_COUNSELOR } });
    const result = await requestCounselorReactivate(INACTIVE_COUNSELOR);
    expect(result).toEqual({ ok: true });
    expect(requestBodyOf(fetchMock)).toEqual({
      email: "ben@example.com",
      name: "Ben Former",
      active: true,
    });
  });
});

// ── Row action wiring (element-tree traversal, no DOM) ──────────────────

describe("CounselorRow wiring", () => {
  it("fires onStartEdit with the counselor from the edit button", () => {
    const onStartEdit = vi.fn();
    const row = CounselorRow(makeRowProps({ onStartEdit }));
    const button = findByTestId(row, `counselor-edit-${ACTIVE_COUNSELOR.id}`);
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(onStartEdit).toHaveBeenCalledWith(ACTIVE_COUNSELOR);
  });

  it("routes Deactivate through onRequestDeactivate (confirm dialog, never direct)", () => {
    const onRequestDeactivate = vi.fn();
    const row = CounselorRow(makeRowProps({ onRequestDeactivate }));
    const button = findByTestId(row, `counselor-deactivate-${ACTIVE_COUNSELOR.id}`);
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(onRequestDeactivate).toHaveBeenCalledWith(ACTIVE_COUNSELOR);
    // An active row offers Deactivate only — never Reactivate.
    expect(findByTestId(row, `counselor-reactivate-${ACTIVE_COUNSELOR.id}`)).toBeNull();
  });

  it("offers Reactivate (not Deactivate) on an inactive row", () => {
    const onReactivate = vi.fn();
    const row = CounselorRow(
      makeRowProps({ counselor: INACTIVE_COUNSELOR, onReactivate }),
    );
    const button = findByTestId(row, `counselor-reactivate-${INACTIVE_COUNSELOR.id}`);
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(onReactivate).toHaveBeenCalledWith(INACTIVE_COUNSELOR);
    expect(findByTestId(row, `counselor-deactivate-${INACTIVE_COUNSELOR.id}`)).toBeNull();
  });

  it("submits the inline rename form via onSaveEdit with preventDefault", () => {
    const onSaveEdit = vi.fn();
    const row = CounselorRow(
      makeRowProps({ editing: true, editName: "Amy Renamed", onSaveEdit }),
    );
    const form = findByTestId(row, `counselor-edit-form-${ACTIVE_COUNSELOR.id}`);
    expect(form).not.toBeNull();
    const preventDefault = vi.fn();
    (form!.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(onSaveEdit).toHaveBeenCalledWith(ACTIVE_COUNSELOR);
  });

  it("disables Save while the draft name is blank or the row is busy", () => {
    const blank = CounselorRow(makeRowProps({ editing: true, editName: "  " }));
    const blankSave = findByTestId(blank, `counselor-save-${ACTIVE_COUNSELOR.id}`);
    expect(blankSave!.props.disabled).toBe(true);

    const busy = CounselorRow(
      makeRowProps({ editing: true, editName: "Amy", busy: true }),
    );
    const busySave = findByTestId(busy, `counselor-save-${ACTIVE_COUNSELOR.id}`);
    expect(busySave!.props.disabled).toBe(true);

    const ready = CounselorRow(makeRowProps({ editing: true, editName: "Amy" }));
    const readySave = findByTestId(ready, `counselor-save-${ACTIVE_COUNSELOR.id}`);
    expect(readySave!.props.disabled).toBe(false);
  });
});

// ── Manager markup ──────────────────────────────────────────────────────

describe("CounselorsManager", () => {
  function renderManager(counselors: AdmissionsCounselorDto[] = [ACTIVE_COUNSELOR, INACTIVE_COUNSELOR]) {
    return renderToStaticMarkup(<CounselorsManager counselors={counselors} />);
  }

  it("renders the registry table with names, emails, and status badges", () => {
    const html = renderManager();
    expect(html).toContain('data-testid="counselors-manager"');
    expect(html).toContain(`data-testid="counselor-row-${ACTIVE_COUNSELOR.id}"`);
    expect(html).toContain(`data-testid="counselor-row-${INACTIVE_COUNSELOR.id}"`);
    expect(html).toContain("Amy Counselor");
    expect(html).toContain("amy@example.com");
    expect(html).toContain(">Active<");
    expect(html).toContain(">Inactive<");
  });

  it("disables the add submit until the form validates (empty form)", () => {
    const html = renderManager();
    expect(html).toContain('data-testid="counselor-add-form"');
    const submit = html.match(/<button[^>]*data-testid="counselor-submit"[^>]*>/);
    expect(submit).not.toBeNull();
    expect(submit![0]).toContain("disabled");
  });

  it("keeps the deactivate-confirmation dialog closed until requested", () => {
    const html = renderManager();
    expect(html).toContain(`data-testid="counselor-deactivate-${ACTIVE_COUNSELOR.id}"`);
    expect(html).not.toContain('data-testid="counselor-deactivate-dialog"');
    expect(html).not.toContain('data-testid="counselor-deactivate-confirm"');
  });

  it("shows the empty state when the registry has no rows", () => {
    const html = renderManager([]);
    expect(html).toContain("No counselors yet. Add the first one above.");
    expect(html).not.toContain('data-testid="counselors-table"');
  });
});
