import { Suspense } from "react";
import { BookingLoading, BookingShell, HiringBooking } from "@/components/hiring/booking";
export const metadata = {
  title: "Book your assessment | BeGifted",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
async function Body({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <HiringBooking token={token} />;
}
export default function Page(props: { params: Promise<{ token: string }> }) {
  return (
    <Suspense
      fallback={
        <BookingShell>
          <BookingLoading />
        </BookingShell>
      }
    >
      <Body {...props} />
    </Suspense>
  );
}
