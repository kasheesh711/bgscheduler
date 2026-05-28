import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  archiveSalesDashboardSource,
  updateSalesDashboardSourceStatus,
} from "@/lib/sales-dashboard/data";

const PatchSchema = z.object({
  status: z.enum(["active", "finalized", "reopened"]),
});

type SourceRouteContext = { params: Promise<{ sourceId: string }> };

export async function PATCH(request: NextRequest, ctx: SourceRouteContext) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sourceId } = await ctx.params;
    const input = PatchSchema.parse(await request.json());
    const source = await updateSalesDashboardSourceStatus(sourceId, input.status, session.user.email);
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
    return NextResponse.json({ source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update source";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: NextRequest, ctx: SourceRouteContext) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sourceId } = await ctx.params;
    const source = await archiveSalesDashboardSource(sourceId, session.user.email);
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
    return NextResponse.json({ ok: true, source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to archive source";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
