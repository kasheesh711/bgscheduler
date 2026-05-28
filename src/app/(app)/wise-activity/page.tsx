import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { WiseActivityWorkspace } from "@/components/wise-activity/wise-activity-workspace";

async function WiseActivityBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  return <WiseActivityWorkspace />;
}

export default function WiseActivityPage() {
  return (
    <Suspense fallback={null}>
      <WiseActivityBody />
    </Suspense>
  );
}
