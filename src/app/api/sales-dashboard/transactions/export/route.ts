import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { serializeCsv, sanitizeCsvFilename, type CsvColumn } from "@/lib/sales-dashboard/csv";
import { getLiveSlimRows } from "@/lib/sales-dashboard/data";
import { filterSlimTransactions } from "@/lib/sales-dashboard/dimensions";
import {
  readSearchParams,
  salesTransactionFilterKeys,
  salesTransactionFilterSchema,
} from "@/lib/sales-dashboard/transaction-query";
import type { SlimTransaction } from "@/lib/sales-dashboard/types";

const TRANSACTION_COLUMNS: CsvColumn<SlimTransaction>[] = [
  { key: "date", header: "Date", value: (row) => row.date },
  { key: "kind", header: "Kind", value: (row) => row.kind },
  { key: "student", header: "Student", value: (row) => row.student },
  { key: "studentKey", header: "Student Key", value: (row) => row.studentKey },
  { key: "rep", header: "Rep", value: (row) => row.rep },
  { key: "program", header: "Program", value: (row) => row.program },
  { key: "packageLabel", header: "Package", value: (row) => row.packageLabel },
  { key: "band", header: "Band", value: (row) => row.band },
  { key: "hours", header: "Hours", value: (row) => row.hours },
  { key: "amount", header: "Amount", value: (row) => row.amount },
  { key: "enrollmentType", header: "Enrollment Type", value: (row) => row.enrollmentType },
  { key: "salesType", header: "Sales Type", value: (row) => row.salesType },
  { key: "validUntil", header: "Valid Until", value: (row) => row.validUntil },
  { key: "sourceMonth", header: "Source Month", value: (row) => row.sourceMonth },
  { key: "numberOfStudents", header: "Number Of Students", value: (row) => row.numberOfStudents },
];

function filenameFor(query: { from?: string; to?: string }): string {
  const from = query.from ?? "all";
  const to = query.to ?? "all";
  return sanitizeCsvFilename(`sales-dashboard-transactions-${from}-to-${to}.csv`);
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = salesTransactionFilterSchema.safeParse(
    readSearchParams(request.nextUrl.searchParams, salesTransactionFilterKeys),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const rows = await getLiveSlimRows();
    const filtered = filterSlimTransactions(rows, parsed.data);
    const csv = serializeCsv(filtered, TRANSACTION_COLUMNS);
    return new Response(csv, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filenameFor(parsed.data)}"`,
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export sales transactions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
