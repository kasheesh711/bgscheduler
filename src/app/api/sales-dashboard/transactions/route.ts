import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getLiveSlimRows } from "@/lib/sales-dashboard/data";
import { filterSlimTransactions } from "@/lib/sales-dashboard/dimensions";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

const querySchema = z.object({
  rep: z.string().min(1).optional(),
  program: z.string().min(1).optional(),
  band: z.string().min(1).optional(),
  student: z.string().min(1).optional(),
  from: z.string().regex(ISO_DATE, "Expected YYYY-MM-DD").optional(),
  to: z.string().regex(ISO_DATE, "Expected YYYY-MM-DD").optional(),
  limit: z.coerce.number().int().positive().transform((value) => Math.min(value, MAX_LIMIT)).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: Record<string, string> = {};
  for (const key of ["rep", "program", "band", "student", "from", "to", "limit", "offset"]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  const parsed = querySchema.safeParse(raw);
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
