import { AppNav } from "@/components/layout/app-nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppNav />
      <main className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-3">{children}</main>
    </>
  );
}
