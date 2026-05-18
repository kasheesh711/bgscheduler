import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runCreditControlSync } from "@/lib/credit-control/sync";

export async function runCreditControlSyncRequest() {
  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  const result = await runCreditControlSync(db, client, instituteId);

  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
  });
}
