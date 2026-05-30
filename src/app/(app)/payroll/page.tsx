import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PayrollDashboard } from "@/components/payroll/payroll-dashboard";

async function PayrollBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }
  return <PayrollDashboard />;
}

export default function PayrollPage() {
  return (
    <Suspense fallback={null}>
      <PayrollBody />
    </Suspense>
  );
}
