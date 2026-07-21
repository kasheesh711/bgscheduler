import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PostClassFeedbackWorkspace } from "@/components/post-class-feedback/post-class-feedback-workspace";
import { auth } from "@/lib/auth";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";

async function PostClassFeedbackBody() {
  const session = await auth();
    if (!session?.user?.email) {
      redirect("/login");
    }
    try {
      await requirePostClassCapability("viewer");
    } catch {
      redirect("/");
    }

  return <PostClassFeedbackWorkspace />;
}

export default function PostClassFeedbackPage() {
  return (
    <Suspense fallback={null}>
      <PostClassFeedbackBody />
    </Suspense>
  );
}
