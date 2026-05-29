import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { refreshAllLineContactProfiles } from "@/lib/line/contact-aliases";

export async function POST() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await refreshAllLineContactProfiles({ db: getDb() });
  return NextResponse.json({ result });
}
