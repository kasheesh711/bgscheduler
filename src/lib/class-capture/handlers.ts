import { after } from "next/server";
import { automaticCaptureEnabled } from "./automatic-model";
import { kickAutomaticCapture } from "./automatic";
import { projectAsset } from "./store";
import { z } from "zod";
import { availability, CaptureError, createCaptureSchema, patchCaptureSchema, assetInputSchema } from "./model";
import { captureError, captureJson, captureRequest, privateHeaders, requireCaptureEnabled } from "./http";
import { requireCaptureScope, listCaptureSessions, requireCaptureSession, assertCaptureSessionCurrent, type CaptureScope } from "./sessions";
import { createCapture, captureForScope, captureView, updateCapture, createAsset, markDeleted, assetForScope, discardAsset } from "./store";
import { uploadHandler, finalizeAsset, readMediaBytes } from "./files";
import { transcribeCapture, draftCapture } from "./processing";
import { cleanupCapture } from "./cleanup";
import { todayBangkok } from "@/lib/room-capacity/dates";

export type CaptureContext = { params: Promise<{ id: string }> };
export type AssetContext = { params: Promise<{ id: string; assetId: string }> };
const uuid = (id: string) => z.uuid().parse(id);
async function currentCapture(scope: CaptureScope, id: string) {
  const capture = await captureForScope(scope, id);
  await assertCaptureSessionCurrent(scope, capture.session);
}

export async function list(request: Request) {
  try {
    const scope = await requireCaptureScope();
    requireCaptureEnabled();
    const date = new URL(request.url).searchParams.get("date") ?? todayBangkok();
    return captureJson({ sessions: await listCaptureSessions(scope, date), availability: availability() });
  } catch (error) { return captureError(error); }
}
export async function create(request: Request) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    const input = createCaptureSchema.parse(await captureRequest(request));
    const session = await requireCaptureSession(scope, input.sessionId, input.studentId);
    const id = await createCapture(scope, input, session);
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
export async function read(_request: Request, context: CaptureContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    const id = uuid((await context.params).id);
    await currentCapture(scope, id);
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
export async function patch(request: Request, context: CaptureContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    const id = uuid((await context.params).id);
    await currentCapture(scope, id);
    await updateCapture(scope, id, patchCaptureSchema.parse(await captureRequest(request)));
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
export async function remove(request: Request, context: CaptureContext) {
  try {
    const scope = await requireCaptureScope();
    // A paused feature still permits deletion, and the worker keeps cleaning.
    if (request.headers.get("origin") !== new URL(request.url).origin) throw new CaptureError(403, "Invalid request origin.");
    const id = uuid((await context.params).id);
    await markDeleted(scope, id);
    let cleanupPending = true;
    try { cleanupPending = !(await cleanupCapture(id)).purged; } catch { /* The scheduled sweep retries. */ }
    return captureJson({ deleted: true, cleanupPending });
  } catch (error) { return captureError(error); }
}
export async function addAsset(request: Request, context: CaptureContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    if (!availability().storage) throw new CaptureError(503, "Private storage is not configured. Keep your local recording and retry after setup.");
    const input = assetInputSchema.parse(await captureRequest(request));
    const id = uuid((await context.params).id);
    await currentCapture(scope, id);
    return captureJson({ asset: await createAsset(scope, id, input) });
  } catch (error) { return captureError(error); }
}
export async function upload(request: Request) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    if (!availability().storage) throw new CaptureError(503, "Private storage is not configured.");
    const input = z.object({ type: z.literal("blob.generate-client-token"), payload: z.object({ pathname: z.string().max(200), clientPayload: z.string().max(100).nullable(), multipart: z.boolean() }) }).parse(await captureRequest(request));
    const asset = await assetForScope(scope, uuid(input.payload.clientPayload ?? ""));
    await currentCapture(scope, asset.captureId);
    return captureJson(await uploadHandler(request, input, scope));
  } catch (error) { return captureError(error); }
}
export async function finalize(request: Request, context: AssetContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled(); await captureRequest(request);
    const { id, assetId } = await context.params;
    await currentCapture(scope, uuid(id));
    await finalizeAsset(scope, uuid(id), uuid(assetId));
    if (automaticCaptureEnabled()) {
      after(() => kickAutomaticCapture(id));
      if (new URL(request.url).searchParams.get("automatic") === "1") return captureJson({ asset: projectAsset(await assetForScope(scope, assetId)) });
    }
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
export async function media(_request: Request, context: AssetContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    const { id, assetId } = await context.params;
    const asset = await assetForScope(scope, uuid(assetId));
    if (asset.captureId !== uuid(id)) throw new CaptureError(404, "Evidence not found in this class.");
    await currentCapture(scope, id);
    if (asset.status === "pending") throw new CaptureError(409, "Finish the upload before previewing it.");
    const bytes = await readMediaBytes(asset);
    // Fixed MIME + sandbox + no sniffing: private uploads never become executable app content.
    return new Response(new Uint8Array(bytes), { headers: { ...privateHeaders, "Content-Type": asset.mime,
      "Content-Length": String(bytes.length), "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" } });
  } catch (error) { return captureError(error); }
}
export async function removeAsset(request: Request, context: AssetContext) {
  try {
    const scope = await requireCaptureScope();
    if (request.headers.get("origin") !== new URL(request.url).origin) throw new CaptureError(403, "Invalid request origin.");
    const { id, assetId } = await context.params;
    await discardAsset(scope, uuid(id), uuid(assetId));
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
export async function transcribe(request: Request, context: CaptureContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled();
    const { assetId } = z.object({ assetId: z.uuid() }).strict().parse(await captureRequest(request));
    const id = uuid((await context.params).id);
    await currentCapture(scope, id);
    await transcribeCapture(scope, id, assetId);
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
export async function draft(request: Request, context: CaptureContext) {
  try {
    const scope = await requireCaptureScope(); requireCaptureEnabled(); await captureRequest(request);
    const id = uuid((await context.params).id);
    await currentCapture(scope, id);
    await draftCapture(scope, id);
    return captureJson({ capture: await captureView(scope, id) });
  } catch (error) { return captureError(error); }
}
