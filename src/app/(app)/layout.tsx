import { AppNav } from "@/components/layout/app-nav";
import { StaleSnapshotBanner } from "@/components/layout/stale-snapshot-banner";
import { auth } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <>
      <AppNav allowedPages={session?.user?.allowedPages ?? null} />
      <StaleSnapshotBanner />
      <main className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-3">{children}</main>
    </>
  );
}
