import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { sendPostClassTestEmail } from "@/lib/post-class-feedback/notifications";

const BodySchema = z.object({ recipientEmail: z.string().email() });

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const input = BodySchema.parse(await request.json());
    const result = await sendPostClassTestEmail(actor.email, input.recipientEmail);
    return NextResponse.json(result);
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/test-email",
      error,
      "Could not send the test email.",
    );
  }
}
