import { Suspense } from "react";
import { z } from "zod";
import { notFound } from "next/navigation";
import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import { SitInError } from "@/lib/tutor-sit-ins/model";
import { SitInDetail } from "@/components/tutor-sit-ins/detail";
type Props = { params: Promise<{ assignmentId: string }> };
async function Body({ params }: Props) {
  try {
    await requireSitInAccess();
  } catch (e) {
    if (e instanceof SitInError)
      return (
        <div role="alert" className="rounded-lg border p-6">
          {e.message}
        </div>
      );
    throw e;
  }
  const parsed = z.uuid().safeParse((await params).assignmentId);
  if (!parsed.success) notFound();
  return <SitInDetail id={parsed.data} />;
}
export default function Page(props: Props) {
  return (
    <Suspense fallback={<div className="p-8">Loading observation…</div>}>
      <Body {...props} />
    </Suspense>
  );
}
