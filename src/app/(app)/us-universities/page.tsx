import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUsUniversitiesOverview } from "@/lib/us-universities/data";
import { UsUniversitiesShell } from "@/components/us-universities/us-universities-shell";
import { UsUniversitiesSkeleton } from "@/components/us-universities/loading-skeleton";

async function UsUniversitiesBody() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  const overview = await getUsUniversitiesOverview();
  return <UsUniversitiesShell overview={overview} />;
}

export default function UsUniversitiesPage() {
  return (
    <Suspense fallback={<UsUniversitiesSkeleton />}>
      <UsUniversitiesBody />
    </Suspense>
  );
}
