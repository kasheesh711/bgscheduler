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

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
