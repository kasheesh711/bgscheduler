import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { dueCaptureQueue, listCaptures, saveCapture } from "@/lib/post-class-feedback/captures";
import { PostClassValidationError } from "@/lib/post-class-feedback/errors";
import { todayBangkok } from "@/lib/room-capacity/dates";

export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    await requirePostClassCapability("viewer");
    const id = request.nextUrl.searchParams.get("sessionId");
    const payload = id ? await listCaptures(z.uuid().parse(id)) : await dueCaptureQueue(z.iso.date().parse(request.nextUrl.searchParams.get("date") ?? todayBangkok()));
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return postClassFeedbackErrorResponse("GET captures", error, "Could not load screenshot evidence."); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await requirePostClassCapability("reviewer");
    if (request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
    if (Number(request.headers.get("content-length")) > 4 * 1024 * 1024 + 32 * 1024) throw new PostClassValidationError("Select an image no larger than 4 MB.");
    const form = await request.formData();
    const id = z.uuid().parse(form.get("sessionId"));
    const metadata = z.string().max(16000).parse(form.get("metadata"));
    let raw: unknown;
    try { raw = JSON.parse(metadata); } catch { throw new PostClassValidationError("Capture metadata is invalid."); }
    const image = form.get("image");
    if (image instanceof File && image.size > 4 * 1024 * 1024) throw new PostClassValidationError("Select an image no larger than 4 MB.");
    const capture = await saveCapture(id, raw, image instanceof File && image.size ? Buffer.from(await image.arrayBuffer()) : null, user.email);
    return NextResponse.json({ id: capture.id, uploadStatus: capture.uploadStatus, uploadError: capture.uploadError }, { status: capture.uploadStatus === "failed" ? 503 : 200 });
  } catch (error) { return postClassFeedbackErrorResponse("POST captures", error, "Could not save screenshot evidence."); }
}
