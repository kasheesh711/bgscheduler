import { NextResponse } from "next/server";
import type { HandleUploadBody } from "@vercel/blob/client";
import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { assessmentUploadHandler } from "@/lib/hiring/assessment-files";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";

export async function POST(request: Request) {
  try {
    await requireHiringAdmin();
    requireSameOrigin(request);
    return NextResponse.json(await assessmentUploadHandler(request, (await request.json()) as HandleUploadBody, getDb()));
  } catch (error) {
    return hiringError(error);
  }
}
