import { creditControlActive } from "@/lib/credit-control/mode";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardShell } from "@/components/credit-control/dashboard-shell";

async function CreditControlBody() {
  const session = await auth();
  if (!session?.user?.email || !session.user.name) {
    redirect("/login");
  }

  if (!creditControlActive()) return <section className="mx-auto w-full max-w-xl space-y-3 p-8"><h1 className="text-2xl font-semibold">Credit Control is temporarily retired</h1><p>Student schedules, Parent Reports, LINE and Progress Tests remain available. Shared student data refreshes daily.</p></section>;

  return (
    <DashboardShell
      sessionUser={{
        email: session.user.email,
        name: session.user.name,
      }}
    />
  );
}

export default function CreditControlPage() {
  return (
    <Suspense fallback={null}>
      <CreditControlBody />
    </Suspense>
  );
}
