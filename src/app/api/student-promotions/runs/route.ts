import { NextResponse } from "next/server";
import { createStudentPromotionDryRun, getLatestStudentPromotionRunDetail } from "@/lib/student-promotions/data";
import { requireStudentPromotionSession, studentPromotionErrorResponse } from "@/lib/student-promotions/api";

export const maxDuration = 800;

export async function GET() {
  try {
    await requireStudentPromotionSession();
    return NextResponse.json({ detail: await getLatestStudentPromotionRunDetail() });
  } catch (error) {
    return studentPromotionErrorResponse("/api/student-promotions/runs", error, "Failed to load student promotion run");
  }
}

export async function POST() {
  try {
    const actor = await requireStudentPromotionSession();
    return NextResponse.json({ detail: await createStudentPromotionDryRun({ actor }) }, { status: 201 });
  } catch (error) {
    return studentPromotionErrorResponse("/api/student-promotions/runs", error, "Student promotion audit failed");
  }
}
