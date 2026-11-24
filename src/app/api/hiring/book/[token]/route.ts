import { after, NextResponse } from "next/server";
import { subjectSchema } from "@/lib/hiring/model";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";
import { answerPreScreen, bookCall, bookContract, contractView, bookInterview, bookingView, bookVisit, callView, visitView } from "@/lib/hiring/service";
import { readBookingToken } from "@/lib/hiring/tokens";
import { deliverBookingMessages, deliverVisitInvite } from "@/lib/hiring/worker";
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
    const kind = readBookingToken(token).kind;
    if ((kind === "visit" || kind === "paper-visit" || kind === "two-day"))
      return NextResponse.json(await visitView(token), { headers });
    if (kind === "contract")
      return NextResponse.json(await contractView(token), { headers });
    if (kind === "call")
      return NextResponse.json(await callView(token), { headers });
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
    const kind = readBookingToken(token).kind;
    const visit = kind === "visit" || kind === "paper-visit" || kind === "two-day";
    const body = await request.json();
    // The questions step of a "Next steps" link. The page reloads the view, which shows the times or the reason for none.
    if (visit && body && typeof body === "object" && "answers" in body) {
      const { opened, candidateId } = await answerPreScreen(token, body.answers);
      // The "booking is open" email leaves at once, so the candidate holds the link and the weekly count stays true.
      if (opened) after(() => deliverVisitInvite(candidateId));
      return NextResponse.json({ opened }, { headers });
    }
    const book = visit ? bookVisit : kind === "call" ? bookCall : kind === "contract" ? bookContract : bookInterview;
    const booking = await book(token, body);
    after(() => deliverBookingMessages());
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
