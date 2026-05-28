import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listWiseActivityEvents, wiseActivityBangkokRange } from "@/lib/wise-activity/data";
import { addBangkokDays, todayBangkok } from "@/lib/room-capacity/dates";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function numberParam(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function stringParam(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const defaultEnd = todayBangkok();
  const defaultStart = addBangkokDays(defaultEnd, -6);
  const startDate = params.get("startDate") ?? defaultStart;
  const endDate = params.get("endDate") ?? defaultEnd;
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || startDate > endDate) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  try {
    const { start, end } = wiseActivityBangkokRange(startDate, endDate);
    const data = await listWiseActivityEvents(getDb(), {
      start,
      end,
      page: numberParam(params.get("page"), 1, 1, 10_000),
      pageSize: numberParam(params.get("pageSize"), 50, 1, 100),
      eventType: stringParam(params.get("type")),
      eventName: stringParam(params.get("eventName")),
      query: stringParam(params.get("q")),
      sessionId: stringParam(params.get("sessionId")),
      transactionId: stringParam(params.get("transactionId")),
      financeOnly: params.get("financeOnly") === "true",
    });

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wise activity query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
