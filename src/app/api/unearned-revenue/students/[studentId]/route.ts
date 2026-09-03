import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUnearnedRevenueCapability } from "@/lib/unearned-revenue/access";
import { unearnedRevenueErrorResponse } from "@/lib/unearned-revenue/api";
import { getUnearnedRevenueStudentDetail } from "@/lib/unearned-revenue/data";

const paramsSchema = z.object({ studentId: z.string().trim().min(1).max(200) });
const querySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ studentId: string }> },
) {
  try {
    await requireUnearnedRevenueCapability("viewer");
    const params = paramsSchema.parse(await context.params);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    return NextResponse.json(await getUnearnedRevenueStudentDetail({
      studentId: params.studentId,
      period: query.period,
    }));
  } catch (error) {
    return unearnedRevenueErrorResponse("GET /api/unearned-revenue/students/[studentId]", error);
  }
}
