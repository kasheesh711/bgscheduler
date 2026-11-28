import { getDb } from "@/lib/db";
import { requireHiringAdmin } from "@/lib/hiring/access";
import { atsOutcomes } from "@/lib/hiring/ats-outcomes";
import { hiringError } from "@/lib/hiring/http";

export async function GET() {
  try {
    await requireHiringAdmin();
    return Response.json(await atsOutcomes(getDb()), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return hiringError(error);
  }
}
