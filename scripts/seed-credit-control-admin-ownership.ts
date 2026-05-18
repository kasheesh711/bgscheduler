import fs from "node:fs";
import * as XLSX from "xlsx";
import {
  seedCreditAdminOwnershipFromRemainingCredits,
  type RemainingCreditsOwnershipRow,
} from "@/lib/credit-control/admin-ownership-seed";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/seed-credit-control-admin-ownership.ts <RemainingCredits.csv|xlsx> [assignedByEmail]",
  );
}

const filePath = process.argv[2];
const assignedByEmail = process.argv[3] ?? "seed:remaining-credits";

async function main(): Promise<void> {
  if (!filePath) usage();

  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) usage();

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: "",
  });

  const ownershipRows: RemainingCreditsOwnershipRow[] = rows
    .map((row) => ({
      student: String(row.Student ?? row.student ?? "").trim(),
      admin: String(row.Admin ?? row.admin ?? "").trim(),
    }))
    .filter((row) => row.student);

  const result = await seedCreditAdminOwnershipFromRemainingCredits(ownershipRows, {
    assignedByEmail,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
