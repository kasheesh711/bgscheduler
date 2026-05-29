import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { updateLineOaResolverRowsFromExtension } from "@/lib/line/oa-resolver";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const rowSchema = z.object({
  rowId: z.string().uuid(),
  status: z.enum(["matched", "ambiguous", "no_match", "error"]),
  lineChatUrl: z.string().trim().max(500).nullable().optional(),
  chatTitle: z.string().trim().max(500).nullable().optional(),
  matchMode: z.string().trim().max(80).nullable().optional(),
  captureMode: z.string().trim().max(80).nullable().optional(),
  errorMessage: z.string().trim().max(1000).nullable().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
}).strict();

const rowsSchema = z.object({
  rows: z.array(rowSchema).min(1).max(50),
}).strict();

type RouteContext = { params: Promise<{ runId: string }> };

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const token = bearerToken(request);
  if (!token) {
    return NextResponse.json(
      { error: "Missing resolver token" },
      { status: 401, headers: corsHeaders },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const parsed = rowsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400, headers: corsHeaders },
    );
  }

  const { runId } = await ctx.params;
  const run = await updateLineOaResolverRowsFromExtension(getDb(), {
    token,
    runId,
    rows: parsed.data.rows,
  });
  if (!run) {
    return NextResponse.json(
      { error: "Invalid or expired resolver token" },
      { status: 401, headers: corsHeaders },
    );
  }

  return NextResponse.json({ run }, { headers: corsHeaders });
}
