import { Suspense } from "react";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import {
  defaultQuarter,
  quarterSchema,
  SitInError,
} from "@/lib/tutor-sit-ins/model";
import { SitInDashboard } from "@/components/tutor-sit-ins/dashboard";
type Props = { searchParams: Promise<{ quarter?: string; calendar?: string }> };
async function Body({ searchParams }: Props) {
  let access;
  try {
    access = await requireSitInAccess();
  } catch (e) {
    if (e instanceof SitInError)
      return (
        <div role="alert" className="rounded-lg border p-6">
          {e.message}
        </div>
      );
    throw e;
  }
  const search = await searchParams;
  const parsed = quarterSchema.safeParse(search.quarter || defaultQuarter());
  return (
    <SitInDashboard
      access={access}
      initialQuarter={parsed.success ? parsed.data : defaultQuarter()}
      calendarResult={search.calendar}
    />
  );
}
export default function Page(props: Props) {
  return (
    <Suspense fallback={<div className="p-8">Loading Tutor Sit-ins…</div>}>
      <Body {...props} />
    </Suspense>
  );
}
