import { connection, NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUnearnedRevenueCapability } from "@/lib/unearned-revenue/access";
import { unearnedRevenueErrorResponse } from "@/lib/unearned-revenue/api";
import { getUnearnedRevenueDashboard } from "@/lib/unearned-revenue/data";

const querySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().trim().max(120).default(""),
  scope: z.enum(["positive", "all"]).default("positive"),
  attribution: z.enum(["all", "attributed", "residual", "ambiguous", "unattributed"]).default("all"),
  review: z.enum(["all", "needs_review", "clear"]).default("all"),
  sort: z.enum(["liability_desc", "liability_asc", "name_asc", "credits_desc"]).default("liability_desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: NextRequest) {
  // Keep Next's prerender bailout outside the domain error handler. Catching
  // the internal headers() suspension would log a false API error at build time.
  await connection();
  try {
    const user = await requireUnearnedRevenueCapability("viewer");
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    return NextResponse.json(await getUnearnedRevenueDashboard(query, user.capabilities));
  } catch (error) {
    return unearnedRevenueErrorResponse("GET /api/unearned-revenue", error);
  }
}
