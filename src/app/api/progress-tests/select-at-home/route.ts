import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireProgressTestsSession, progressTestsErrorResponse } from "@/lib/progress-tests/api";
import { selectAtHome } from "@/lib/progress-tests/service";

const SelectAtHomeSchema = z.object({
  enrollmentKey: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireProgressTestsSession();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = SelectAtHomeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const row = await selectAtHome({ enrollmentKey: parsed.data.enrollmentKey, actor: user });
    if (!row) {
      return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
    }

    return NextResponse.json({ row });
  } catch (error) {
    return progressTestsErrorResponse("/api/progress-tests/select-at-home", error, "Select at-home failed");
  }
}
