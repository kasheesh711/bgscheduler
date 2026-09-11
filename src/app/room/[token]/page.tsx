import { Suspense } from "react";
import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { getRoomDayView, resolveRoomLink } from "@/lib/room-booking/service";
import { RoomMobileWorkspace } from "@/components/room-booking/mobile-workspace";
export const metadata: Metadata = {
  title: { absolute: "BeGifted · Tutor rooms" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
async function RoomPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let initial;
  try {
    const userId = await resolveRoomLink(getDb(), token);
    initial = await getRoomDayView(getDb(), userId);
  } catch {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <div className="max-w-sm rounded-xl border bg-card p-6">
          <h1 className="text-xl font-semibold">Open a new room link</h1>
          <p className="mt-3 text-muted-foreground">
            This link is unavailable or has expired. Send{" "}
            <strong>/room web</strong> privately in LINE. If the problem
            persists, ask an admin to check your tutor access.
          </p>
        </div>
      </main>
    );
  }
  return <RoomMobileWorkspace token={token} initial={initial} />;
}
export default function Page(props: { params: Promise<{ token: string }> }) {
  return (
    <Suspense
      fallback={
        <main className="min-h-0 flex-1 overflow-auto p-8" role="status">
          Loading your rooms…
        </main>
      }
    >
      <RoomPage {...props} />
    </Suspense>
  );
}
