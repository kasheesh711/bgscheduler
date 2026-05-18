import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardShell } from "@/components/credit-control/dashboard-shell";

async function CreditControlBody() {
  const session = await auth();
  if (!session?.user?.email || !session.user.name) {
    redirect("/login");
  }

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
