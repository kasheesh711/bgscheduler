import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  listSalesDashboardSources,
  upsertSalesDashboardSource,
} from "@/lib/sales-dashboard/data";

const SourceInputSchema = z.object({
  spreadsheetUrl: z.string().min(1),
  sourceMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  label: z.string().optional(),
  normalSheetName: z.string().optional(),
  additionalSheetName: z.string().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sources = await listSalesDashboardSources(getDb());
    return NextResponse.json({ sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list sales dashboard sources";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const input = SourceInputSchema.parse(await request.json());
    const source = await upsertSalesDashboardSource({
      ...input,
      sourceMonth: input.sourceMonth.slice(0, 7),
      connectedEmail: session.user.email,
      actorEmail: session.user.email,
    });
    return NextResponse.json({ source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save sales dashboard source";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
