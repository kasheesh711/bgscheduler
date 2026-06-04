import { edgeAuth } from "@/lib/auth-edge";
import { NextResponse } from "next/server";

function isPublicRoute(pathname: string) {
  return (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname === "/api/search/assistant" ||
    pathname === "/api/classrooms/floor-plan-map" ||
    pathname === "/api/line/webhook" ||
    pathname === "/api/line/contacts/oa-resolver/worklist" ||
    /^\/api\/line\/contacts\/oa-resolver\/runs\/[^/]+\/rows$/.test(pathname) ||
    pathname.startsWith("/api/internal/")
  );
}

/**
 * Page-level access control. `allowedPages` is null for full-access admins, so
 * this short-circuits to full access. For restricted users it matches the
 * pathname against each allowed prefix, both as a page (`/x`, `/x/...`) and as
 * its API namespace (`/api/x`, `/api/x/...`).
 *
 * @returns true when the pathname is reachable for the given allowedPages.
 */
function isPathAllowed(pathname: string, allowedPages: string[] | null): boolean {
  if (!allowedPages) return true;
  return allowedPages.some((page) => {
    return (
      pathname === page ||
      pathname.startsWith(`${page}/`) ||
      pathname === `/api${page}` ||
      pathname.startsWith(`/api${page}/`)
    );
  });
}

export default edgeAuth((req) => {
  const { pathname, search } = req.nextUrl;

  if (isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  // Require auth for everything else
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Page-level access control for restricted users (null = full access).
  const allowedPages = req.auth.user?.allowedPages ?? null;
  if (allowedPages && !isPathAllowed(pathname, allowedPages)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Redirect a restricted user to their landing page, guarding against a loop.
    const target = allowedPages[0];
    if (pathname !== target) {
      return NextResponse.redirect(new URL(target, req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
