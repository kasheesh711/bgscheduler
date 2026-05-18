import { NextResponse } from "next/server";
import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { readCreditActionHistory } from "@/lib/credit-control/db";

export async function GET(request: Request) {
  try {
    await requireCreditControlSession();
    const { searchParams } = new URL(request.url);
    const studentKey = String(searchParams.get("studentKey") ?? "").trim();

    if (!studentKey) {
      return NextResponse.json({ error: "studentKey is required" }, { status: 400 });
    }

    const rows = await readCreditActionHistory(studentKey, 7);
    const history = rows.map((row) => ({
      status: row.status,
      updatedAt: row.createdAt.toISOString(),
      updatedByName: row.actorName,
      actionType: row.actionType,
    }));

    return NextResponse.json({ history });
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control/actions/history", error, "Failed to load history");
  }
}
