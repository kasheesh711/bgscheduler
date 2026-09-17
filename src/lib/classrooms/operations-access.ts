import "server-only";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { AdminUsersAccessError } from "@/lib/admin-users/types";
import { isClassroomOperationsOwner } from "./operations-policy";

export async function requireClassroomOperationsOwner() {
  const actor = await requireSuperAdmin();
  if (!isClassroomOperationsOwner(actor.email)) {
    throw new AdminUsersAccessError("Only Kevin can sync Wise, run assignments, or publish rooms.", 403);
  }
  return actor;
}

export function classroomOperationsAccessError(error: unknown) {
  if (error instanceof AdminUsersAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("Classroom operations access check failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "Unable to verify classroom operations access." }, { status: 500 });
}
