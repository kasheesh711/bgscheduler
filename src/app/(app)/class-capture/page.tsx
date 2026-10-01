import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ClassCaptureWorkspace } from "@/components/class-capture/class-capture-workspace";
import { captureEnabled } from "@/lib/class-capture/model";
import { requireCaptureScope } from "@/lib/class-capture/sessions";

export const metadata = { title: "Class Capture | BeGifted Ops" };

async function ClassCaptureBody() {
  const scope = await requireCaptureScope().catch(() => null);
  if (!scope) redirect("/");
  return <ClassCaptureWorkspace ownerEmail={scope.email} enabled={captureEnabled()} />;
}

export default function ClassCapturePage() {
  return <Suspense fallback={<p role="status" className="py-10 text-center text-sm text-muted-foreground">Loading class capture…</p>}><ClassCaptureBody /></Suspense>;
}
