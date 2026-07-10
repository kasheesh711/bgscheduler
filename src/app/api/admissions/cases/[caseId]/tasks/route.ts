// Admissions Case Management — checklist task routes (design §4, PRD
// CM-21..CM-24).
//
// GET lists a case's live tasks + progress (minRole student — parents are
// view-only via the parent dashboard projection and get 403 here); POST
// creates a counselor custom task (minRole counselor); PATCH multiplexes task
// mutations via body.action: "status" is gated at student (the lib enforces
// the student-owned-task rule from the CaseAccess), while "verify"/"update"/
// "delete" are counselor+ inside the lib (Forbidden → 403). DELETE soft-
// deletes a custom task by ?taskId= (counselor+); template-derived tasks are
// rejected with 409 by the lib on both delete paths. requireCaseAccess runs
// BEFORE body parsing on every method (design §4).

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  admissionsTaskRecurrenceSchema,
  computeProgress,
  createCustomTask,
  listCaseTasks,
  setTaskVerified,
  softDeleteTask,
  updateTask,
  updateTaskStatus,
} from "@/lib/admissions/checklists";

const ROUTE = "/api/admissions/cases/[caseId]/tasks";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected "YYYY-MM-DD"');

// Parent-owned rows remain readable for legacy history, but new work is
// assigned only to the student or counseling team.
const taskOwnerSchema = z.enum(["student", "counselor"]);

// Mirrors ADMISSIONS_TASK_STATUSES (src/lib/admissions/checklists.ts).
const taskStatusSchema = z.enum(["not_started", "in_progress", "done"]);

// Mirrors ADMISSIONS_CHECKLIST_PHASES keys (src/lib/admissions/config.ts)
// plus MEETING_ACTION_ITEM_PHASE ("custom") — the lib re-validates phases
// fail-closed, this just gives a 400 instead of a 500.
const taskPhaseSchema = z.enum([
  "about_you",
  "academics",
  "testing",
  "activities",
  "college_research",
  "essays",
  "recommendations",
  "applications",
  "decisions_aid",
  "transition",
  "custom",
]);

const createTaskSchema = z.object({
  title: z.string().trim().min(1, "Task title must not be empty"),
  description: z.string().nullish(),
  owner: taskOwnerSchema,
  phase: taskPhaseSchema.optional(),
  dueDate: dateOnlySchema.nullish(),
  recurrence: admissionsTaskRecurrenceSchema.nullish(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const patchTaskSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status"),
    taskId: z.string().uuid(),
    status: taskStatusSchema,
  }),
  z.object({
    action: z.literal("verify"),
    taskId: z.string().uuid(),
    verified: z.boolean(),
    expectedUpdatedAt: z.string().datetime(),
  }),
  z.object({
    action: z.literal("update"),
    taskId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    title: z.string().trim().min(1, "Task title must not be empty").optional(),
    description: z.string().nullish(),
    owner: taskOwnerSchema.optional(),
    dueDate: dateOnlySchema.nullish(),
    recurrence: admissionsTaskRecurrenceSchema.nullish(),
    sortOrder: z.coerce.number().int().min(0).optional(),
  }),
  z.object({
    action: z.literal("delete"),
    taskId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
  }),
]);

const deleteQuerySchema = z.object({
  taskId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
});

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "student");

    const tasks = await listCaseTasks(caseId);
    const progress = await computeProgress(caseId);
    return NextResponse.json({ tasks, progress });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Task list failed");
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = createTaskSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const task = await createCustomTask({
      access,
      title: parsed.data.title,
      description: parsed.data.description,
      owner: parsed.data.owner,
      phase: parsed.data.phase,
      dueDate: parsed.data.dueDate,
      recurrence: parsed.data.recurrence,
      sortOrder: parsed.data.sortOrder,
    });
    return NextResponse.json({ task });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Task create failed");
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    // Student bar: "status" ticks are the one student-allowed mutation
    // (CM-22); the lib enforces the higher counselor bar (and the student-
    // owned-task rule) per action from the CaseAccess passed in.
    const access = await requireCaseAccess(user.email, caseId, "student");
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = patchTaskSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    switch (parsed.data.action) {
      case "status": {
        const task = await updateTaskStatus({
          access,
          taskId: parsed.data.taskId,
          status: parsed.data.status,
        });
        return NextResponse.json({ task });
      }
      case "verify": {
        const task = await setTaskVerified({
          access,
          taskId: parsed.data.taskId,
          verified: parsed.data.verified,
          expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        });
        return NextResponse.json({ task });
      }
      case "update": {
        const task = await updateTask({
          access,
          taskId: parsed.data.taskId,
          expectedUpdatedAt: parsed.data.expectedUpdatedAt,
          title: parsed.data.title,
          description: parsed.data.description,
          owner: parsed.data.owner,
          dueDate: parsed.data.dueDate,
          recurrence: parsed.data.recurrence,
          sortOrder: parsed.data.sortOrder,
        });
        return NextResponse.json({ task });
      }
      case "delete": {
        await softDeleteTask({
          access,
          taskId: parsed.data.taskId,
          expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        });
        return NextResponse.json({ ok: true });
      }
    }
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Task update failed");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);

    const parsed = deleteQuerySchema.safeParse({
      taskId: new URL(request.url).searchParams.get("taskId"),
      expectedUpdatedAt: new URL(request.url).searchParams.get("expectedUpdatedAt"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    await softDeleteTask({
      access,
      taskId: parsed.data.taskId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Task delete failed");
  }
}
