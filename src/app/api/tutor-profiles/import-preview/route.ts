import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listTutorBusinessProfiles } from "@/lib/tutor-business-profiles";
import {
  buildTutorProfileImportPreview,
  parseTutorProfileImportWorkbooks,
} from "@/lib/tutor-profile-import";

async function fileBuffer(formData: FormData, key: string): Promise<Buffer | undefined> {
  const file = formData.get(key);
  if (!(file instanceof File) || file.size === 0) return undefined;
  return Buffer.from(await file.arrayBuffer());
}

function nullableFormValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  try {
    const [educationWorkbook, availabilityWorkbook, activeProfiles] = await Promise.all([
      fileBuffer(formData, "educationFile"),
      fileBuffer(formData, "availabilityFile"),
      listTutorBusinessProfiles(getDb()),
    ]);

    if (!educationWorkbook && !availabilityWorkbook) {
      return NextResponse.json({ error: "Upload at least one tutor profile workbook" }, { status: 400 });
    }

    const { educationRows, availabilityRows } = parseTutorProfileImportWorkbooks({
      educationWorkbook,
      availabilityWorkbook,
    });
    const preview = buildTutorProfileImportPreview({
      educationRows,
      availabilityRows,
      activeProfiles,
      verifiedBy: nullableFormValue(formData, "verifiedBy"),
      lastReviewedAt: nullableFormValue(formData, "lastReviewedAt"),
    });

    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to preview tutor profile import";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
