#!/usr/bin/env bash
#
# ipeds-convert.sh — one-time LOCAL conversion of the IPEDS 2024-25 Access DB to CSV.
#
# The IPEDS source is a 591MB Microsoft Access (.accdb) file that cannot live in git
# or be read on Vercel. This script uses mdbtools (brew install mdbtools) to export the
# curated subset of tables this feature needs into gitignored per-table CSVs, which the
# Node import script (scripts/ipeds-import.ts) then loads into Postgres. The website only
# ever reads Postgres — never the .accdb or these CSVs.
#
# Usage:  bash scripts/ipeds-convert.sh
# Output: IPEDS_2024-25_Provisional/csv/<TableName>.csv  (gitignored)

set -euo pipefail

DATA_DIR="IPEDS_2024-25_Provisional"
ACCDB="${DATA_DIR}/IPEDS202425.accdb"
OUT="${DATA_DIR}/csv"

if ! command -v mdb-export >/dev/null 2>&1; then
  echo "ERROR: mdbtools not found. Install with: brew install mdbtools" >&2
  exit 1
fi
if [ ! -f "${ACCDB}" ]; then
  echo "ERROR: ${ACCDB} not found." >&2
  exit 1
fi

mkdir -p "${OUT}"

# Exact (case-sensitive) Access table names verified via `mdb-tables -1`.
TABLES=(
  HD2024
  IC2024
  ADM2024
  DRVADM2024
  DRVEF2024
  EF2024D
  DRVGR2024
  DRVOM2024
  DRVCOST2024
  Cost1_2024
  COST2_2024_NetPrice
  Cost2_2024_FinancialAid
  DRVC2024
  C2024_A
  valueSets24
)

echo "Converting ${#TABLES[@]} tables from ${ACCDB} -> ${OUT}/"
for t in "${TABLES[@]}"; do
  out_file="${OUT}/${t}.csv"
  mdb-export "${ACCDB}" "${t}" > "${out_file}"
  rows=$(($(wc -l < "${out_file}") - 1))
  printf '  %-26s %8d rows\n' "${t}.csv" "${rows}"
done

echo "Done. CSVs in ${OUT}/ (gitignored)."
