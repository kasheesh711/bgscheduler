import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { resolveTheaLink, theaPrivateHeaders } from "@/lib/classrooms/thea-weekend";
import { renderTheaPdf } from "@/lib/classrooms/thea-pdf";

export const maxDuration = 300;
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const grant = await resolveTheaLink(getDb(), token);
  if (!grant) return new NextResponse("This schedule link is unavailable. Request a new link in BG The Loop.", { status: 404, headers: theaPrivateHeaders });
  try {
    const pdf = await renderTheaPdf(token);
    return new NextResponse(new Uint8Array(pdf), { headers: { ...theaPrivateHeaders, "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="Thea-weekend-schedule.pdf"' } });
  } catch {
    return new NextResponse("The schedule could not be verified. Please retry or request a new link.", { status: 503, headers: theaPrivateHeaders });
  }
}
