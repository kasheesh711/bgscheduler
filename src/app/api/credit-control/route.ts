import { NextResponse } from "next/server";
import { requireCreditControlSession, creditControlErrorResponse } from "@/lib/credit-control/api";
import { getCreditControlPayload } from "@/lib/credit-control/service";

export async function GET() {
  try {
    await requireCreditControlSession();
    const payload = await getCreditControlPayload();
    return NextResponse.json(payload);
  } catch (error) {
    return creditControlErrorResponse("/api/credit-control", error, "Credit control load failed");
  }
}
