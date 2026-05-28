import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listLineFalseNegativeCandidates } from "@/lib/line/data";

const thresholdSchema = z.coerce.number().min(0).max(1);

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawThreshold = request.nextUrl.searchParams.get("threshold");
  let threshold: number | undefined;
  if (rawThreshold !== null) {
    const parsed = thresholdSchema.safeParse(rawThreshold);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid threshold" }, { status: 400 });
    }
    threshold = parsed.data;
  }

  const candidates = await listLineFalseNegativeCandidates(getDb(), { threshold });
  return NextResponse.json({ candidates });
}
