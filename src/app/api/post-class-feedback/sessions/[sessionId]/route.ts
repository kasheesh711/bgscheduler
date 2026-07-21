import { NextResponse } from "next/server";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { getPostClassFeedbackSessionDetail } from "@/lib/post-class-feedback/detail";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requirePostClassCapability("viewer");
    const { sessionId } = await context.params;
    const detail = await getPostClassFeedbackSessionDetail(sessionId, user);
    return NextResponse.json(detail);
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "GET /api/post-class-feedback/sessions/[sessionId]",
      error,
      "Could not load feedback history.",
    );
  }
}
