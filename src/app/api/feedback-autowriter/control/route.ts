import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { requireClassroomOperationsOwner } from "@/lib/classrooms/operations-access";
import { getDb } from "@/lib/db";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "@/lib/feedback-autowriter/roster";
import { haltAutowriter, readControl, requeueShadowDrafts, updateControl } from "@/lib/feedback-autowriter/store";
import { AUTOWRITER_DEADLINE_MARGIN_MS } from "@/lib/feedback-autowriter/types";

const ControlBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mode"), mode: z.enum(["off", "shadow", "live"]) }),
  z.object({ action: z.literal("pause"), reason: z.string().trim().min(1).max(300) }),
  z.object({ action: z.literal("resume") }),
  // A tutor's switch covers every account they teach from (the dashboard sends all of them).
  z.object({ action: z.literal("tutor"), wiseUserIds: z.array(z.string().regex(/^[0-9a-f]{24}$/iu)).min(1).max(20), enabled: z.boolean() }),
]);

/** Owner-only switches on the autowriter control row (same effect as the CLI). */
export async function POST(request: NextRequest) {
  let actor: { email: string };
  try {
    actor = await requireClassroomOperationsOwner();
  } catch (error) {
    if (error instanceof AdminUsersAccessError) {
      return NextResponse.json(
        { error: error.status === 403 ? "Only Kevin can change the feedback autowriter." : error.message },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: "Access check failed." }, { status: 500 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = ControlBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const db = getDb();
  const body = parsed.data;
  let requeued = 0;
  try {
    if (body.action === "mode") {
      await updateControl(db, { mode: body.mode }, actor.email);
      if (body.mode === "live") requeued = await requeueShadowDrafts(db, new Date(Date.now() + AUTOWRITER_DEADLINE_MARGIN_MS));
    } else if (body.action === "pause") {
      // Adds to (never replaces) an automatic halt reason already recorded.
      await haltAutowriter(db, `paused by ${actor.email}: ${body.reason}`, actor.email);
    } else if (body.action === "resume") {
      await updateControl(db, { haltedAt: null, haltReason: null }, actor.email);
    } else {
      if (!body.wiseUserIds.every((id) => AUTOWRITER_TEACHER_ALLOWLIST.has(id))) {
        return NextResponse.json({ error: "Not a roster tutor." }, { status: 400 });
      }
      const disabled = new Set((await readControl(db)).disabledTutors);
      for (const id of body.wiseUserIds) {
        if (body.enabled) disabled.delete(id); else disabled.add(id);
      }
      await updateControl(db, { disabledTutors: [...disabled] }, actor.email);
    }
    const control = await readControl(db);
    return NextResponse.json({ ok: true, requeued, control: { mode: control.mode, haltedAt: control.haltedAt, haltReason: control.haltReason, disabledTutors: control.disabledTutors } });
  } catch (error) {
    console.error("[feedback-autowriter] control update failed", error instanceof Error ? error.name : "Error");
    return NextResponse.json({ error: "Control update failed." }, { status: 500 });
  }
}
