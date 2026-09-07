"""Compact, values-only daily projections of the existing accounting engine.

No source fetches or Google writes happen here. Matching and valuation remain in
package_lots/unearned_google_sheet; this module only projects their event ledger.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict
from datetime import date, datetime, timedelta
import json
import math
from typing import Any

import pandas as pd

from .package_lots import LEGACY_MODEL
from .unearned_google_sheet import GoogleSheetPublisher, MODEL_TABS, ModelTables, ExtractedSources, QAResult


def clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()
    if hasattr(value, "item"):
        return clean(value.item())
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite financial value")
        if value.is_integer():
            return int(value)
    return value


def sheet_url(file_id: Any, sheet_id: Any, row: Any) -> str:
    file_id, sheet_id, row = clean(file_id), clean(sheet_id), clean(row)
    if not file_id or sheet_id in (None, "") or row in (None, ""):
        return ""
    return f"https://docs.google.com/spreadsheets/d/{file_id}/edit#gid={int(sheet_id)}&range=A{int(row)}:AZ{int(row)}"


def daily_reports(model: ModelTables, model_start: date, cutoff: date) -> dict[str, Any]:
    if cutoff < model_start:
        raise ValueError("Daily report cutoff precedes model start")
    accounts = model.accounts.to_dict("records")
    account_by_id = {str(row["account_id"]): row for row in accounts}
    events_by_day: dict[date, list[dict]] = defaultdict(list)
    legacy_balance = {str(row["account_id"]): float(row["baseline_paid_credits"]) * float(row["selected_rate_thb"]) for row in accounts}
    credit_balance = {str(row["account_id"]): float(row["baseline_credit_balance"]) for row in accounts}
    for event in model.events.sort_values(["event_timestamp", "event_key"], kind="stable").to_dict("records"):
        day = event["event_date"]
        if day < model_start:
            legacy_balance[str(event["account_id"])] = float(event["closing_paid_credits"]) * float(event["account_rate_thb"])
            credit_balance[str(event["account_id"])] = float(event["closing_credit_balance"])
        elif day <= cutoff:
            events_by_day[day].append(event)
    lots = model.package_lots.lots.to_dict("records")
    additions: dict[date, list[dict]] = defaultdict(list)
    remaining: dict[str, float] = {}
    for lot in lots:
        lot_id = str(lot["lot_id"])
        if lot_id not in model.package_lots.lot_creation_dates:
            raise ValueError(f"Missing creation date for lot {lot_id}")
        created = model.package_lots.lot_creation_dates[lot_id]
        remaining[lot_id] = float(lot["deferred_paid_credits"]) if created < model_start else 0.0
        if created >= model_start:
            additions[created].append(lot)
    recognitions: dict[date, list[dict]] = defaultdict(list)
    for recognition in model.package_lots.recognitions.to_dict("records"):
        recognitions[recognition["recognition_date"]].append(recognition)
    students: dict[str, dict] = {}
    for account in accounts:
        students.setdefault(str(account["student_id"]), {"student_id": str(account["student_id"]), "student_name": account["student_name"]})
    monthly: dict[str, dict[str, list]] = {}
    finance: list[dict] = []
    max_credit_difference = 0.0
    max_period_difference = 0.0
    max_student_difference = 0.0
    period_accounts = {(row["period_end"], str(row["account_id"])): row for row in model.package_lots.account_periods.to_dict("records")}
    day = model_start
    while day <= cutoff:
        for event in events_by_day[day]:
            key = str(event["account_id"])
            legacy_balance[key] = float(event["closing_paid_credits"]) * float(event["account_rate_thb"])
            credit_balance[key] = float(event["closing_credit_balance"])
        for lot in additions[day]:
            remaining[str(lot["lot_id"])] += float(lot["deferred_paid_credits"])
        for recognition in recognitions[day]:
            key = str(recognition["lot_id"])
            remaining[key] -= float(recognition["recognized_paid_credits"])
            if remaining[key] < -0.001:
                raise ValueError(f"Daily lot over-consumption: {day} {key}")
            remaining[key] = max(0.0, remaining[key])
        fifo_account: dict[str, float] = defaultdict(float)
        lot_credits: dict[str, float] = defaultdict(float)
        package_rows: list[dict] = []
        for lot in lots:
            quantity = remaining[str(lot["lot_id"])]
            key = str(lot["account_id"])
            amount = quantity * float(lot["unit_rate_thb"])
            fifo_account[key] += amount
            lot_credits[key] += quantity
            if amount <= 1e-8:
                continue
            residual = lot["lot_kind"] != "PAID_PACKAGE"
            label = "ยอดยกมา" if lot["lot_kind"] == "OPENING" else "ยังระบุแพ็กไม่ได้" if residual else lot.get("package_name", "")
            package_rows.append({
                "date": day.isoformat(), "student_id": str(lot["student_id"]),
                "student_name": lot["student_name"], "account_id": key,
                "class_name": lot["class_name"], "lot_id": str(lot["lot_id"]),
                "package_name": label, "kind": lot["lot_kind"],
                "purchase_date": clean(lot.get("payment_date") or lot.get("transaction_date")) if not residual else None,
                "transaction_number": lot.get("transaction_number", "") if not residual else "",
                "remaining_credits": quantity, "liability_thb": amount,
                "source_url": sheet_url(lot.get("sales_source_file_id"), lot.get("sales_source_sheet_id"), lot.get("sales_source_row")) if not residual else "",
                "credit_url": sheet_url(lot.get("credit_event_source_file_id"), lot.get("credit_event_source_sheet_id"), lot.get("credit_event_source_row")),
            })
        student_totals: dict[str, float] = defaultdict(float)
        for key, account in account_by_id.items():
            max_credit_difference = max(max_credit_difference, abs(max(0, credit_balance[key]) - lot_credits[key]))
            canonical = legacy_balance[key] if model.package_lots.canonical_model == LEGACY_MODEL else fifo_account[key]
            student_totals[str(account["student_id"])] += canonical
            expected = period_accounts.get((day, key))
            if expected is not None:
                max_period_difference = max(max_period_difference, abs(canonical - float(expected["canonical_closing_liability_thb"])), abs(fifo_account[key] - float(expected["fifo_closing_liability_thb"])))
            adjustment = canonical - fifo_account[key]
            if abs(adjustment) > 1e-8:
                package_rows.append({
                    "date": day.isoformat(), "student_id": str(account["student_id"]), "student_name": account["student_name"],
                    "account_id": key, "class_name": account["class_name"], "lot_id": "VALUATION:" + key,
                    "package_name": "ส่วนต่างวิธีประเมิน", "kind": "VALUATION_ADJUSTMENT",
                    "purchase_date": None, "transaction_number": "", "remaining_credits": None,
                    "liability_thb": adjustment, "source_url": "", "credit_url": "",
                })
        components: dict[str, float] = defaultdict(float)
        for row in package_rows:
            components[row["student_id"]] += row["liability_thb"]
        for key, total in student_totals.items():
            max_student_difference = max(max_student_difference, abs(total - components[key]))
        student_rows = [{"date": day.isoformat(), **student, "liability_thb": student_totals[key]} for key, student in students.items()]
        student_rows.sort(key=lambda row: (-row["liability_thb"], row["student_name"], row["student_id"]))
        package_rows.sort(key=lambda row: (row["student_id"], row["class_name"], row["kind"] == "VALUATION_ADJUSTMENT", row["purchase_date"] or "", row["lot_id"]))
        total_row = {"date": day.isoformat(), "liability_thb": sum(student_totals.values()), "student_count": len(student_rows)}
        finance.append(total_row)
        month = monthly.setdefault(day.strftime("%Y-%m"), {"finance": [], "students": [], "packages": []})
        month["finance"].append(total_row)
        month["students"].extend(student_rows)
        month["packages"].extend(package_rows)
        day += timedelta(days=1)
    checks = [
        QAResult("QA-DAILY-CREDITS", "HARD", max_credit_difference, 0, max_credit_difference, 0.001, "PASS" if max_credit_difference <= 0.001 else "FAIL", "Daily lot credits reconcile to ledger"),
        QAResult("QA-DAILY-PERIODS", "HARD", max_period_difference, 0, max_period_difference, 1, "PASS" if max_period_difference <= 1 else "FAIL", "Daily closes reproduce the unchanged monthly engine"),
        QAResult("QA-DAILY-STUDENTS", "HARD", max_student_difference, 0, max_student_difference, 1, "PASS" if max_student_difference <= 1 else "FAIL", "Daily student totals equal package and explicit adjustment rows"),
    ]
    if any(check.status != "PASS" for check in checks):
        raise ValueError("Daily reconciliation failed: " + json.dumps(clean([asdict(check) for check in checks])))
    return {"months": clean(monthly), "finance": clean(finance), "qa": clean([asdict(check) for check in checks])}


def values_contract(sources: ExtractedSources, model: ModelTables, config: dict, cutoff: date, run_id: str) -> dict[str, list[list[Any]]]:
    """Reuse the V4 wire columns/evidence, replacing calculations with engine values.

    The full legacy row builder is deliberately not published to Sheets. Keeping
    its column contract avoids a separate, drifting attribution serializer.
    """
    rows = GoogleSheetPublisher(None, "", config)._stage_rows({name: name for name in MODEL_TABS}, sources, model, cutoff, run_id=run_id)
    frames = {
        "Model Comparison": model.package_lots.finance_periods,
        "CALC_Student_Period": model.package_lots.student_periods,
        "CALC_Account_Period": model.package_lots.account_periods,
        "CALC_Package_Lot_Period": model.package_lots.lot_periods,
        "CALC_Exact_Package_Overview": model.package_lots.exact_package_periods.sort_values(["period_end", "closing_exact_liability_thb", "package_name"], ascending=[True, False, True], kind="stable") if not model.package_lots.exact_package_periods.empty else model.package_lots.exact_package_periods,
    }
    legacy = {row["month_end"]: row for row in model.monthly_finance.to_dict("records")}
    result = {}
    for title, frame in frames.items():
        headers = rows[title][0]
        values = rows[title][1:]
        records = frame.to_dict("records")
        if len(values) != len(records):
            raise ValueError(f"Contract row count mismatch: {title}")
        for output, original in zip(values, records):
            record = dict(original)
            if title == "CALC_Account_Period":
                record["identity_difference_thb"] = record["fifo_opening_liability_thb"] + record["fifo_deferred_new_liability_thb"] - record["fifo_recognized_revenue_thb"] - record["fifo_closing_liability_thb"]
            if title == "Model Comparison":
                record["fifo_vs_legacy_difference_thb"] = record["fifo_closing_liability_thb"] - record["legacy_closing_liability_thb"]
                if model.package_lots.canonical_model == LEGACY_MODEL:
                    source = legacy[pd.Period(record["period_end"], freq="M").end_time.date()]
                    for field in ("opening_liability_thb", "deferred_new_liability_thb", "recognized_revenue_thb"):
                        record[field] = source[field]
                record["identity_difference_thb"] = record["opening_liability_thb"] + record["deferred_new_liability_thb"] - record["recognized_revenue_thb"] - record["canonical_closing_liability_thb"]
            for index, value in enumerate(output):
                if isinstance(value, str) and value.startswith("="):
                    column = headers[index]
                    if column == "source_row_url":
                        output[index] = sheet_url(record.get("source_file_id"), record.get("source_sheet_id"), record.get("source_row"))
                    elif column in record:
                        output[index] = record[column]
                    else:
                        raise ValueError(f"Missing native calculation for {title}.{column}")
        result[title] = clean([headers, *values])
    result["SRC_Wise_Receipt"] = clean(rows["SRC_Wise_Receipt"])
    qa_headers = ["check_id", "severity", "actual", "expected", "difference", "tolerance", "status", "notes"]
    result["QA Checks"] = clean([qa_headers, *[[asdict(check).get(key) for key in qa_headers] for check in model.qa_results]])
    return result
