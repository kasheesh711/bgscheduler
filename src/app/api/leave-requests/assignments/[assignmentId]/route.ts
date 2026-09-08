import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { assertLeaveAdmin, assignmentActivity, LeaveWorkConflict, LeaveWorkNotFound, mutateLeaveWork } from "@/lib/leave-requests/work-data";

const mutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), mutationKey: z.string().uuid(), expectedVersion: z.number().int().positive(), entityId: z.string().uuid(), ownerEmail: z.string().email().nullable() }),
  z.object({ kind: z.literal("class"), mutationKey: z.string().uuid(), expectedVersion: z.number().int().positive(), entityId: z.string().uuid(), checked: z.boolean() }),
  z.object({ kind: z.literal("family"), mutationKey: z.string().uuid(), expectedVersion: z.number().int().positive(), entityId: z.string().uuid(), checked: z.boolean() }),
]);
type Context = { params: Promise<{ assignmentId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  try { await assertLeaveAdmin(db, session.user.email); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { assignmentId } = await context.params;
  if (!z.string().uuid().safeParse(assignmentId).success) return NextResponse.json({ error: "Invalid assignment." }, { status: 400 });
  const [assignment] = await db.select().from(s.leaveAssignments).where(eq(s.leaveAssignments.id, assignmentId));
  if (!assignment) return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
  const [sources, activity] = await Promise.all([
    assignment.sourceRequestIds.length ? db.select({ request: s.leaveRequests, normalization: s.leaveNormalizations }).from(s.leaveRequests)
      .leftJoin(s.leaveNormalizations, and(eq(s.leaveNormalizations.requestId, s.leaveRequests.id), eq(s.leaveNormalizations.inputKey, s.leaveRequests.currentNormalizationKey)))
      .where(inArray(s.leaveRequests.id, assignment.sourceRequestIds)).orderBy(desc(s.leaveRequests.sourceSubmittedAt)) : [],
    assignmentActivity(db, assignmentId),
  ]);
  return NextResponse.json({ assignment, sources, activity }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: NextRequest, context: Context) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  try { await assertLeaveAdmin(db, session.user.email); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { assignmentId } = await context.params;
  const body = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(assignmentId).success || !body.success) return NextResponse.json({ error: "Invalid checklist update." }, { status: 400 });
  try {
    return NextResponse.json(await mutateLeaveWork(db, assignmentId, body.data, { email: session.user.email.toLowerCase(), name: session.user.name ?? null }));
  } catch (error) {
    if (error instanceof LeaveWorkConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof LeaveWorkNotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save this update." }, { status: 400 });
  }
}
