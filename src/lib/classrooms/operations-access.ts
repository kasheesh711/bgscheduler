import "server-only";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
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

/**
 * Any current admin (not just Kevin) may sync, run and publish. Unlike
 * requireClassroomOperationsOwner, this does not separately re-check
 * adminUsers.disabled/accessVersion -- src/lib/auth-session.ts's
 * validateSessionAccess (shared by server auth() and src/proxy.ts) already
 * re-validates disabled/version on every request before a handler runs, so a
 * plain session-role check here is sufficient.
 */
export async function requireClassroomAdmin() {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) throw new AdminUsersAccessError("Unauthorized", 401);
  if (session?.user?.role !== "admin") {
    throw new AdminUsersAccessError("Only an admin can sync Wise, run assignments, or publish rooms.", 403);
  }
  return { email };
}

export function classroomOperationsAccessError(error: unknown) {
  if (error instanceof AdminUsersAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("Classroom operations access check failed", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "Unable to verify classroom operations access." }, { status: 500 });
}
