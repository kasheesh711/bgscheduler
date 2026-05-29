import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commitLineAliasImport } from "@/lib/line/contact-aliases";

const commitSchema = z.object({
  rows: z.array(z.object({
    contactId: z.string().uuid(),
    aliasLabel: z.string().trim().min(1).max(500),
  })).min(1).max(100),
}).strict();

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

  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await commitLineAliasImport({
    db: getDb(),
    rows: parsed.data.rows,
  });
  return NextResponse.json({ result });
}
