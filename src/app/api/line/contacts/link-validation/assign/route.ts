import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  assignLineLinkValidationTasks,
  LineLinkValidationError,
} from "@/lib/line/link-validation";

const assignSchema = z.object({
  runId: z.string().uuid(),
  reviewerEmails: z.array(z.string().email()).min(1).max(50),
  linkIds: z.array(z.string().uuid()).min(1).max(500).optional(),
}).strict();

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await assignLineLinkValidationTasks(getDb(), parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LineLinkValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
