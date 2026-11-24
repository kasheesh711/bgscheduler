import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { headKeyFor, requireHiringAdmin } from "@/lib/hiring/access";
import { HiringError } from "@/lib/hiring/model";
import { headKeys } from "@/lib/hiring/role-views";
import { settings } from "@/lib/hiring/service";
import { HiringDashboard } from "@/components/hiring/dashboard";
export const metadata = { title: "Tutor Hiring | BeGifted Ops" };
async function Body() {
  let email: string;
  try {
    email = await requireHiringAdmin();
  } catch (error) {
    if (error instanceof HiringError && error.status === 401)
      redirect("/login?callbackUrl=%2Fhiring");
    return <p className="p-6">Hiring access is required.</p>;
  }
  // A head sees their own screen while the data loads, not the full dashboard (Kevin, 24 Nov 2026).
  const { config } = await settings(getDb());
  return <HiringDashboard head={await headKeyFor(email, headKeys(config))} />;
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
