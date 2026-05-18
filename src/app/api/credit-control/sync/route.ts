import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { runCreditControlSyncRequest } from "@/lib/credit-control/run-sync-request";

export const maxDuration = 300;

export async function POST() {
  try {
    await requireCreditControlSession();
    return runCreditControlSyncRequest();
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control/sync", error, "Credit control sync failed");
  }
}
