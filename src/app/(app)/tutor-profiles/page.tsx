import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TutorProfilesWorkspace } from "@/components/tutor-profiles/tutor-profiles-workspace";

async function TutorProfilesBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  return <TutorProfilesWorkspace />;
}

export default function TutorProfilesPage() {
  return (
    <Suspense fallback={null}>
      <TutorProfilesBody />
    </Suspense>
  );
}
