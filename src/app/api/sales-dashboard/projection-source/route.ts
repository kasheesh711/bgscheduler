import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  seedDefaultSalesDashboardProjectionSource,
  upsertSalesDashboardProjectionSource,
} from "@/lib/sales-dashboard/data";

const ProjectionSourceInputSchema = z.object({
  spreadsheetUrl: z.string().min(1).optional(),
  summarySheetName: z.string().optional(),
  whatIfSheetName: z.string().optional(),
  calcMultiSheetName: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const input = ProjectionSourceInputSchema.parse(await request.json());
    const source = input.spreadsheetUrl
      ? await upsertSalesDashboardProjectionSource({
        spreadsheetUrl: input.spreadsheetUrl,
        summarySheetName: input.summarySheetName,
        whatIfSheetName: input.whatIfSheetName,
        calcMultiSheetName: input.calcMultiSheetName,
        connectedEmail: session.user.email,
        actorEmail: session.user.email,
      })
      : await seedDefaultSalesDashboardProjectionSource(session.user.email);
    return NextResponse.json({ source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save projection source";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
