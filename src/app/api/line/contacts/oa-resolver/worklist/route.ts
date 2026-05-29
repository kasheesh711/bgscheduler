import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listLineOaResolverWorklistForToken } from "@/lib/line/oa-resolver";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  const token = bearerToken(request);
  const worklist = token
    ? await listLineOaResolverWorklistForToken(getDb(), token)
    : null;
  if (!worklist) {
    return NextResponse.json(
      { error: "Invalid or expired resolver token" },
      { status: 401, headers: corsHeaders },
    );
  }

  return NextResponse.json({ worklist }, { headers: corsHeaders });
}
