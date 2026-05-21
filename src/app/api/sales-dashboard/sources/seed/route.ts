import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { seedDefaultSalesSources } from "@/lib/sales-dashboard/data";

export async function POST() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sources = await seedDefaultSalesSources(session.user.email);
    return NextResponse.json({ sources, count: sources.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to seed sales sources";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
