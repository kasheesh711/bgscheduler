import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listActiveProposalHolds } from "@/lib/proposals/data";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const holds = await listActiveProposalHolds(getDb());
    return NextResponse.json({ holds });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load proposals";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
