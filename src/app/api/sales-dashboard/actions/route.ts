import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCreditControlPayload } from "@/lib/credit-control/service";
import { canAccessHref } from "@/lib/navigation/tools";
import { buildSalesActionsPayload } from "@/lib/sales-dashboard/actions";
import { getSalesDashboardPayload, getSalesDimensionsPayload } from "@/lib/sales-dashboard/data";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  from: z.string().regex(ISO_DATE, "Expected YYYY-MM-DD"),
  to: z.string().regex(ISO_DATE, "Expected YYYY-MM-DD"),
}).refine((query) => query.from <= query.to, {
  path: ["to"],
  message: "to must be on or after from",
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = querySchema.safeParse({
    from: request.nextUrl.searchParams.get("from") ?? undefined,
    to: request.nextUrl.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const [sales, dimensions] = await Promise.all([
      getSalesDashboardPayload(session.user.email),
      getSalesDimensionsPayload(),
    ]);

    let creditControl: Awaited<ReturnType<typeof getCreditControlPayload>> | null = null;
    let creditControlError: string | null = null;
    try {
      creditControl = await getCreditControlPayload(undefined, { clearRecoveredActionStates: false });
    } catch (error) {
      creditControlError = error instanceof Error ? error.message : "Unknown Credit Control error";
    }

    const payload = buildSalesActionsPayload({
      sales,
      dimensions,
      creditControl,
      creditControlError,
      from: parsed.data.from,
      to: parsed.data.to,
      canAccessCreditControl: canAccessHref("/credit-control", session.user.allowedPages ?? null),
    });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load sales actions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
