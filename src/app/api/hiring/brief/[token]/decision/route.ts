import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { saveBriefDecision } from "@/lib/hiring/decisions";
import { hiringError, requireSameOrigin } from "@/lib/hiring/http";

const body = z.object({ decision: z.enum(["hire", "reject"]), reason: z.string().trim().max(1000) }).strict();

/**
 * Public: the interviewer's link is the only access check. It records that head's decision and tells HR. No email leaves.
 * Reachability needs the `/api/hiring/brief/{token}/decision` entry in src/proxy.ts.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    requireSameOrigin(request);
    const input = body.parse(await request.json().catch(() => null));
    return NextResponse.json(await saveBriefDecision((await context.params).token, input, getDb()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
