import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireProgressTestsSession, progressTestsErrorResponse } from "@/lib/progress-tests/api";
import { bookTest } from "@/lib/progress-tests/service";

const BookProgressTestSchema = z.object({
  enrollmentKey: z.string().min(1),
  testDate: z.string().datetime(),
  location: z.string().optional(),
  modality: z.enum(["online", "offline"]).optional(),
  // "after_class" = admin clicked a recommended slot; "parent_pick" = custom time.
  scheduleMethod: z.enum(["after_class", "parent_pick"]).default("parent_pick"),
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

    const parsed = BookProgressTestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const result = await bookTest({
      enrollmentKey: parsed.data.enrollmentKey,
      testDate: new Date(parsed.data.testDate),
      location: parsed.data.location ?? null,
      scheduleMethod: parsed.data.scheduleMethod,
      actor: user,
    });

    if (!result.row) {
      return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return progressTestsErrorResponse("/api/progress-tests/book", error, "Progress test booking failed");
  }
}
