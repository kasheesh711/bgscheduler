import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listPrintRuns, printDateSchema } from "@/lib/classrooms/print-report";

export async function GET(request: NextRequest) {
  if (!await auth()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const date = printDateSchema.safeParse(request.nextUrl.searchParams.get("date"));
  if (!date.success) return NextResponse.json({ error: "A valid start date is required" }, { status: 400 });
  try { return NextResponse.json(await listPrintRuns(getDb(), date.data)); }
  catch { return NextResponse.json({ error: "Unable to load saved runs for printing" }, { status: 500 }); }
}
