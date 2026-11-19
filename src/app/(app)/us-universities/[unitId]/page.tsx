import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getInstitutionProfile } from "@/lib/us-universities/data";
import { InstitutionDossier } from "@/components/us-universities/institution-dossier";
import DossierLoading from "./loading";

/** Positive integer unit id, or null. */
export function parseUnitId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function DossierBody({ unitId }: { unitId: number }) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }

  const profile = await getInstitutionProfile(unitId);
  if (!profile) {
    notFound();
  }

  return <InstitutionDossier profile={profile} />;
}

export default async function InstitutionDossierPage({
  params,
}: {
  params: Promise<{ unitId: string }>;
}) {
  const { unitId } = await params;
  const parsed = parseUnitId(unitId);
  if (parsed == null) {
    notFound();
  }

  return (
    <Suspense fallback={<DossierLoading />}>
      <DossierBody unitId={parsed} />
    </Suspense>
  );
}
