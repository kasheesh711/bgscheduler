import { Suspense } from "react";
import { HiringBooking } from "@/components/hiring/booking";
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
        <p role="status" className="p-6">
          Loading booking…
        </p>
      }
    >
      <Body {...props} />
    </Suspense>
  );
}
