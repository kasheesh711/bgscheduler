import { AppNav } from "@/components/layout/app-nav";
import { StaleSnapshotBanner } from "@/components/layout/stale-snapshot-banner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppNav />
      <StaleSnapshotBanner />
      <main className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-3">{children}</main>
    </>
  );
}
