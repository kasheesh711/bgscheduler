import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { loadNightlyReminderHealth, nightlyReminderHistory } from "@/lib/post-class-feedback/nightly-reminder-health";
import { nightlyWorkerOutcome, previewNightlyRun, resolveNightlyUnknown, runNightlyReminders } from "@/lib/post-class-feedback/nightly-reminders";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runDataHealthJob } from "@/lib/data-health/run-job";

export const maxDuration = 800;

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("shadow_preview") }),
  z.object({ action: z.literal("resolve"), deliveryId: z.string().uuid(), expectedAttempt: z.number().int().min(1),
    outcome: z.enum(["accepted", "not_sent"]), receipt: z.string().trim().max(500).optional(), note: z.string().trim().min(10).max(2000) }),
]);

export async function GET(request: NextRequest) {
  try {
    const user = await requirePostClassCapability("viewer");
    const params = request.nextUrl.searchParams;
    const input = z.object({ sessionId: z.string().uuid().optional(), tutorKey: z.string().max(200).optional() })
      .parse({ sessionId: params.get("sessionId") ?? undefined, tutorKey: params.get("tutorKey") ?? undefined });
    const db = getDb();
    const health = await loadNightlyReminderHealth(db);
    const history = await nightlyReminderHistory(db, { ...input, canManageAccess: user.capabilities.includes("access_manager") });
    const previews = params.get("preview") === "true" && health.runId && user.capabilities.includes("access_manager")
      ? await previewNightlyRun(health.runId, db) : [];
    return NextResponse.json({ health, history, previews });
  } catch (error) { return postClassFeedbackErrorResponse("GET /api/post-class-feedback/reminders", error, "Could not load reminder history."); }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const input = Action.parse(await request.json());
    if (input.action === "shadow_preview") {
      return withCronInvocationAudit({ jobKey: "post_class_feedback_nightly", triggerSource: "admin", actorEmail: actor.email, requestMethod: "POST" }, async () => {
        const result = nightlyWorkerOutcome(await runNightlyReminders({ shadowPreview: true }));
        return NextResponse.json(result, { status: result.ok ? 200 : 503 });
      });
    }
    if (input.action === "retry") return runDataHealthJob("post_class_feedback_nightly", actor.email);
    await resolveNightlyUnknown(input, actor.email);
    return NextResponse.json({ ok: true });
  } catch (error) { return postClassFeedbackErrorResponse("POST /api/post-class-feedback/reminders", error, "Could not update reminder delivery."); }
}
