import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { buildStudentAdminOwnershipMap } from "@/lib/credit-control/packages";
import type { SheetSnapshot } from "@/lib/credit-control/domain";
import { upsertCreditAdminOwnership } from "@/lib/credit-control/db";
import { UNASSIGNED_ADMIN_KEY } from "@/lib/credit-control/config";

export interface RemainingCreditsOwnershipRow {
  student: string;
  admin: string;
}

export interface CreditAdminOwnershipSeedResult {
  inputRows: number;
  recognizedStudents: number;
  matchedActiveStudents: number;
  upserted: number;
  skippedUnassigned: number;
}

function remainingCreditsSnapshot(rows: RemainingCreditsOwnershipRow[]): SheetSnapshot {
  return {
    sheetName: "RemainingCredits",
    headerRowIndex: 0,
    dataRowStartIndex: 2,
    cols: { Student: 0, Admin: 1 },
    rows: rows.map((row) => [row.student, row.admin]),
  };
}

export async function seedCreditAdminOwnershipFromRemainingCredits(
  rows: RemainingCreditsOwnershipRow[],
  options: { assignedByEmail?: string; db?: Database } = {},
): Promise<CreditAdminOwnershipSeedResult> {
  const db = options.db ?? getDb();
  const ownershipByStudentName = buildStudentAdminOwnershipMap(remainingCreditsSnapshot(rows));
  const recognizedStudents = Object.keys(ownershipByStudentName).length;

  const [activeSnapshot] = await db
    .select({ id: schema.creditControlSnapshots.id })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .limit(1);

  if (!activeSnapshot) {
    throw new Error("No active credit-control snapshot found. Run credit sync before seeding admin ownership.");
  }

  const activeStudents = await db
    .select({
      studentKey: schema.creditControlStudents.studentKey,
      studentName: schema.creditControlStudents.studentName,
    })
    .from(schema.creditControlStudents)
    .where(eq(schema.creditControlStudents.snapshotId, activeSnapshot.id));

  let matchedActiveStudents = 0;
  let upserted = 0;
  let skippedUnassigned = 0;

  for (const student of activeStudents) {
    const ownership = ownershipByStudentName[student.studentName];
    if (!ownership) continue;

    matchedActiveStudents += 1;
    if (ownership.key === UNASSIGNED_ADMIN_KEY) {
      skippedUnassigned += 1;
      continue;
    }

    await upsertCreditAdminOwnership({
      studentKey: student.studentKey,
      adminKey: ownership.key,
      assignedByEmail: options.assignedByEmail ?? "seed:remaining-credits",
    }, db);
    upserted += 1;
  }

  return {
    inputRows: rows.length,
    recognizedStudents,
    matchedActiveStudents,
    upserted,
    skippedUnassigned,
  };
}
