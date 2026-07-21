import { NextRequest, NextResponse } from "next/server";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import {
  defaultPostClassFeedbackRange,
  getPostClassFeedbackDashboard,
} from "@/lib/post-class-feedback/dashboard";

export async function GET(request: NextRequest) {
  try {
    const user = await requirePostClassCapability("viewer");
    const defaults = defaultPostClassFeedbackRange();
    const payload = await getPostClassFeedbackDashboard(user, {
      startDate: request.nextUrl.searchParams.get("startDate") ?? defaults.startDate,
      endDate: request.nextUrl.searchParams.get("endDate") ?? defaults.endDate,
    });
    return NextResponse.json(payload);
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "GET /api/post-class-feedback",
      error,
      "Could not load post-class feedback.",
    );
  }
}
