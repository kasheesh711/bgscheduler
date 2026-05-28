import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getWisePackageSalesReconciliation } from "@/lib/wise-activity/reconciliation";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function stringParam(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateDateRange(startDate?: string, endDate?: string): boolean {
  if (!startDate && !endDate) return true;
  if (!startDate || !endDate) return false;
  return DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate <= endDate;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const sourceId = stringParam(params.get("sourceId"));
  const month = stringParam(params.get("month"));
  const startDate = stringParam(params.get("startDate"));
  const endDate = stringParam(params.get("endDate"));

  if (month && !MONTH_RE.test(month)) {
    return NextResponse.json({ error: "Invalid month" }, { status: 400 });
  }
  if (!validateDateRange(startDate, endDate)) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  try {
    const data = await getWisePackageSalesReconciliation(getDb(), {
      sourceId,
      month,
      startDate,
      endDate,
    });
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wise reconciliation query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
