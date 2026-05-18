import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";

export const maxDuration = 800; // Pro-plan headroom for full Wise syncs

export async function POST() {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runWiseSyncRequest();
}
