import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LineReviewWorkspace } from "@/components/line-review/line-review-workspace";

async function LineReviewBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  return <LineReviewWorkspace />;
}

export default function LineReviewPage() {
  return (
    <Suspense fallback={null}>
      <LineReviewBody />
    </Suspense>
  );
}
