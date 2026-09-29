import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { DASHBOARD_WINDOWS, loadAutowriterDashboard, type DashboardWindowDays } from "@/lib/feedback-autowriter/dashboard";

/**
 * Read-only dashboard payload. Page scope (full admins, or restricted admins
 * granted the page) is enforced by the proxy; the role check here keeps the
 * written feedback away from any non-admin session even if that changes.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const requested = Number(request.nextUrl.searchParams.get("days") ?? "7");
  const windowDays: DashboardWindowDays = (DASHBOARD_WINDOWS as readonly number[]).includes(requested)
    ? requested as DashboardWindowDays
    : 7;
  try {
    return NextResponse.json(await loadAutowriterDashboard(getDb(), { windowDays }));
  } catch (error) {
    if (error instanceof Error && "digest" in error && (error as { digest?: string }).digest === "HANGING_PROMISE_REJECTION") throw error;
    return NextResponse.json({ error: "Feedback autowriter dashboard could not load." }, { status: 500 });
  }
}
