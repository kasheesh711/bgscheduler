import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getHomeSummaryPayload } from "@/lib/home/summary";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await getHomeSummaryPayload({
      allowedPages: session.user.allowedPages ?? null,
      email: session.user.email,
    }, getDb()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Home summary failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
