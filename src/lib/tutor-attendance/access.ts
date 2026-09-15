import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  adminUsers,
  tutorAttendanceEnrollments,
  tutorContacts,
} from "@/lib/db/schema";
import { hasPageAccess } from "@/lib/progress-tests/page-access";
import { ATTENDANCE_ROUTE, AttendanceError } from "./model";

export type AttendanceAccess = {
  email: string;
  admin: boolean;
  canonicalKey: string | null;
  adminAccessVersion?: number;
};
export async function attendanceEnrollmentForEmail(
  email: string,
  db: Database = getDb(),
) {
  const rows = await db
    .select({ enrollment: tutorAttendanceEnrollments })
    .from(tutorAttendanceEnrollments)
    .innerJoin(
      tutorContacts,
      eq(tutorContacts.canonicalKey, tutorAttendanceEnrollments.canonicalKey),
    )
    .where(
      and(
        eq(tutorAttendanceEnrollments.active, true),
        eq(tutorContacts.active, true),
        sql`lower(btrim(${tutorAttendanceEnrollments.loginEmail})) = ${email.trim().toLowerCase()}`,
      ),
    );
  return rows.length === 1 ? rows[0].enrollment : null;
}
export async function attendanceAccessForEmail(
  email: string,
  db: Database = getDb(),
): Promise<AttendanceAccess> {
  const normalized = email.trim().toLowerCase();
  const [admin] = await db
    .select()
    .from(adminUsers)
    .where(sql`lower(btrim(${adminUsers.email})) = ${normalized}`)
    .limit(1);
  if (admin?.disabled)
    throw new AttendanceError(403, "Your access has been revoked.");
  const enrollment = await attendanceEnrollmentForEmail(normalized, db);
  const canManage =
    !!admin && hasPageAccess(admin.allowedPages, ATTENDANCE_ROUTE);
  if (!canManage && !enrollment)
    throw new AttendanceError(
      403,
      "Office attendance is available to enrolled full-time tutors and authorized administrators.",
    );
  return {
    email: normalized,
    admin: canManage,
    canonicalKey: enrollment?.canonicalKey ?? null,
    ...(admin ? { adminAccessVersion: admin.accessVersion } : {}),
  };
}
export async function freshAttendanceAccess(
  previous: AttendanceAccess,
  db: Database,
) {
  const current = await attendanceAccessForEmail(previous.email, db);
  if (
    current.adminAccessVersion !== previous.adminAccessVersion ||
    current.admin !== previous.admin ||
    current.canonicalKey !== previous.canonicalKey
  ) {
    throw new AttendanceError(
      403,
      "Your access changed. Refresh this page and sign in again if needed.",
    );
  }
  return current;
}
export async function requireAttendanceAccess() {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user.email)
    throw new AttendanceError(
      401,
      "Please sign in with your approved Google account.",
    );
  return attendanceAccessForEmail(session.user.email);
}
export async function canUseAttendance(email: string): Promise<boolean> {
  try {
    await attendanceAccessForEmail(email);
    return true;
  } catch {
    return false;
  }
}
export function requireAttendanceAdmin(access: AttendanceAccess) {
  if (!access.admin)
    throw new AttendanceError(403, "Administrator access is required.");
}
