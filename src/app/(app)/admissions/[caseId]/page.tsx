import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { requireCaseAccess } from "@/lib/admissions/access";
import { getCaseDetail } from "@/lib/admissions/cases";
import { roleAtLeast } from "@/lib/admissions/config";
import { listMeetings } from "@/lib/admissions/meetings";
import { listNotesForRole } from "@/lib/admissions/notes";
import {
  CaseDetailShell,
  CaseDetailSkeleton,
} from "@/components/admissions/case-detail-shell";
import type {
  AdmissionsCaseDetail,
  AdmissionsMeetingDto,
  AdmissionsNoteDto,
  CaseAccess,
} from "@/lib/admissions/types";

// Per-request membership checks + fresh reads on every navigation — this page
// deliberately does NOT use "use cache" (revocation must be instant, §2.2).

async function CaseDetailBody({ caseId }: { caseId: string }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    redirect("/login");
  }

  // Server-side access gate (design §2.2): membership is re-resolved from
  // Postgres on every request. Forbidden → back to the caseload (existence
  // never leaks to non-members); NotFound (admin-only) → 404.
  let access: CaseAccess;
  try {
    access = await requireCaseAccess(email, caseId, "parent");
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }
    if (error instanceof Error && error.message === "Forbidden") {
      redirect("/admissions");
    }
    if (error instanceof Error && error.message === "NotFound") {
      notFound();
    }
    throw error;
  }

  const isStaff = roleAtLeast(access.role, "counselor");
  let caseDetail: AdmissionsCaseDetail;
  let notes: AdmissionsNoteDto[];
  let meetings: AdmissionsMeetingDto[];
  try {
    [caseDetail, notes, meetings] = await Promise.all([
      getCaseDetail(caseId),
      // Role-shaped: family readers only ever receive shared_with_family rows.
      listNotesForRole(caseId, access.role),
      // The meeting log is staff-only (design §4); family viewers get none.
      isStaff ? listMeetings(caseId) : Promise.resolve([]),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "NotFound") {
      notFound();
    }
    throw error;
  }

  return (
    <CaseDetailShell
      caseDetail={caseDetail}
      meetings={meetings}
      notes={notes}
      viewerRole={access.role}
      viewerEmail={access.email}
    />
  );
}

export default async function AdmissionsCaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;

  return (
    <Suspense fallback={<CaseDetailSkeleton />}>
      <CaseDetailBody caseId={caseId} />
    </Suspense>
  );
}
