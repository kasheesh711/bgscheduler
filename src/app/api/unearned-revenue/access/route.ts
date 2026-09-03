import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  listUnearnedRevenueAccessRows,
  replaceUnearnedRevenueCapabilities,
  requireUnearnedRevenueCapability,
} from "@/lib/unearned-revenue/access";
import { unearnedRevenueErrorResponse } from "@/lib/unearned-revenue/api";

const patchSchema = z.object({
  targetEmail: z.string().trim().email(),
  capabilities: z.array(z.enum(["viewer", "access_manager"])).max(2),
  expectedVersion: z.number().int().nonnegative(),
  note: z.string().trim().max(500).optional(),
});

export async function GET() {
  try {
    await requireUnearnedRevenueCapability("access_manager");
    return NextResponse.json({ rows: await listUnearnedRevenueAccessRows() });
  } catch (error) {
    return unearnedRevenueErrorResponse("GET /api/unearned-revenue/access", error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUnearnedRevenueCapability("access_manager");
    const input = patchSchema.parse(await request.json());
    const capabilities = await replaceUnearnedRevenueCapabilities({
      actorEmail: user.email,
      ...input,
    });
    return NextResponse.json({ ok: true, targetEmail: input.targetEmail, capabilities });
  } catch (error) {
    return unearnedRevenueErrorResponse("PATCH /api/unearned-revenue/access", error);
  }
}
