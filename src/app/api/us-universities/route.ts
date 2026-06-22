import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUsUniversitiesOverview } from "@/lib/us-universities/data";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const overview = await getUsUniversitiesOverview();
    return NextResponse.json(overview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load overview";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
