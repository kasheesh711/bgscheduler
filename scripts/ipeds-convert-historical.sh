#!/usr/bin/env bash
#
# ipeds-convert-historical.sh — LOCAL conversion of the four historical IPEDS
# "Final" Access DBs (2020-21 … 2023-24) to per-table CSV, for the multi-year
# admissions-trends feature. Mirrors ipeds-convert.sh but loops years and
# resolves table names by the 4-digit data-year suffix. Skips C<sfx>_A (no
# historical completions imported) and COST tables (absent pre-2024-25).
#
# Usage:  bash scripts/ipeds-convert-historical.sh
# Output: IPEDS/IPEDS_<year>_Final/csv/<TableName>.csv  (gitignored)

set -euo pipefail

BASE="IPEDS"

if ! command -v mdb-export >/dev/null 2>&1; then
  echo "ERROR: mdbtools not found. Install with: brew install mdbtools" >&2
  exit 1
fi

# dir : accdb-basename : 4-digit suffix
YEARS=(
  "IPEDS_2020-21_Final:IPEDS202021:2020"
  "IPEDS_2021-22_Final:IPEDS202122:2021"
  "IPEDS_2022-23_Final:IPEDS202223:2022"
  "IPEDS_2023-24_Final:IPEDS202324:2023"
)

for entry in "${YEARS[@]}"; do
  dir=${entry%%:*}
  rest=${entry#*:}
  db=${rest%%:*}
  sfx=${rest##*:}
  accdb="${BASE}/${dir}/${db}.accdb"
  out="${BASE}/${dir}/csv"

  if [ ! -f "${accdb}" ]; then
    echo "ERROR: ${accdb} not found." >&2
    exit 1
  fi
  mkdir -p "${out}"

  tables=( "HD${sfx}" "ADM${sfx}" "DRVADM${sfx}" "DRVEF${sfx}" "EF${sfx}D" "DRVGR${sfx}" "DRVOM${sfx}" "DRVC${sfx}" "IC${sfx}" )
  echo "=== ${dir} (suffix ${sfx}) -> ${out}/ ==="
  for t in "${tables[@]}"; do
    mdb-export "${accdb}" "${t}" > "${out}/${t}.csv"
    rows=$(($(wc -l < "${out}/${t}.csv") - 1))
    printf '  %-18s %8d rows\n' "${t}.csv" "${rows}"
  done
done

echo "Done. Historical CSVs under ${BASE}/*/csv/ (gitignored)."
