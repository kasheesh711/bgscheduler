/**
 * ipeds-import.ts — one-time LOCAL import of the curated IPEDS slice into Postgres.
 *
 * Reads the CSVs produced by scripts/ipeds-convert.sh, filters to 4-year
 * degree-granting active Title IV institutions, derives one denormalized
 * profile row + bachelor's-level completions rows per school, and bulk-inserts
 * them under a single idempotent import run (keyed by --year). Re-running for the
 * same year replaces that year's rows. The website only ever reads Postgres.
 *
 * Usage:
 *   npx tsx scripts/ipeds-import.ts --year 2024-25 --csv IPEDS_2024-25_Provisional/csv
 *   (DATABASE_URL is read from the environment, or auto-loaded from .env.local)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Load DATABASE_URL from .env.local if not already in the environment.
function loadEnvLocal(): void {
  if (process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnvLocal();

import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { ipedsImportRuns, ipedsInstitutions, ipedsCompletions } from "@/lib/db/schema";
import { buildInstitution, buildCompletions, type SourceRows } from "@/lib/us-universities/transform";
import { coerceIpedsInt, isSixDigitCip } from "@/lib/us-universities/parser";
import {
  isFourYearDegreeGranting,
  COMPLETIONS_AWARD_LEVEL,
  CURRENT_DATA_YEAR,
} from "@/lib/us-universities/constants";
import type {
  IpedsInstitutionInsert,
  IpedsCompletionInsert,
} from "@/lib/us-universities/types";

// ── CSV helpers ────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Read a whole CSV into upper-keyed row objects (for the small ≤6k-row tables). */
function readCsvObjects(file: string): Array<Record<string, string>> {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const fields = parseCsvLine(lines[i]);
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = fields[j] ?? "";
    rows.push(obj);
  }
  return rows;
}

/** Index a table's rows by integer UNITID. */
function indexByUnit(rows: Array<Record<string, string>>): Map<number, Record<string, string>> {
  const map = new Map<number, Record<string, string>>();
  for (const r of rows) {
    const id = coerceIpedsInt(r.UNITID);
    if (id != null) map.set(id, r);
  }
  return map;
}

async function chunkedInsert<T>(
  rows: T[],
  chunkSize: number,
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insert(rows.slice(i, i + chunkSize));
  }
}

// ── Main ───────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

async function main(): Promise<void> {
  const dataYear = arg("year", CURRENT_DATA_YEAR);
  const csvDir = arg("csv", "IPEDS_2024-25_Provisional/csv");
  const triggeredByEmail = arg("email", "");
  const p = (name: string) => path.join(csvDir, `${name}.csv`);

  if (!fs.existsSync(p("HD2024"))) {
    throw new Error(`CSV not found: ${p("HD2024")}. Run scripts/ipeds-convert.sh first.`);
  }

  const db = getDb();
  console.log(`IPEDS import — year=${dataYear} csv=${csvDir}`);

  // Load the small "frequently used" tables.
  const hdRows = readCsvObjects(p("HD2024"));
  const adm = indexByUnit(readCsvObjects(p("ADM2024")));
  const drvadm = indexByUnit(readCsvObjects(p("DRVADM2024")));
  const drvef = indexByUnit(readCsvObjects(p("DRVEF2024")));
  const ef2024d = indexByUnit(readCsvObjects(p("EF2024D")));
  const drvgr = indexByUnit(readCsvObjects(p("DRVGR2024")));
  const drvom = indexByUnit(readCsvObjects(p("DRVOM2024")));
  const drvcost = indexByUnit(readCsvObjects(p("DRVCOST2024")));
  const cost1 = indexByUnit(readCsvObjects(p("Cost1_2024")));
  const netprice = indexByUnit(readCsvObjects(p("COST2_2024_NetPrice")));
  const drvc = indexByUnit(readCsvObjects(p("DRVC2024")));

  // CIP title map from valueSets24 (VarName = CIPCODE).
  const cipTitleMap = new Map<string, string>();
  for (const r of readCsvObjects(p("valueSets24"))) {
    if (r.VARNAME === "CIPCODE" && r.CODEVALUE) {
      cipTitleMap.set(r.CODEVALUE.trim(), (r.VALUELABEL ?? "").trim());
    }
  }

  // 4-year degree-granting active Title IV institutions.
  const fourYear = hdRows.filter(isFourYearDegreeGranting);
  const ids = new Set<number>();
  for (const r of fourYear) {
    const id = coerceIpedsInt(r.UNITID);
    if (id != null) ids.add(id);
  }
  console.log(`  HD2024 total=${hdRows.length}  4-year set=${ids.size}`);

  // Build institution records.
  const institutions: IpedsInstitutionInsert[] = [];
  for (const r of fourYear) {
    const unitId = coerceIpedsInt(r.UNITID);
    if (unitId == null) continue;
    const src: SourceRows = {
      HD: r,
      ADM: adm.get(unitId),
      DRVADM: drvadm.get(unitId),
      DRVEF: drvef.get(unitId),
      EF2024D: ef2024d.get(unitId),
      DRVGR: drvgr.get(unitId),
      DRVOM: drvom.get(unitId),
      DRVCOST: drvcost.get(unitId),
      COST1: cost1.get(unitId),
      NETPRICE: netprice.get(unitId),
      DRVC: drvc.get(unitId),
    };
    institutions.push(buildInstitution(src, unitId, dataYear));
  }

  // Stream completions (C2024_A is ~1.7M rows); keep bachelor's-level conferrals.
  const completionRaw: Array<Record<string, string>> = [];
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(p("C2024_A"), "utf8");
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header: string[] | null = null;
    let idx: Record<string, number> = {};
    rl.on("line", (line) => {
      if (line === "") return;
      const fields = parseCsvLine(line);
      if (!header) {
        header = fields.map((h) => h.trim().toUpperCase());
        idx = Object.fromEntries(header.map((h, i) => [h, i]));
        return;
      }
      const unitId = coerceIpedsInt(fields[idx.UNITID]);
      if (unitId == null || !ids.has(unitId)) return;
      if (fields[idx.MAJORNUM] !== "1") return;
      const cip = (fields[idx.CIPCODE] ?? "").trim();
      // C2024_A nests 2-/4-/6-digit CIP rollups of the same degrees; keep only
      // 6-digit detail rows to avoid triple-counting. Exclude the 99 grand total.
      if (!isSixDigitCip(cip) || cip.startsWith("99")) return;
      if (coerceIpedsInt(fields[idx.AWLEVEL]) !== COMPLETIONS_AWARD_LEVEL) return;
      const total = coerceIpedsInt(fields[idx.CTOTALT]) ?? 0;
      if (total <= 0) return;
      completionRaw.push({
        UNITID: String(unitId),
        CIPCODE: cip,
        AWLEVEL: fields[idx.AWLEVEL],
        CTOTALT: fields[idx.CTOTALT],
      });
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
  const completions: IpedsCompletionInsert[] = buildCompletions(completionRaw, cipTitleMap, dataYear);
  console.log(`  institutions=${institutions.length}  completions=${completions.length}`);

  // Clear any stale running run for this year, then open a fresh run.
  await db
    .update(ipedsImportRuns)
    .set({ status: "failed", errorSummary: "superseded", finishedAt: new Date() })
    .where(and(eq(ipedsImportRuns.dataYear, dataYear), eq(ipedsImportRuns.status, "running")));
  const [run] = await db
    .insert(ipedsImportRuns)
    .values({ dataYear, status: "running", triggeredByEmail: triggeredByEmail || null })
    .returning();

  try {
    // Idempotent: drop this year's rows before reinserting.
    await db.delete(ipedsCompletions).where(eq(ipedsCompletions.dataYear, dataYear));
    await db.delete(ipedsInstitutions).where(eq(ipedsInstitutions.dataYear, dataYear));

    await chunkedInsert(
      institutions.map((r) => ({ ...r, importRunId: run.id })),
      400,
      (chunk) => db.insert(ipedsInstitutions).values(chunk),
    );
    await chunkedInsert(
      completions.map((r) => ({ ...r, importRunId: run.id })),
      2000,
      (chunk) => db.insert(ipedsCompletions).values(chunk),
    );

    await db
      .update(ipedsImportRuns)
      .set({
        status: "success",
        institutionCount: institutions.length,
        completionCount: completions.length,
        finishedAt: new Date(),
      })
      .where(eq(ipedsImportRuns.id, run.id));
    console.log(`  ✓ import run ${run.id} success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "import failed";
    await db
      .update(ipedsImportRuns)
      .set({ status: "failed", errorSummary: message, finishedAt: new Date() })
      .where(eq(ipedsImportRuns.id, run.id));
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
