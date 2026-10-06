import { after } from "next/server";
import { requireCaptureScope, assertCaptureSessionCurrent } from "./sessions";
import { captureForScope, captureView } from "./store";
import { automaticAction, kickAutomaticCapture } from "./automatic";
import { captureError, captureJson, captureRequest, requireCaptureEnabled } from "./http";
import { z } from "zod";

export async function processCapture(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireCaptureEnabled();
    const scope = await requireCaptureScope();
    const id = z.uuid().parse((await context.params).id);
    const capture = await captureForScope(scope, id);
    await assertCaptureSessionCurrent(scope, capture.session);
    await automaticAction(scope, id, await captureRequest(request));
    after(() => kickAutomaticCapture(id));
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
