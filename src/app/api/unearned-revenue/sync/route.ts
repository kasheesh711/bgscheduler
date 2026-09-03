import { NextResponse } from "next/server";

import { requireUnearnedRevenueCapability } from "@/lib/unearned-revenue/access";
import { unearnedRevenueErrorResponse } from "@/lib/unearned-revenue/api";
import { runUnearnedRevenueSync } from "@/lib/unearned-revenue/sync";

export const maxDuration = 800;

export async function POST() {
  try {
    const user = await requireUnearnedRevenueCapability("access_manager");
    const result = await runUnearnedRevenueSync({ triggerType: "manual", actorEmail: user.email });
    return NextResponse.json(result, { status: result.ok ? result.skipped ? 202 : 200 : 502 });
  } catch (error) {
    return unearnedRevenueErrorResponse("POST /api/unearned-revenue/sync", error);
  }
}
