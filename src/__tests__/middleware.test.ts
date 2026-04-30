import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: (handler: (req: any) => any) => handler,
}));

import middleware from "@/middleware";

function makeReq(pathname: string, isAuth = false) {
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    url: `http://localhost${pathname}`,
    auth: isAuth ? { user: { email: "kevhsh7@gmail.com" } } : null,
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

  it("non-public route /search redirects to /login when unauthenticated, with callbackUrl preserved", async () => {
    const res = await middleware(makeReq("/search", false) as never, {} as never) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).toContain("callbackUrl=%2Fsearch");
  });

  it("non-public route /search passes through when authenticated", async () => {
    const res = await middleware(makeReq("/search", true) as never, {} as never) as Response;

    expect(res.headers.get("location")).toBeNull();
  });
});
