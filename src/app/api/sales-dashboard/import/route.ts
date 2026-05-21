import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  importAllSalesSources,
  importRefreshableSalesSources,
  importSalesDashboardSource,
} from "@/lib/sales-dashboard/data";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";

export const maxDuration = 800;

const ImportSchema = z.object({
  sourceId: z.string().uuid().optional(),
  mode: z.enum(["source", "backfill", "refreshable"]).optional(),
  allowFinalized: z.boolean().optional(),
});

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Sales dashboard import failed";
  const status = error instanceof MissingGoogleSheetsTokenError ? 409 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const input = ImportSchema.parse(await request.json());
    if (input.mode === "backfill") {
      const results = await importAllSalesSources(session.user.email);
      return NextResponse.json({ ok: true, results });
    }
    if (input.sourceId) {
      const result = await importSalesDashboardSource(input.sourceId, {
        triggerType: "manual",
        actorEmail: session.user.email,
        allowFinalized: input.allowFinalized,
      });
      return NextResponse.json({ ok: true, result });
    }
    const results = await importRefreshableSalesSources({
      triggerType: "manual",
      actorEmail: session.user.email,
    });
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return errorResponse(error);
  }
}
