import { NextResponse } from "next/server";
import { z } from "zod";

import {
  admissionsErrorResponse,
  assertCaseMutationAllowed,
  requireAdmissionsSession,
  requireCaseAccess,
} from "@/lib/admissions/access";
import {
  commitAdmissionsWorkbookImport,
  listAdmissionsWorkbookImports,
  loadAdmissionsWorkbookPreview,
} from "@/lib/admissions/workbook-import-service";
import {
  ADMISSIONS_IMPORT_CONFLICT_POLICIES,
  AdmissionsImportConflictChoiceRequiredError,
  AdmissionsImportInProgressError,
  AdmissionsImportSourceChangedError,
  AdmissionsImportValidationError,
} from "@/lib/admissions/workbook-import-commit";
import { MissingGoogleSheetsTokenError } from "@/lib/sales-dashboard/google-oauth";

const ROUTE = "/api/admissions/cases/[caseId]/imports";

const previewSchema = z.object({
  action: z.literal("preview"),
  spreadsheetUrl: z.string().trim().min(1),
});

const commitSchema = z.object({
  action: z.literal("commit"),
  spreadsheetUrl: z.string().trim().min(1),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  conflictPolicy: z.enum(ADMISSIONS_IMPORT_CONFLICT_POLICIES).optional(),
});

const requestSchema = z.discriminatedUnion("action", [previewSchema, commitSchema]);

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    await requireCaseAccess(user.email, caseId, "counselor");
    return NextResponse.json({ imports: await listAdmissionsWorkbookImports(caseId) });
  } catch (error) {
    return admissionsErrorResponse(ROUTE, error, "Workbook import history failed");
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ caseId: string }> },
) {
  try {
    const user = await requireAdmissionsSession();
    const { caseId } = await ctx.params;
    const access = await requireCaseAccess(user.email, caseId, "counselor");
    assertCaseMutationAllowed(access);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (parsed.data.action === "preview") {
      const preview = await loadAdmissionsWorkbookPreview({
        actorEmail: user.email,
        caseId,
        spreadsheetUrl: parsed.data.spreadsheetUrl,
      });
      return NextResponse.json({ preview });
    }
    const result = await commitAdmissionsWorkbookImport({
      access,
      spreadsheetUrl: parsed.data.spreadsheetUrl,
      expectedFingerprint: parsed.data.expectedFingerprint,
      conflictPolicy: parsed.data.conflictPolicy,
    });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof MissingGoogleSheetsTokenError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof AdmissionsImportSourceChangedError ||
      error instanceof AdmissionsImportConflictChoiceRequiredError ||
      error instanceof AdmissionsImportInProgressError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof AdmissionsImportValidationError) {
      return NextResponse.json(
        { error: error.message, issues: error.issues },
        { status: 422 },
      );
    }
    return admissionsErrorResponse(ROUTE, error, "Workbook import request failed");
  }
}
