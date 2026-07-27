import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { payoutConnectedEmail } from "@/lib/post-class-feedback/payout-config";
import {
  loadActiveTutorPayoutSheets,
  upsertTutorPayoutSheet,
} from "@/lib/post-class-feedback/payout-repository";
import { listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";

// The tutor → spreadsheet mapping is explicit and managed. An unmapped tutor is
// an exception a publish reports; it never guesses at a destination, which is
// why this has to exist before the publish route is usable at all.

const QuerySchema = z.object({
  spreadsheetId: z.string().trim().min(1).optional(),
});

const BodySchema = z.object({
  canonicalKey: z.string().trim().min(1).max(200),
  spreadsheetId: z.string().trim().min(1).max(200),
  sheetName: z.string().trim().min(1).max(200),
  sheetGid: z.number().int().min(0),
  active: z.boolean().default(true),
}).strict();

export async function GET(request: NextRequest) {
  try {
    await requirePostClassCapability("access_manager");
    const parsed = QuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const mappings = [...(await loadActiveTutorPayoutSheets(getDb())).values()];
    if (!parsed.data.spreadsheetId) {
      return NextResponse.json({ ok: true, mappings, tabs: [] });
    }
    // The numeric gid, not the title: insertDimension addresses sheets by gid,
    // and there is no other way to discover it.
    const tabs = await listGoogleSheetProperties(
      payoutConnectedEmail(),
      parsed.data.spreadsheetId,
    );
    return NextResponse.json({ ok: true, mappings, tabs });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "GET /api/post-class-feedback/payout-sheets",
      error,
      "Could not load the payout sheet mappings.",
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const body = BodySchema.parse(await request.json());
    const mapping = await upsertTutorPayoutSheet(getDb(), {
      ...body,
      updatedByEmail: actor.email,
    });
    return NextResponse.json({ ok: true, mapping });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/payout-sheets",
      error,
      "Could not save the payout sheet mapping.",
    );
  }
}
