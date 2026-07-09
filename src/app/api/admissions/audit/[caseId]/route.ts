import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  AUDIT_LOG_DEFAULT_PAGE_SIZE,
  AUDIT_LOG_MAX_PAGE_SIZE,
  listCaseAuditLog,
} from "@/lib/admissions/audit";

const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_LOG_MAX_PAGE_SIZE)
    .default(AUDIT_LOG_DEFAULT_PAGE_SIZE),
});

/**
 * GET /api/admissions/audit/[caseId] — one page of a case's audit trail,
 * newest first (admin only, design §4).
 *
 * 1. Session guard: only an admin session may even attempt the read (JWT
 *    fast-fail; counselors/students/parents get 403).
 * 2. requireCaseAccess re-verifies admin standing against admin_users on this
 *    request and 404s a missing/soft-deleted case (admins may learn existence;
 *    a malformed caseId fails closed as 403).
 * 3. Pagination params are coerced/bounded by Zod (?page=, ?pageSize=).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    if (user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { caseId } = await params;
    await requireCaseAccess(user.email, caseId, "admin");

    const searchParams = request.nextUrl.searchParams;
    const parsed = AuditQuerySchema.safeParse({
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const auditPage = await listCaseAuditLog(caseId, parsed.data);
    return NextResponse.json(auditPage);
  } catch (error) {
    return admissionsErrorResponse(
      "/api/admissions/audit/[caseId]",
      error,
      "Audit trail load failed",
    );
  }
}
