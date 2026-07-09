// /admissions — counselor/admin caseload workspace (design §5.1).
//
// Authz-scoped page: data is fetched with the session email via direct lib
// calls — deliberately NO "use cache" here, since the caseload differs per
// user and must never be cached cross-user. getCaseloadForUser is itself
// fail-closed (non-admin, non-counselor → empty list). Students and parents
// land on a placeholder card until their portal ships in a later phase;
// any other role (e.g. teacher) is denied (fail-closed).

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Clock, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getCaseloadForUser } from "@/lib/admissions/cases";
import { listCohorts } from "@/lib/admissions/cohorts";
import { listCounselors } from "@/lib/admissions/counselors";
import { CaseloadShell, CaseloadSkeleton } from "@/components/admissions/caseload-shell";

function PortalComingSoonCard() {
  return (
    <div className="mx-auto mt-8 w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock aria-hidden className="size-4 text-primary" />
            Your portal is coming soon
          </CardTitle>
          <CardDescription>
            The student and parent admissions portal is being built. Your counselor will let you
            know as soon as it is ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          In the meantime, reach out to your counselor directly with any questions about your
          application plan.
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
  if (role === "student" || role === "parent") {
    return <PortalComingSoonCard />;
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
