import { edgeAuth } from "@/lib/auth-edge";
import { validateSessionAccess } from "@/lib/auth-session";
import {
  isMaintenanceBypassEmail,
  isMaintenanceExempt,
  isMaintenanceMode,
  maintenanceResponse,
} from "@/lib/maintenance";
import { NextResponse } from "next/server";

function isPublicRoute(pathname: string) {
  return (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname === "/api/search/assistant" ||
    pathname === "/api/classrooms/floor-plan-map" ||
    pathname === "/api/line/webhook" ||
    // Parent schedule links are opened from a LINE message, so they carry no
    // session. Access is the capability token in the path and nothing else —
    // see src/lib/student-schedule/links.ts. Note the trailing slash: it keeps
    // the authenticated /student-schedule admin page out of this allowlist.
    pathname.startsWith("/schedule/") ||
    /^\/room\/[^/]+$/.test(pathname) ||
    pathname === "/api/room/availability" ||
    pathname === "/api/room/reservations" ||
    /^\/api\/room\/reservations\/[^/]+$/.test(pathname) ||
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
  // The owner guard checks current designation and admin status independently.
  if (pathname === "/admin/users" || pathname === "/api/admin/users") return true;
  if (pathname === "/api/home/summary") return true;
  // Post-class feedback uses fresh database capabilities on every page/API
  // request, so legacy JWT page prefixes must not override those grants.
  if (
    pathname === "/post-class-feedback" ||
    pathname.startsWith("/post-class-feedback/") ||
    pathname === "/api/post-class-feedback" ||
    pathname.startsWith("/api/post-class-feedback/")
  ) return true;
  // Unearned Revenue resolves dedicated viewer/access_manager grants freshly
  // from Postgres on every page and API request.
  if (
    pathname === "/unearned-revenue" ||
    pathname.startsWith("/unearned-revenue/") ||
    pathname === "/api/unearned-revenue" ||
    pathname.startsWith("/api/unearned-revenue/")
  ) return true;
  // Learning Plans uses a fresh database grant in its Server Components.
  // Coarse-pass only the authenticated page namespace here; do not broaden
  // this exception to similarly named pages or an API namespace.
  if (
    pathname === "/learning-plans" ||
    pathname.startsWith("/learning-plans/")
  ) return true;
  if (
    pathname === "/api/learning-plans" ||
    pathname.startsWith("/api/learning-plans/")
  ) return false;
  if (pathname === "/" && allowedPages.length > 1) return true;
  return allowedPages.some((page) => {
    return (
      pathname === page ||
      pathname.startsWith(`${page}/`) ||
      pathname === `/api${page}` ||
      pathname.startsWith(`/api${page}/`)
    );
  });
}

export default edgeAuth(async (req) => {
  const { pathname, search } = req.nextUrl;

  // MAINT-04 — see src/lib/maintenance.ts. This MUST stay above isPublicRoute:
  // that allowlist passes /api/line/webhook, so a gate placed after it would
  // wave through the one path maintenance mode is meant to close. Off by
  // default, so this is a no-op unless MAINTENANCE_MODE is exactly "true".
  if (
    isMaintenanceMode() &&
    !isMaintenanceExempt(pathname) &&
    !isMaintenanceBypassEmail(req.auth?.user?.email)
  ) {
    return maintenanceResponse(pathname);
  }

  if (isPublicRoute(pathname)) {
    const response = NextResponse.next();
    if (pathname.startsWith("/room/") || pathname.startsWith("/api/room/")) {
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
    return response;
  }

  // The wrapper decodes cookies only. Skip all DB work for public routes and
  // absent sessions; protected requests share server auth()'s fresh check.
  const session = await validateSessionAccess(req.auth);

  // Require auth for everything else
  if (!session) {
    if (req.auth && pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Page-level access control for restricted users (null = full access).
  const allowedPages = session.user?.allowedPages ?? null;
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
