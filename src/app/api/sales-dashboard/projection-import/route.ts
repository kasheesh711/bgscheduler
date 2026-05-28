import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { importActiveSalesDashboardProjectionSource } from "@/lib/sales-dashboard/data";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";

export const maxDuration = 800;

export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await importActiveSalesDashboardProjectionSource({
      triggerType: "manual",
      actorEmail: session.user.email,
    });
    if (!result) {
      return NextResponse.json({ error: "No projection source configured." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sales projection import failed";
    const status = error instanceof MissingGoogleSheetsTokenError ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
