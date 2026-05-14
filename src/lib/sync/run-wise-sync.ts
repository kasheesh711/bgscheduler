import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";

export async function runWiseSyncRequest() {
  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";

  const result = await runFullSync(db, client, instituteId);

  if (result.success) {
    revalidateTag("snapshot", { expire: 0 });
  }

  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
  });
}
