import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCompareInstitutions } from "@/lib/us-universities/data";
import { MAX_COMPARE } from "@/lib/us-universities/constants";

const QuerySchema = z.object({ ids: z.string().min(1) });

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ ids: url.searchParams.get("ids") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const unitIds = parsed.data.ids
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .slice(0, MAX_COMPARE);

  if (unitIds.length === 0) {
    return NextResponse.json({ error: "No valid institution ids" }, { status: 400 });
  }

  try {
    const institutions = await getCompareInstitutions(unitIds);
    return NextResponse.json({ institutions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compare institutions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
