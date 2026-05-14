import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getFilterOptions } from "@/lib/data/filters";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await getFilterOptions());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load filters";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
