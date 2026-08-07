import { describe, it, expect, vi, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth-edge", () => ({
  edgeAuth: <T>(handler: T) => handler,
}));

import middleware from "@/middleware";

function makeReq(pathname: string, isAuth = false, search = "", allowedPages?: string[] | null) {
  const prefixedSearch = search ? `?${search}` : "";
  return {
    nextUrl: { pathname, search: prefixedSearch, searchParams: new URLSearchParams(search) },
    url: `http://localhost${pathname}${prefixedSearch}`,
    auth: isAuth ? { user: { email: "kevhsh7@gmail.com", allowedPages } } : null,
  };
}

describe("middleware — TCOV-06 part 2 (bypass paths)", () => {
  it("/login bypasses auth", async () => {
    const res = await middleware(makeReq("/login") as never, {} as never) as Response;

    expect(res).toBeInstanceOf(NextResponse);
    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/auth/callback/google bypasses auth", async () => {
    const res = await middleware(makeReq("/api/auth/callback/google") as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/internal/sync-wise bypasses middleware auth", async () => {
    const res = await middleware(makeReq("/api/internal/sync-wise") as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/search/assistant bypasses middleware so the route can return API auth errors", async () => {
    const res = await middleware(makeReq("/api/search/assistant") as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/line/webhook bypasses middleware so LINE can post signed webhook events", async () => {
    const res = await middleware(makeReq("/api/line/webhook") as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/line/contacts/oa-resolver/worklist bypasses middleware so extension token auth can run", async () => {
    const res = await middleware(
      makeReq("/api/line/contacts/oa-resolver/worklist") as never,
      {} as never,
    ) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/line/contacts/oa-resolver/runs/:runId/rows bypasses middleware so extension token auth can run", async () => {
    const res = await middleware(
      makeReq("/api/line/contacts/oa-resolver/runs/11111111-1111-1111-1111-111111111111/rows") as never,
      {} as never,
    ) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/line/contacts/oa-resolver/runs still requires app auth", async () => {
    const res = await middleware(
      makeReq("/api/line/contacts/oa-resolver/runs", false) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("/api/line/contacts/oa-resolver/runs/:runId/commit still requires app auth", async () => {
    const res = await middleware(
      makeReq("/api/line/contacts/oa-resolver/runs/11111111-1111-1111-1111-111111111111/commit", false) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("non-public route /search redirects to /login when unauthenticated, with callbackUrl preserved", async () => {
    const res = await middleware(makeReq("/search", false) as never, {} as never) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain("callbackUrl=%2Fsearch");
  });

  it("redirects unauthenticated learning-plan reports to login with callbackUrl preserved", async () => {
    const res = await middleware(
      makeReq("/learning-plans/report", false) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain(
      "callbackUrl=%2Flearning-plans%2Freport",
    );
  });

  it("preserves query string in callbackUrl when redirecting to login", async () => {
    const res = await middleware(makeReq("/search", false, "tutors=g1,g2") as never, {} as never) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "callbackUrl=%2Fsearch%3Ftutors%3Dg1%2Cg2",
    );
  });

  it("non-public route /search passes through when authenticated", async () => {
    const res = await middleware(makeReq("/search", true) as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["/learning-plans", "/learning-plans/report"])(
    "%s passes through for full-access admins",
    async (pathname) => {
      const res = await middleware(
        makeReq(pathname, true, "", null) as never,
        {} as never,
      ) as Response;

      expect(res.headers.get("location")).toBeNull();
    },
  );

  it.each(["/learning-plans", "/learning-plans/report"])(
    "%s passes through for restricted admins with the matching prefix",
    async (pathname) => {
      const res = await middleware(
        makeReq(pathname, true, "", ["/learning-plans"]) as never,
        {} as never,
      ) as Response;

      expect(res.headers.get("location")).toBeNull();
    },
  );

  it.each(["/learning-plans", "/learning-plans/report"])(
    "coarse-passes authenticated restricted users at %s so the fresh page guard can decide",
    async (pathname) => {
      const res = await middleware(
        makeReq(pathname, true, "", ["/progress-tests"]) as never,
        {} as never,
      ) as Response;

      expect(res.headers.get("location")).toBeNull();
    },
  );

  it("does not coarse-pass a similarly prefixed page", async () => {
    const res = await middleware(
      makeReq("/learning-plans-extra", true, "", ["/progress-tests"]) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/progress-tests");
  });

  it.each(["/api/learning-plans", "/api/learning-plans/report"])(
    "does not map the Learning Plans page exception onto API namespace %s",
    async (pathname) => {
      const res = await middleware(
        makeReq(pathname, true, "", ["/learning-plans"]) as never,
        {} as never,
      ) as Response;

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    },
  );

  it("root / redirects to login when unauthenticated", async () => {
    const res = await middleware(makeReq("/", false) as never, {} as never) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain("callbackUrl=%2F");
  });

  it("root / passes through for full-access admins", async () => {
    const res = await middleware(makeReq("/", true, "", null) as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("root / redirects single-page restricted users to their landing page", async () => {
    const res = await middleware(
      makeReq("/", true, "", ["/progress-tests"]) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/progress-tests");
  });

  it("root / passes through for multi-page restricted users", async () => {
    const res = await middleware(
      makeReq("/", true, "", ["/progress-tests", "/student-promotions"]) as never,
      {} as never,
    ) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/home/summary passes through for authenticated restricted users", async () => {
    const res = await middleware(
      makeReq("/api/home/summary", true, "", ["/progress-tests"]) as never,
      {} as never,
    ) as Response;

    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — admissions page + API gating", () => {
  it("/admissions passes through for /admissions-restricted users", async () => {
    const res = await middleware(
      makeReq("/admissions", true, "", ["/admissions"]) as never,
      {} as never,
    ) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("/api/admissions/* passes through for /admissions-restricted users", async () => {
    const res = await middleware(
      makeReq("/api/admissions/cases", true, "", ["/admissions"]) as never,
      {} as never,
    ) as Response;

    expect(res.headers.get("location")).toBeNull();
  });

  it("root / redirects single-page admissions users to /admissions", async () => {
    const res = await middleware(
      makeReq("/", true, "", ["/admissions"]) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/admissions");
  });

  it("admissions-restricted users get 403 JSON on other API namespaces", async () => {
    const res = await middleware(
      makeReq("/api/payroll", true, "", ["/admissions"]) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("admissions-restricted users are redirected off other pages to their landing page", async () => {
    const res = await middleware(
      makeReq("/search", true, "", ["/admissions"]) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/admissions");
  });

  it("unauthenticated /api/admissions/* requires app auth like every other API path", async () => {
    const res = await middleware(
      makeReq("/api/admissions/cases", false) as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});

// ── MAINT-04: maintenance gate ─────────────────────────────────────────────

/** Like makeReq, but lets a test choose the signed-in email (bypass tests). */
function makeMaintReq(pathname: string, email: string | null = null) {
  return {
    nextUrl: { pathname, search: "", searchParams: new URLSearchParams() },
    url: `http://localhost${pathname}`,
    auth: email ? { user: { email, allowedPages: null } } : null,
  };
}

afterEach(() => {
  delete process.env.MAINTENANCE_MODE;
  delete process.env.MAINTENANCE_BYPASS_EMAILS;
});

describe("middleware — maintenance mode OFF (default)", () => {
  it("leaves /search on its normal unauthenticated login redirect", async () => {
    const res = await middleware(makeMaintReq("/search") as never, {} as never) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("still lets LINE post to /api/line/webhook", async () => {
    const res = await middleware(makeMaintReq("/api/line/webhook") as never, {} as never) as Response;

    expect(res.status).not.toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["", "false", "TRUE", "1", "ture"])(
    "treats MAINTENANCE_MODE=%j as off — the flag fails open",
    async (value) => {
      process.env.MAINTENANCE_MODE = value;

      const res = await middleware(makeMaintReq("/api/line/webhook") as never, {} as never) as Response;

      expect(res.status).not.toBe(503);
    },
  );
});

describe("middleware — maintenance mode ON", () => {
  it("gates /search ahead of the auth redirect, for unauthenticated visitors", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(makeMaintReq("/search") as never, {} as never) as Response;

    // 503, not the usual 307 to /login — proof the gate runs above the auth check.
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("gates /search for a signed-in admin who is not on the bypass list", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(
      makeMaintReq("/search", "someone@else.com") as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(503);
  });

  it.each([
    "/api/internal/sync-wise",
    "/api/internal/cron-watchdog",
    "/api/internal/post-class-feedback-backfill",
    "/api/internal/class-assignments/morning",
  ])("keeps the cron path %s running", async (pathname) => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(makeMaintReq(pathname) as never, {} as never) as Response;

    expect(res.status).not.toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps a parent schedule link rendering", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(makeMaintReq("/schedule/tok123") as never, {} as never) as Response;

    expect(res.status).not.toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["/login", "/api/auth/callback/google"])(
    "keeps %s reachable so a bypass admin can sign in",
    async (pathname) => {
      process.env.MAINTENANCE_MODE = "true";

      const res = await middleware(makeMaintReq(pathname) as never, {} as never) as Response;

      expect(res.status).not.toBe(503);
    },
  );

  it("gates /api/line/webhook — the gate outranks the public allowlist", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(makeMaintReq("/api/line/webhook") as never, {} as never) as Response;

    // isPublicRoute allowlists this path, so a gate placed after it would let
    // the webhook through. Blocking it is deliberate: LINE does not redeliver,
    // so inbound OA messages during a window are lost, not queued.
    expect(res.status).toBe(503);
  });

  it("gates the authenticated /student-schedule admin page", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(
      makeMaintReq("/student-schedule", "someone@else.com") as never,
      {} as never,
    ) as Response;

    // The trailing slash on the "/schedule/" exemption is what separates this
    // from the public parent page.
    expect(res.status).toBe(503);
  });

  it("returns JSON on API paths and HTML on page paths", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const api = await middleware(makeMaintReq("/api/compare") as never, {} as never) as Response;
    const page = await middleware(makeMaintReq("/search") as never, {} as never) as Response;

    expect(api.headers.get("content-type")).toContain("application/json");
    expect(api.headers.get("retry-after")).toBe("3600");
    expect(page.headers.get("content-type")).toContain("text/html");
    await expect(page.text()).resolves.toContain("down for maintenance");
  });

  it.each(["/search", "/api/payroll", "/data-health"])(
    "lets a bypass-listed admin reach %s",
    async (pathname) => {
      process.env.MAINTENANCE_MODE = "true";
      process.env.MAINTENANCE_BYPASS_EMAILS = "kevhsh7@gmail.com";

      const res = await middleware(
        makeMaintReq(pathname, "kevhsh7@gmail.com") as never,
        {} as never,
      ) as Response;

      expect(res.status).not.toBe(503);
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it("gates everyone when the bypass list is unset — fail-closed", async () => {
    process.env.MAINTENANCE_MODE = "true";

    const res = await middleware(
      makeMaintReq("/search", "kevhsh7@gmail.com") as never,
      {} as never,
    ) as Response;

    expect(res.status).toBe(503);
  });
});
