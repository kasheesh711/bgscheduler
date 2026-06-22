import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getLiveSlimRows } from "@/lib/sales-dashboard/data";
import { filterSlimTransactions } from "@/lib/sales-dashboard/dimensions";
import {
  readSearchParams,
  salesTransactionPageKeys,
  salesTransactionPageQuerySchema,
} from "@/lib/sales-dashboard/transaction-query";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = salesTransactionPageQuerySchema.safeParse(
    readSearchParams(request.nextUrl.searchParams, salesTransactionPageKeys),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { rep, program, band, student, from, to, limit, offset } = parsed.data;
    const rows = await getLiveSlimRows();
    const filtered = filterSlimTransactions(rows, { rep, program, band, student, from, to });
    return NextResponse.json({
      rows: filtered.slice(offset, offset + limit),
      total: filtered.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load sales transactions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
