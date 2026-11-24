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
  // A head sees their own screen while the data loads, not the full dashboard (Kevin, 24 Nov 2026). This is a
  // shortcut only: if the settings cannot be read here, the dashboard still opens and reports the problem itself.
  let head: string | null = null;
  try {
    const { config } = await settings(getDb());
    head = await headKeyFor(email, headKeys(config));
  } catch (error) {
    // Next's own signal that the render was abandoned is passed on, never swallowed (code review, round 20).
    if (typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION") throw error;
    console.error("[hiring] head shortcut skipped", error instanceof Error ? error.name : "UnknownError");
  }
  return <HiringDashboard head={head} />;
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
