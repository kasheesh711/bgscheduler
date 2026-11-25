import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { hiringError } from "@/lib/hiring/http";
import { printToken } from "@/lib/hiring/print-pack";

const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), candidate: z.uuid().optional() });

/** The Hiring page's Print all and Print paper: opens the day's print page with a fresh link. */
export async function GET(request: NextRequest) {
  try {
    await requireHiringAdmin();
    const { date, candidate } = query.parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.redirect(new URL(`/hiring/print/${printToken(date, candidate ?? null)}`, request.nextUrl.origin), 303);
  } catch (error) {
    return hiringError(error);
  }
}
