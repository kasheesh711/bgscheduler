import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireProgressTestsAdminSession, progressTestsErrorResponse } from "@/lib/progress-tests/api";
import { resendTeacherEmail } from "@/lib/progress-tests/service";

const ResendEmailSchema = z.object({
  enrollmentKey: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireProgressTestsAdminSession();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = ResendEmailSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const result = await resendTeacherEmail({ enrollmentKey: parsed.data.enrollmentKey, actor: user });
    if (!result.row) {
      return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return progressTestsErrorResponse("/api/progress-tests/resend-email", error, "Resend teacher email failed");
  }
}
