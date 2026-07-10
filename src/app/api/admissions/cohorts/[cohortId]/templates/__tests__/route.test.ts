import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the real requireAdmissionsSession guard can run.
// The Postgres-resolved staff/admin guards (design §2.2) are mocked so their
// per-test outcome models the registry/admin_users state.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/access")>();
  return {
    ...actual,
    requireAdmissionsAdmin: vi.fn(),
    requireCounselorOrAdmin: vi.fn(),
  };
});
// Stub only the db-backed template operations; everything else (schemas,
// pure helpers) stays real.
vi.mock("@/lib/admissions/checklists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/checklists")>()),
  createTemplateVersion: vi.fn(),
  getLatestTemplate: vi.fn(),
  listTemplateVersions: vi.fn(),
  publishTemplate: vi.fn(),
  pushNewItemsToCohortCases: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireAdmissionsAdmin, requireCounselorOrAdmin } from "@/lib/admissions/access";
import {
  createTemplateVersion,
  getLatestTemplate,
  listTemplateVersions,
  publishTemplate,
  pushNewItemsToCohortCases,
} from "@/lib/admissions/checklists";
import { GET, PATCH, POST } from "../route";
import type {
  AdmissionsTemplateDto,
  AdmissionsTemplateVersionDto,
} from "@/lib/admissions/checklists";

const authMock = auth as unknown as Mock;

const ADMIN_STAFF = { email: "admin@example.com", role: "admin" as const, isAdmin: true };
const COUNSELOR_STAFF = {
  email: "counselor@example.com",
  role: "counselor" as const,
  isAdmin: false,
};

const COHORT_ID = "44444444-4444-4444-8444-444444444444";
const TEMPLATE_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_TEMPLATE_ID = "99999999-9999-4999-8999-999999999999";

const ADMIN_SESSION = {
  user: { email: "admin@example.com", name: "Admin", allowedPages: null },
};
const COUNSELOR_SESSION = {
  user: {
    email: "counselor@example.com",
    name: "Counselor",
    allowedPages: ["/admissions"],
    role: "counselor",
  },
};
const STUDENT_SESSION = {
  user: {
    email: "student@example.com",
    name: "Student",
    allowedPages: ["/admissions"],
    role: "student",
  },
};

const TEMPLATE_DTO: AdmissionsTemplateDto = {
  id: TEMPLATE_ID,
  cohortId: COHORT_ID,
  version: 2,
  name: "Checklist v2",
  publishedAt: null,
  items: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      templateId: TEMPLATE_ID,
      itemKey: "draft_activities_list",
      phase: "activities",
      title: "Draft the activities list",
      description: null,
      defaultOwner: "student",
      sortOrder: 0,
    },
  ],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const VERSION_DTO: AdmissionsTemplateVersionDto = {
  id: TEMPLATE_ID,
  cohortId: COHORT_ID,
  version: 2,
  name: "Checklist v2",
  publishedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const PUSH_RESULT = {
  templateId: TEMPLATE_ID,
  templateVersion: 2,
  casesUpdated: 3,
  tasksCreated: 6,
};

const CREATE_VERSION_BODY = {
  action: "create_version",
  items: [
    {
      itemKey: "draft_activities_list",
      phase: "activities",
      title: "Draft the activities list",
      description: null,
      defaultOwner: "student",
      sortOrder: 0,
    },
  ],
};

function makeCtx(cohortId: string = COHORT_ID) {
  return { params: Promise.resolve({ cohortId }) };
}

function makeRequest(method: "POST" | "PATCH", body?: unknown) {
  return new NextRequest(`http://test.local/api/admissions/cohorts/${COHORT_ID}/templates`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /api/admissions/cohorts/[cohortId]/templates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(ADMIN_STAFF);
    vi.mocked(getLatestTemplate).mockResolvedValue(TEMPLATE_DTO);
    vi.mocked(listTemplateVersions).mockResolvedValue([VERSION_DTO]);
  });

  it("returns the latest template + version history for an admin", async () => {
    const res = await GET(new Request("http://test.local"), makeCtx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      latest: TEMPLATE_DTO,
      versions: [VERSION_DTO],
    });
    expect(getLatestTemplate).toHaveBeenCalledWith(COHORT_ID);
    expect(listTemplateVersions).toHaveBeenCalledWith(COHORT_ID);
  });

  it("returns the template payload for a counselor (read-only visibility)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockResolvedValue(COUNSELOR_STAFF);

    const res = await GET(new Request("http://test.local"), makeCtx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      latest: TEMPLATE_DTO,
      versions: [VERSION_DTO],
    });
  });

  it("returns a null latest for a cohort with no templates", async () => {
    vi.mocked(getLatestTemplate).mockResolvedValue(null);
    vi.mocked(listTemplateVersions).mockResolvedValue([]);

    const res = await GET(new Request("http://test.local"), makeCtx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ latest: null, versions: [] });
  });

  it("returns 403 for a student session (counselor+ only)", async () => {
    authMock.mockResolvedValue(STUDENT_SESSION);
    vi.mocked(requireCounselorOrAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await GET(new Request("http://test.local"), makeCtx());

    expect(res.status).toBe(403);
    expect(getLatestTemplate).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(new Request("http://test.local"), makeCtx());

    expect(res.status).toBe(401);
    expect(getLatestTemplate).not.toHaveBeenCalled();
  });

  it("returns 500 JSON when the template read throws", async () => {
    vi.mocked(getLatestTemplate).mockRejectedValue(new Error("DB exploded"));

    const res = await GET(new Request("http://test.local"), makeCtx());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB exploded" });
  });
});

describe("POST /api/admissions/cohorts/[cohortId]/templates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockResolvedValue(ADMIN_STAFF);
    vi.mocked(createTemplateVersion).mockResolvedValue(TEMPLATE_DTO);
    vi.mocked(pushNewItemsToCohortCases).mockResolvedValue(PUSH_RESULT);
  });

  it("creates a new template version with the admin actor", async () => {
    const res = await POST(
      makeRequest("POST", { ...CREATE_VERSION_BODY, name: "Fall refresh", publish: true }),
      makeCtx(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ template: TEMPLATE_DTO });
    expect(createTemplateVersion).toHaveBeenCalledWith(
      COHORT_ID,
      [
        {
          itemKey: "draft_activities_list",
          phase: "activities",
          title: "Draft the activities list",
          description: null,
          defaultOwner: "student",
          sortOrder: 0,
        },
      ],
      { email: "admin@example.com", role: "admin" },
      { name: "Fall refresh", publish: true },
    );
    expect(pushNewItemsToCohortCases).not.toHaveBeenCalled();
  });

  it("defaults omitted name/publish to undefined (lib defaults apply)", async () => {
    const res = await POST(makeRequest("POST", CREATE_VERSION_BODY), makeCtx());

    expect(res.status).toBe(200);
    expect(createTemplateVersion).toHaveBeenCalledWith(
      COHORT_ID,
      expect.any(Array),
      { email: "admin@example.com", role: "admin" },
      { name: undefined, publish: undefined },
    );
  });

  it("pushes new items to cohort cases via action=push_new_items", async () => {
    const res = await POST(makeRequest("POST", { action: "push_new_items" }), makeCtx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(PUSH_RESULT);
    expect(pushNewItemsToCohortCases).toHaveBeenCalledWith(COHORT_ID, {
      email: "admin@example.com",
      role: "admin",
    });
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });

  it("returns 404 for push_new_items when the cohort has no published template", async () => {
    vi.mocked(pushNewItemsToCohortCases).mockRejectedValue(new Error("NotFound"));

    const res = await POST(makeRequest("POST", { action: "push_new_items" }), makeCtx());

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 403 for a counselor session (admin-only template ops)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await POST(makeRequest("POST", CREATE_VERSION_BODY), makeCtx());

    expect(res.status).toBe(403);
    expect(createTemplateVersion).not.toHaveBeenCalled();
    expect(pushNewItemsToCohortCases).not.toHaveBeenCalled();
  });

  it("returns 403 for a removed admin despite an admin JWT (instant revocation)", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await POST(makeRequest("POST", CREATE_VERSION_BODY), makeCtx());

    expect(res.status).toBe(403);
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeRequest("POST", CREATE_VERSION_BODY), makeCtx());

    expect(res.status).toBe(401);
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing JSON body", async () => {
    const res = await POST(makeRequest("POST"), makeCtx());

    expect(res.status).toBe(400);
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown action", async () => {
    const res = await POST(makeRequest("POST", { action: "delete_version" }), makeCtx());

    expect(res.status).toBe(400);
    expect(createTemplateVersion).not.toHaveBeenCalled();
    expect(pushNewItemsToCohortCases).not.toHaveBeenCalled();
  });

  it("returns 400 for create_version with an empty items array", async () => {
    const res = await POST(
      makeRequest("POST", { action: "create_version", items: [] }),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-snake_case itemKey (fail-closed)", async () => {
    const res = await POST(
      makeRequest("POST", {
        action: "create_version",
        items: [{ ...CREATE_VERSION_BODY.items[0], itemKey: "Draft Activities" }],
      }),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-canonical phase (fail-closed, custom is task-only)", async () => {
    const res = await POST(
      makeRequest("POST", {
        action: "create_version",
        items: [{ ...CREATE_VERSION_BODY.items[0], phase: "custom" }],
      }),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    expect(createTemplateVersion).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admissions/cohorts/[cohortId]/templates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authMock.mockResolvedValue(ADMIN_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockResolvedValue(ADMIN_STAFF);
    vi.mocked(listTemplateVersions).mockResolvedValue([VERSION_DTO]);
    vi.mocked(publishTemplate).mockResolvedValue({
      ...TEMPLATE_DTO,
      publishedAt: "2026-07-02T00:00:00.000Z",
    });
  });

  it("publishes a draft version belonging to this cohort", async () => {
    const res = await PATCH(makeRequest("PATCH", { templateId: TEMPLATE_ID }), makeCtx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      template: { ...TEMPLATE_DTO, publishedAt: "2026-07-02T00:00:00.000Z" },
    });
    expect(listTemplateVersions).toHaveBeenCalledWith(COHORT_ID);
    expect(publishTemplate).toHaveBeenCalledWith(TEMPLATE_ID, {
      email: "admin@example.com",
      role: "admin",
    });
  });

  it("returns 404 when the templateId belongs to another cohort (fail-closed)", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { templateId: OTHER_TEMPLATE_ID }),
      makeCtx(),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(publishTemplate).not.toHaveBeenCalled();
  });

  it("returns 409 when the version is already published", async () => {
    vi.mocked(publishTemplate).mockRejectedValue(new Error("Conflict"));

    const res = await PATCH(makeRequest("PATCH", { templateId: TEMPLATE_ID }), makeCtx());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Conflict" });
  });

  it("returns 403 for a counselor session (admin-only template ops)", async () => {
    authMock.mockResolvedValue(COUNSELOR_SESSION);
    vi.mocked(requireAdmissionsAdmin).mockRejectedValue(new Error("Forbidden"));

    const res = await PATCH(makeRequest("PATCH", { templateId: TEMPLATE_ID }), makeCtx());

    expect(res.status).toBe(403);
    expect(publishTemplate).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValue(null);

    const res = await PATCH(makeRequest("PATCH", { templateId: TEMPLATE_ID }), makeCtx());

    expect(res.status).toBe(401);
    expect(publishTemplate).not.toHaveBeenCalled();
  });

  it("returns 400 when templateId is not a UUID", async () => {
    const res = await PATCH(makeRequest("PATCH", { templateId: "not-a-uuid" }), makeCtx());

    expect(res.status).toBe(400);
    expect(publishTemplate).not.toHaveBeenCalled();
  });
});
