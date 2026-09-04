import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getFootTrafficReportSnapshot } from "@/lib/onsite-foot-traffic/data";
import { footTrafficReportFilename, renderFootTrafficReportHtml } from "@/lib/onsite-foot-traffic/report";

export const maxDuration = 120;

export async function GET(
  _request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { reportId } = await context.params;
  try {
    const snapshot = await getFootTrafficReportSnapshot(getDb(), reportId);
    if (!snapshot) return NextResponse.json({ error: "Report snapshot not found or expired" }, { status: 404 });
    const html = renderFootTrafficReportHtml(snapshot);
    const { renderFootTrafficPdf } = await import("@/lib/onsite-foot-traffic/pdf");
    const pdf = await renderFootTrafficPdf(html);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${footTrafficReportFilename(snapshot, "pdf")}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to render PDF report";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
