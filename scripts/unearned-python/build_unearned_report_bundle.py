#!/usr/bin/env python3
"""Read sources and build a private V5 report bundle; never publish Google writes."""
from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import date, datetime
import gzip
import hashlib
import json
import os
import pickle
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from begifted_dashboard.finance_reports import clean, daily_reports, values_contract
from begifted_dashboard.unearned_google_sheet import (
    BANGKOK, GoogleServiceAccountGateway, GoogleSheetPublisher, build_model_tables,
    extract_live_sources, load_config, resolve_cutoff, _fingerprint, _resolve_control_approval,
)
from begifted_dashboard.package_lots import PACKAGE_MODEL_VERSION
from refresh_unearned_google_sheet import load_wise_env_file


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cutoff", default="previous-day")
    parser.add_argument("--target-spreadsheet-id", required=True)
    parser.add_argument("--wise-env-file", required=True)
    parser.add_argument("--google-credentials", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--skip-api", action="store_true")
    parser.add_argument("--reuse-model", action="store_true", help="Reuse this operator-created private cache while validating the same run")
    args = parser.parse_args()
    load_wise_env_file(args.wise_env_file)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = args.google_credentials
    cutoff = resolve_cutoff(args.cutoff)
    if cutoff >= datetime.now(BANGKOK).date():
        raise ValueError("Only completed Bangkok days may be published")
    config = load_config()
    gateway = GoogleServiceAccountGateway()
    publisher = GoogleSheetPublisher(gateway, args.target_spreadsheet_id, config)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = output.with_suffix(".model-cache")
    if args.reuse_model:
        # Never deserialize external uploads. This is our own same-owner 0600
        # local cache, used only for operator validation after a source fetch.
        if cache.stat().st_uid != os.getuid() or cache.stat().st_mode & 0o077:
            raise ValueError("Model cache must be private and owned by this operator")
        with cache.open("rb") as handle:
            saved = pickle.load(handle)
        if saved["cutoff"] != cutoff or saved["target"] != args.target_spreadsheet_id:
            raise ValueError("Cached run targets a different cutoff or workbook")
        sources, model, run_id, raw_control, status, control_values = (saved[key] for key in ["sources", "model", "run_id", "raw_control", "status", "control_values"])
    else:
        publisher.preflight(read_only=True)
        status = publisher.published_model_status()
        raw_control = publisher.read_package_control()
        control_values = gateway.read_values(args.target_spreadsheet_id, "'Package Control'!A1:S20000", render="UNFORMATTED_VALUE")
        control, approval_review = _resolve_control_approval(raw_control, status)
        print("Extracting ledger, sales and receipt evidence…", file=sys.stderr, flush=True)
        sources = extract_live_sources(gateway, config, cutoff)
        sources.source_fingerprint = _fingerprint({"source_fingerprint": sources.source_fingerprint, "package_control_fingerprint": _fingerprint(asdict(raw_control))})
        if status.get("workbook_schema_version") != "5":
            disappearance = publisher.check_row_disappearance(sources.manifest)
            if any(check.status != "PASS" for check in disappearance):
                raise ValueError("Source rows disappeared since the last published workbook")
        else:
            disappearance = []  # Runner compares the prior immutable audit manifest.
        run_id = str(uuid.uuid4())
        print("Calculating approved balances and package allocations…", file=sys.stderr, flush=True)
        model = build_model_tables(sources, run_id=run_id, cutoff=cutoff, config=config, fetch_api=not args.skip_api, persist_api_snapshots=False, package_control=control)
        model.qa_results.extend(disappearance)
        if approval_review:
            model.review_conditions = sorted(set([*model.review_conditions, approval_review]))
        with cache.open("wb") as handle:
            os.chmod(cache, 0o600)
            pickle.dump(dict(cutoff=cutoff, target=args.target_spreadsheet_id, sources=sources, model=model, run_id=run_id, raw_control=raw_control, status=status, control_values=control_values), handle)
    print("Projecting and reconciling daily history…", file=sys.stderr, flush=True)
    daily = daily_reports(model, date.fromisoformat(config["model_start_date"]), cutoff)
    contract = values_contract(sources, model, config, cutoff, run_id)
    qa_headers = contract["QA Checks"][0]
    contract["QA Checks"].extend([[row.get(key) for key in qa_headers] for row in daily["qa"]])
    generated_at = datetime.now(BANGKOK).isoformat()
    quality = model.package_lots.quality
    status_fields = {
        "workbook_schema_version": 5, "model_status": "PUBLISHED", "publication_status": "PUBLISHED",
        "published_cutoff": cutoff.isoformat(), "run_id": run_id, "source_fingerprint": sources.source_fingerprint,
        "publication_revision": run_id, "generated_at_bangkok": generated_at,
        "canonical_model": model.package_lots.canonical_model, "candidate_model_version": PACKAGE_MODEL_VERSION,
        "model_mode": "SHADOW" if model.package_lots.canonical_model != PACKAGE_MODEL_VERSION else "CANONICAL",
        "hard_qa_status": "PASS", "review_conditions": ";".join(model.review_conditions) or "NONE",
        "evidence_format": "VALIDATED_VALUES", "automatic_exact_liability_thb": quality["automatic_exact_liability_thb"],
        "finance_reviewed_liability_thb": quality["finance_reviewed_liability_thb"],
        "composite_verified_event_count": quality["composite_verified_event_count"],
        "receipt_candidate_event_count": quality["receipt_candidate_event_count"],
        "reversal_conflict_count": quality["reversal_conflict_count"],
        "missing_receipt_evidence_count": quality["missing_receipt_evidence_count"],
    }
    contract["Model Status"] = [["field", "value", "notes"], *[[key, value, ""] for key, value in status_fields.items()]]
    audit = {
        "sources": {key: clean(getattr(sources, key).to_dict("records")) for key in ["credit_events", "credit_balances", "sales_support", "wise_receipts", "manifest"]},
        "accounts": clean(model.accounts.to_dict("records")), "events": clean(model.events.to_dict("records")),
        "lots": clean(model.package_lots.lots.to_dict("records")),
        "recognitions": clean(model.package_lots.recognitions.to_dict("records")),
        "matches": clean(model.package_lots.receipt_match_index.to_dict("records")),
        "controls": clean(asdict(raw_control)), "opening_baselines_to_write": clean(model.package_lots.opening_baselines_to_write.to_dict("records")),
        "qa": clean([asdict(check) for check in model.qa_results]) + daily["qa"],
    }
    bundle = clean({"schemaVersion": 5, "status": status_fields, "tables": contract, "reports": daily, "audit": audit,
                    "controlFingerprint": _fingerprint(asdict(raw_control)), "controlValuesHash": hashlib.sha256(json.dumps(clean(control_values), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(), "previousStatus": status})
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    with gzip.open(temp, "wt", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    os.chmod(temp, 0o600)
    temp.replace(output)
    print(json.dumps({"ok": True, "bundle": str(output), "runId": run_id, "cutoff": cutoff.isoformat(), "days": len(daily["finance"]), "months": len(daily["months"]), "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(1)
