// Parent leak-test matrix (design §2.3/§4, PRD §3 access policy, roadmap §8
// "Leak-test matrix green").
//
// For EVERY case-scoped admissions route file this suite drives a parent-role
// session into EVERY exported HTTP handler and pins the actual contract:
//
// - Parents get 403 on ALL mutating methods (POST/PATCH/PUT/DELETE) and on
//   every staff/student GET surface. Requests carry NO body, which doubles as
//   an ordering test — requireCaseAccess must run BEFORE body/query parsing
//   (design §4), so a guard-after-parse regression surfaces as a 400/500.
// - The ONLY parent-readable payload is GET /parent-dashboard (the closed
//   projection). GET /cases/[caseId] admits parents at the guard (minRole
//   "parent") but is role-shaped: parents are 403-redirected to the dashboard
//   and the staff DTO is never even built.
// - Design §4 lists /calendar GET as "student/parent (shaped)", but the
//   implementation is STRICTER: minRole "student" (parents read deadlines via
//   the dashboard's upcomingDeadlines). The matrix pins the actual contract.
//
// The guard stub enforces the real parent < student < counselor < admin
// ordering via roleAtLeast, and every test also asserts the exact minRole the
// route passed — so a route silently lowering its bar fails here. Two
// completeness checks make the matrix self-enforcing: every route.ts under
// cases/[caseId]/ must have a surface entry, and every exported HTTP method
// must be either denied or explicitly allowed.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both. The access module keeps the real
// requireAdmissionsSession + admissionsErrorResponse (driven via the auth
// mock) so session gating and Forbidden→403 mapping are exercised for real.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/access")>()),
  requireCaseAccess: vi.fn(),
}));
// Stub the two payload builders a parent could conceivably reach, so the
// matrix can assert the staff DTO is never built for a parent and the
// dashboard serves ONLY the projection.
vi.mock("@/lib/admissions/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admissions/cases")>()),
  getCaseDetail: vi.fn(),
}));
vi.mock("@/lib/admissions/parent-projection", () => ({
  buildParentDashboard: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import { getCaseDetail } from "@/lib/admissions/cases";
import { roleAtLeast } from "@/lib/admissions/config";
import { buildParentDashboard } from "@/lib/admissions/parent-projection";
import type { ParentDashboard } from "@/lib/admissions/parent-projection";
import type { CaseAccess, CaseRole } from "@/lib/admissions/types";

import * as caseDetailRoute from "@/app/api/admissions/cases/[caseId]/route";
import * as activitiesRoute from "@/app/api/admissions/cases/[caseId]/activities/route";
import * as calendarRoute from "@/app/api/admissions/cases/[caseId]/calendar/route";
import * as collegesRoute from "@/app/api/admissions/cases/[caseId]/colleges/route";
import * as collegeEventsRoute from "@/app/api/admissions/cases/[caseId]/colleges/[itemId]/events/route";
import * as essaysRoute from "@/app/api/admissions/cases/[caseId]/essays/route";
import * as meetingsRoute from "@/app/api/admissions/cases/[caseId]/meetings/route";
import * as membersRoute from "@/app/api/admissions/cases/[caseId]/members/route";
import * as notesRoute from "@/app/api/admissions/cases/[caseId]/notes/route";
import * as parentDashboardRoute from "@/app/api/admissions/cases/[caseId]/parent-dashboard/route";
import * as recommendersRoute from "@/app/api/admissions/cases/[caseId]/recommenders/route";
import * as sectionsRoute from "@/app/api/admissions/cases/[caseId]/sections/[sectionKey]/route";
import * as tasksRoute from "@/app/api/admissions/cases/[caseId]/tasks/route";
import * as testingRoute from "@/app/api/admissions/cases/[caseId]/testing/route";

const authMock = auth as unknown as Mock;

const PARENT_EMAIL = "parent@example.com";
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_KEY = "about_you";

const DASHBOARD: ParentDashboard = {
  studentName: "Nong Prae",
  cohortName: "Class of 2027",
  caseStatus: "active",
  progress: { done: 2, total: 8, percent: 25 },
  phaseProgress: [],
  collegeList: [],
  upcomingDeadlines: [],
  announcements: [],
  testingMilestones: [],
  sharedNotes: [],
};

// ── Matrix plumbing ─────────────────────────────────────────────────────

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * A superset params object satisfies every case-scoped route's context shape
 * ({caseId} / {caseId,itemId} / {caseId,sectionKey}) structurally.
 */
type MatrixContext = {
  params: Promise<{ caseId: string; itemId: string; sectionKey: string }>;
};

type RouteHandler = (
  request: NextRequest,
  ctx: MatrixContext,
) => Promise<Response>;

interface DeniedMethod {
  method: HttpMethod;
  /** The exact minRole the handler must pass to requireCaseAccess. */
  minRole: CaseRole;
}

interface SurfaceContract {
  /** route.ts path relative to src/app/api/admissions/cases/[caseId]/. */
  file: string;
  module: Record<string, unknown>;
  /** URL path segment(s) after /cases/[caseId] ("" for the detail route). */
  urlSuffix: string;
  /** Methods a parent must NOT reach past the guard. */
  denied: DeniedMethod[];
  /** Methods with parent-permitted (role-shaped) handling — dedicated tests below. */
  allowed: HttpMethod[];
}

const SURFACES: SurfaceContract[] = [
  {
    file: "route.ts",
    module: caseDetailRoute,
    urlSuffix: "",
    denied: [{ method: "PATCH", minRole: "counselor" }],
    allowed: ["GET"], // minRole "parent", but role-shaped: parents 403 → dashboard
  },
  {
    file: "activities/route.ts",
    module: activitiesRoute,
    urlSuffix: "/activities",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "student" },
      { method: "PATCH", minRole: "student" },
      { method: "DELETE", minRole: "student" },
    ],
    allowed: [],
  },
  {
    // Design §4 says "student/parent (shaped)"; implementation is stricter
    // (parents use the dashboard's upcomingDeadlines) — pin the actual bar.
    file: "calendar/route.ts",
    module: calendarRoute,
    urlSuffix: "/calendar",
    denied: [{ method: "GET", minRole: "student" }],
    allowed: [],
  },
  {
    file: "colleges/route.ts",
    module: collegesRoute,
    urlSuffix: "/colleges",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "counselor" },
      { method: "PATCH", minRole: "counselor" },
      { method: "DELETE", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "colleges/[itemId]/events/route.ts",
    module: collegeEventsRoute,
    urlSuffix: `/colleges/${ITEM_ID}/events`,
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "essays/route.ts",
    module: essaysRoute,
    urlSuffix: "/essays",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "student" },
      { method: "PATCH", minRole: "student" },
      { method: "DELETE", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "meetings/route.ts",
    module: meetingsRoute,
    urlSuffix: "/meetings",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "counselor" },
      { method: "PATCH", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "members/route.ts",
    module: membersRoute,
    urlSuffix: "/members",
    denied: [
      { method: "GET", minRole: "counselor" },
      { method: "POST", minRole: "counselor" },
      { method: "PATCH", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "notes/route.ts",
    module: notesRoute,
    urlSuffix: "/notes",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "counselor" },
      { method: "PATCH", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "parent-dashboard/route.ts",
    module: parentDashboardRoute,
    urlSuffix: "/parent-dashboard",
    denied: [],
    allowed: ["GET"], // the ONE parent-readable payload (closed projection)
  },
  {
    file: "recommenders/route.ts",
    module: recommendersRoute,
    urlSuffix: "/recommenders",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "counselor" },
      { method: "PATCH", minRole: "counselor" },
      { method: "DELETE", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "sections/[sectionKey]/route.ts",
    module: sectionsRoute,
    urlSuffix: `/sections/${SECTION_KEY}`,
    denied: [
      { method: "GET", minRole: "student" },
      { method: "PUT", minRole: "student" },
      { method: "POST", minRole: "student" },
    ],
    allowed: [],
  },
  {
    file: "tasks/route.ts",
    module: tasksRoute,
    urlSuffix: "/tasks",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "counselor" },
      { method: "PATCH", minRole: "student" },
      { method: "DELETE", minRole: "counselor" },
    ],
    allowed: [],
  },
  {
    file: "testing/route.ts",
    module: testingRoute,
    urlSuffix: "/testing",
    denied: [
      { method: "GET", minRole: "student" },
      { method: "POST", minRole: "student" },
      { method: "PATCH", minRole: "student" },
      { method: "DELETE", minRole: "student" },
    ],
    allowed: [],
  },
];

function getHandler(surface: SurfaceContract, method: HttpMethod): RouteHandler {
  const handler = surface.module[method];
  if (typeof handler !== "function") {
    throw new Error(`${surface.file} does not export a ${method} handler`);
  }
  return handler as RouteHandler;
}

function makeCtx(): MatrixContext {
  return {
    params: Promise.resolve({
      caseId: CASE_ID,
      itemId: ITEM_ID,
      sectionKey: SECTION_KEY,
    }),
  };
}

/** Bodiless on purpose: guard-before-parse ordering is part of the contract. */
function makeRequest(surface: SurfaceContract, method: HttpMethod): NextRequest {
  return new NextRequest(
    `http://test.local/api/admissions/cases/${CASE_ID}${surface.urlSuffix}`,
    { method },
  );
}

function signInAsParent() {
  authMock.mockResolvedValue({
    user: {
      email: PARENT_EMAIL,
      name: "Test Parent",
      allowedPages: ["/admissions"],
      role: "parent",
    },
  });
}

/**
 * Guard stub with the REAL role ordering: a parent membership resolves only
 * when the route asks for minRole "parent"; any higher bar throws Forbidden —
 * so a route passing a looser minRole than the matrix expects both slips past
 * the 403 assertion AND trips the explicit minRole-argument assertion.
 */
function armParentGuard() {
  vi.mocked(requireCaseAccess).mockImplementation(
    async (email: string, caseId: string, minRole: CaseRole): Promise<CaseAccess> => {
      if (!roleAtLeast("parent", minRole)) throw new Error("Forbidden");
      return { caseId, email, role: "parent", isAdmin: false };
    },
  );
}

// ── Completeness: the matrix must cover every file and every method ─────

const CASE_SCOPED_DIR = fileURLToPath(
  new URL("../cases/[caseId]", import.meta.url),
);

function listRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...listRouteFiles(path.join(dir, entry.name)));
    } else if (entry.name === "route.ts") {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

describe("parent access matrix — completeness", () => {
  it("has a surface entry for EVERY case-scoped route file", () => {
    const onDisk = listRouteFiles(CASE_SCOPED_DIR)
      .map((file) => path.relative(CASE_SCOPED_DIR, file))
      .sort();
    const covered = SURFACES.map((surface) => surface.file).sort();

    expect(covered).toEqual(onDisk);
  });

  for (const surface of SURFACES) {
    it(`covers every exported HTTP method of ${surface.file}`, () => {
      const exported = HTTP_METHODS.filter(
        (method) => typeof surface.module[method] === "function",
      ).sort();
      const covered = [
        ...surface.denied.map((entry) => entry.method),
        ...surface.allowed,
      ].sort();

      expect(covered).toEqual(exported);
    });
  }
});

// ── The matrix: parent → 403 everywhere except the projection ───────────

describe("parent access matrix — denied surfaces", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAsParent();
    armParentGuard();
  });

  for (const surface of SURFACES) {
    for (const entry of surface.denied) {
      it(`${entry.method} /cases/[caseId]${surface.urlSuffix || ""} → 403 for a parent (guard minRole "${entry.minRole}")`, async () => {
        const handler = getHandler(surface, entry.method);

        const res = await handler(makeRequest(surface, entry.method), makeCtx());

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
        expect(requireCaseAccess).toHaveBeenCalledTimes(1);
        expect(requireCaseAccess).toHaveBeenCalledWith(
          PARENT_EMAIL,
          CASE_ID,
          entry.minRole,
        );
        // No payload builder ever runs on a denied surface.
        expect(getCaseDetail).not.toHaveBeenCalled();
        expect(buildParentDashboard).not.toHaveBeenCalled();
      });
    }
  }
});

describe("parent access matrix — role-shaped and allowed surfaces", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signInAsParent();
    armParentGuard();
    vi.mocked(buildParentDashboard).mockResolvedValue(DASHBOARD);
  });

  it('GET /cases/[caseId] admits parents at the guard but 403-redirects to the dashboard (staff DTO never built)', async () => {
    const surface = SURFACES[0];
    const handler = getHandler(surface, "GET");

    const res = await handler(makeRequest(surface, "GET"), makeCtx());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Use parent dashboard" });
    expect(requireCaseAccess).toHaveBeenCalledWith(PARENT_EMAIL, CASE_ID, "parent");
    expect(getCaseDetail).not.toHaveBeenCalled();
  });

  it("GET /cases/[caseId]/parent-dashboard is the ONE parent-readable payload — the closed projection only", async () => {
    const surface = SURFACES.find((s) => s.file === "parent-dashboard/route.ts");
    if (!surface) throw new Error("parent-dashboard surface missing");
    const handler = getHandler(surface, "GET");

    const res = await handler(makeRequest(surface, "GET"), makeCtx());

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ dashboard: DASHBOARD });
    expect(Object.keys(body as Record<string, unknown>)).toEqual(["dashboard"]);
    expect(requireCaseAccess).toHaveBeenCalledWith(PARENT_EMAIL, CASE_ID, "parent");
    expect(buildParentDashboard).toHaveBeenCalledWith(CASE_ID);
    expect(getCaseDetail).not.toHaveBeenCalled();
  });
});
