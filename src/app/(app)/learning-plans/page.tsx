import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { LearningPlanForm } from "@/components/learning-plan/learning-plan-form";
import { auth } from "@/lib/auth";
import { hasLearningPlansAccess } from "@/lib/learning-plans/access-policy";

async function LearningPlansBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }
  if (
    !hasLearningPlansAccess(
      session.user.allowedPages,
      session.user.role,
    )
  ) {
    notFound();
  }

  return (
    <div className="begifted -mx-4 -my-3 min-h-0 flex-1 overflow-y-auto bg-white lg:-mx-6">
      <LearningPlanForm />
    </div>
  );
}

function LearningPlansSkeleton() {
  return (
    <div className="-mx-4 -my-3 min-h-0 flex-1 animate-pulse bg-white lg:-mx-6" />
  );
}

export const metadata: Metadata = {
  title: "BeGifted Learning Plan",
  description:
    "Generate a BeGifted-branded General Mathematics learning plan by year group.",
  robots: { index: false, follow: false },
};

export default function LearningPlansPage() {
  return (
    <Suspense fallback={<LearningPlansSkeleton />}>
      <LearningPlansBody />
    </Suspense>
  );
}
