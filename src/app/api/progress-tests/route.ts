import { NextResponse } from "next/server";
import { requireProgressTestsSession, progressTestsErrorResponse } from "@/lib/progress-tests/api";
import { getProgressTestsPayload } from "@/lib/progress-tests/service";

export async function GET() {
  try {
    await requireProgressTestsSession();
    const payload = await getProgressTestsPayload();
    return NextResponse.json(payload);
  } catch (error) {
    return progressTestsErrorResponse("/api/progress-tests", error, "Progress tests load failed");
  }
}
