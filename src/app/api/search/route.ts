import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureIndex } from "@/lib/search/index";
import { executeSearch } from "@/lib/search/engine";

const searchRequestSchema = z.object({
  searchMode: z.enum(["recurring", "one_time"]),
  slots: z.array(
    z.object({
      id: z.string(),
      dayOfWeek: z.number().min(0).max(6).optional(),
      date: z.string().optional(),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      mode: z.enum(["online", "onsite", "either"]),
    })
  ).min(1),
  filters: z
    .object({
      subject: z.string().optional(),
      curriculum: z.string().optional(),
      level: z.string().optional(),
    })
    .optional(),
  rawInput: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = searchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();

  try {
    const index = await ensureIndex(db);
    const result = executeSearch(index, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
