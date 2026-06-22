import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getInstitutionsForExport } from "@/lib/us-universities/data";
import { institutionsToCsv } from "@/lib/us-universities/csv";
import {
  FilterQuerySchema,
  searchParamsToObject,
  toFilterParams,
} from "@/lib/us-universities/request";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = FilterQuerySchema.safeParse(searchParamsToObject(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const rows = await getInstitutionsForExport(toFilterParams(parsed.data));
    const csv = institutionsToCsv(rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": 'attachment; filename="us-universities.csv"',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export institutions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
