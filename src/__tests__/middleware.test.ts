import { describe, it, expect, vi } from "vitest";
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

  it("/api/classrooms/floor-plan-map bypasses auth as a public email-safe asset", async () => {
    const res = await middleware(makeReq("/api/classrooms/floor-plan-map") as never, {} as never) as Response;

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

  it("does not let the OA resolver rows public regex match nested paths", async () => {
    const res = await middleware(
      makeReq("/api/line/contacts/oa-resolver/runs/11111111-1111-1111-1111-111111111111/rows/audit", false) as never,
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
