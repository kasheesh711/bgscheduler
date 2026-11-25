import { Suspense } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { BookingShell } from "@/components/hiring/booking";
import { PrintPack } from "@/components/hiring/print-pack";
import { getDb } from "@/lib/db";
import { HiringError, ZONE } from "@/lib/hiring/model";
import { printItems, readPrintToken } from "@/lib/hiring/print-pack";

// Public: Aya opens this from the 08:30 LINE message, with no session. The token in the path is the only access
// (readPrintToken). Reachability needs the `/hiring/print/` entry in src/proxy.ts.
export const metadata = {
  title: "Print papers | BeGifted",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

type Props = { params: Promise<{ token: string }> };

async function Body({ params }: Props) {
  const { token } = await params;
  let date: string, items: Awaited<ReturnType<typeof printItems>>;
  try {
    const link = readPrintToken(token);
    date = link.date;
    items = await printItems(getDb(), link.date, link.candidateId);
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    return <p role="alert">This print link is invalid or has expired. Open a new one from the Hiring page.</p>;
  }
  const day = formatInTimeZone(new Date(`${date}T12:00:00+07:00`), ZONE, "EEEE d MMMM");
  const rows = items.map((i) => ({ key: `${i.candidateId}@${i.start.getTime()}`, name: i.name, subject: i.subject, time: formatInTimeZone(i.start, ZONE, "HH:mm"), fileId: i.fileId }));
  return <PrintPack token={token} date={day} rows={rows} />;
}

export default function Page(props: Props) {
  return (
    <BookingShell kind="print">
      <Suspense fallback={<p role="status">Loading the paper tests…</p>}>
        <Body {...props} />
      </Suspense>
    </BookingShell>
  );
}
