import { Suspense } from "react";
import { CaptureQueue } from "@/components/post-class-feedback/capture-queue";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { z } from "zod";

type Props = { searchParams: Promise<{ date?: string; sessionId?: string }> };
async function EvidenceBody({ searchParams }: Props) {
  const user = await requirePostClassCapability("viewer");
  const params = await searchParams;
  return <CaptureQueue canUpload={user.capabilities.includes("reviewer")} initialDate={z.iso.date().parse(params.date ?? todayBangkok())} sessionId={params.sessionId ? z.uuid().parse(params.sessionId) : null} />;
}
export default function EvidencePage(props: Props) { return <Suspense fallback={<p>Loading evidence…</p>}><EvidenceBody {...props} /></Suspense>; }
