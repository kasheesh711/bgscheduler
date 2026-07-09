// /admissions — counselor/admin caseload workspace (design §5.1) + role
// routing for the family portals (design §5.2/§5.3).
//
// Authz-scoped page: data is fetched with the session email via direct lib
// calls — deliberately NO "use cache" here, since the caseload differs per
// user and must never be cached cross-user. getCaseloadForUser is itself
// fail-closed (non-admin, non-counselor → empty list). Students and parents
// are routed to their own case page (the mobile-first student portal /
// parent dashboard); a family member with no live case gets a friendly
// empty state. Any other role (e.g. teacher) is denied (fail-closed).

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ShieldAlert, UserRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import {
  getCaseIdForParentEmail,
  getCaseIdForStudentEmail,
  getCaseloadForUser,
} from "@/lib/admissions/cases";
import { listCohorts } from "@/lib/admissions/cohorts";
import { listCounselors } from "@/lib/admissions/counselors";
import { CaseloadShell, CaseloadSkeleton } from "@/components/admissions/caseload-shell";

function NoCaseYetCard() {
  return (
    <div className="mx-auto mt-8 w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserRound aria-hidden className="size-4 text-primary" />
            No case yet
          </CardTitle>
          <CardDescription>
            Your admissions case has not been set up yet. Your counselor will
            invite you as soon as it is ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          If you think this is a mistake, reach out to your counselor directly.
        </CardContent>
      </Card>
    </div>
  );
}

function NoAccessCard() {
  return (
    <div className="mx-auto mt-8 w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert aria-hidden className="size-4 text-conflict" />
            No access
          </CardTitle>
          <CardDescription>
            Your account does not have access to the Admissions workspace.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

async function AdmissionsBody() {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) {
    redirect("/login");
  }

  const role = session?.user?.role ?? null;
  if (role === "student") {
    // Student portal routing (design §5.2): land students on their own case.
    // The case page re-runs requireCaseAccess, so this lookup only decides
    // where to send them — never what they may see.
    const studentCaseId = await getCaseIdForStudentEmail(email);
    if (studentCaseId) {
      redirect(`/admissions/${studentCaseId}`);
    }
    return <NoCaseYetCard />;
  }
  if (role === "parent") {
    // Parent dashboard routing (design §5.3): land parents on their child's
    // case. The case page re-runs requireCaseAccess and renders ONLY the
    // parent projection for parent members — this lookup never grants rights.
    const parentCaseId = await getCaseIdForParentEmail(email);
    if (parentCaseId) {
      redirect(`/admissions/${parentCaseId}`);
    }
    return <NoCaseYetCard />;
  }
  // Caseload renders only for counselors and admins (role null = legacy
  // full-access admin). Anything else — e.g. teacher — is denied, fail-closed.
  if (role !== null && role !== "admin" && role !== "counselor") {
    return <NoAccessCard />;
  }

  const [caseload, cohorts, counselors] = await Promise.all([
    getCaseloadForUser(email),
    listCohorts(),
    listCounselors(),
  ]);

  return <CaseloadShell caseload={caseload} cohorts={cohorts} counselors={counselors} />;
}

export default function AdmissionsPage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <Suspense fallback={<CaseloadSkeleton />}>
        <AdmissionsBody />
      </Suspense>
    </div>
  );
}
