import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { HiringError } from "@/lib/hiring/model";
import { HiringDashboard } from "@/components/hiring/dashboard";
export const metadata = { title: "Tutor Hiring | BeGifted Ops" };
async function Body() {
  try {
    await requireHiringAdmin();
  } catch (error) {
    if (error instanceof HiringError && error.status === 401)
      redirect("/login?callbackUrl=%2Fhiring");
    return <p className="p-6">Hiring access is required.</p>;
  }
  return <HiringDashboard />;
}
export default function Page() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6">
          Loading hiring…
        </p>
      }
    >
      <Body />
    </Suspense>
  );
}
