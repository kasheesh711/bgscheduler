#!/usr/bin/env python3
"""Install the reviewed V5 extension beside the existing Datasets engine."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('datasets_dir',type=Path)
args=parser.parse_args()
source=Path(__file__).resolve().parent
target=args.datasets_dir.resolve()
manifest=json.loads((source/'runtime-files.json').read_text())
base=target/'begifted_dashboard/unearned_google_sheet.py'
if hashlib.sha256(base.read_bytes()).hexdigest()!=manifest['begifted_dashboard/unearned_google_sheet.py']:
    raise SystemExit('Accounting engine changed; review compatibility before installing this extension')
lot=target/'begifted_dashboard/package_lots.py'
if hashlib.sha256(lot.read_bytes()).hexdigest()!=manifest['begifted_dashboard/package_lots.py']:
    subprocess.run(['git','apply','--check',str(source/'package_lots.patch')],cwd=target,check=True)
    subprocess.run(['git','apply',str(source/'package_lots.patch')],cwd=target,check=True)
for name,path in {'finance_reports.py':'begifted_dashboard/finance_reports.py','build_unearned_report_bundle.py':'scripts/build_unearned_report_bundle.py','verify_unearned_v4_frozen.py':'scripts/verify_unearned_v4_frozen.py','test_finance_reports.py':'tests/test_finance_reports.py'}.items():
    shutil.copyfile(source/name,target/path)
for path,digest in manifest.items():
    if hashlib.sha256((target/path).read_bytes()).hexdigest()!=digest:raise SystemExit('Runtime mismatch: '+path)
print('V5 accounting extension installed and verified')
