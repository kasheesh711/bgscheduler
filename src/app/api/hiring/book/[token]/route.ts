import { NextResponse } from "next/server";
import { subjectSchema } from "@/lib/hiring/model";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { bookInterview, bookingView, bookVisit, visitView } from "@/lib/hiring/service";
import { readBookingToken } from "@/lib/hiring/tokens";
export const maxDuration = 120;
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    if (readBookingToken(token).kind === "visit")
      return NextResponse.json(await visitView(token), { headers });
    const names = new URL(request.url).searchParams.getAll("subject");
    const subjects = names.length
      ? names.map((v) => subjectSchema.parse(v))
      : undefined;
    return NextResponse.json(await bookingView(token, subjects), { headers });
  } catch (error) {
    return hiringError(error);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    requireSameOrigin(request);
    const { token } = await params;
    const book = readBookingToken(token).kind === "visit" ? bookVisit : bookInterview;
    const booking = await book(token, await request.json());
    return NextResponse.json(
      {
        id: booking.id,
        kind: booking.kind,
        subjects: booking.subjects,
        start: booking.startTime.toISOString(),
        end: booking.endTime.toISOString(),
      },
      { headers },
    );
  } catch (error) {
    return hiringError(error);
  }
}
