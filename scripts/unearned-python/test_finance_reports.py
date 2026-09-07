from datetime import date
from types import SimpleNamespace
import unittest
import pandas as pd
from begifted_dashboard.finance_reports import daily_reports
from begifted_dashboard.unearned_google_sheet import _calculate_python_model
from begifted_dashboard.package_lots import LEGACY_MODEL


class DailyReportsTest(unittest.TestCase):
    def model(self):
        accounts = pd.DataFrame([dict(account_id="a", student_id="s", student_name="Test", class_id="c", class_name="Math", class_subject="Math", baseline_credit_balance=-2, baseline_paid_credits=0, baseline_liability_thb=0, selected_rate_thb=100)])
        events = pd.DataFrame([dict(event_key=key, account_id="a", student_id="s", class_id="c", event_timestamp=day.isoformat(), event_date=day, event_kind=kind, credits_added=added, credits_consumed=used, is_complimentary=free, complimentary_source_key="") for key, day, kind, added, used, free in [
            ("paid", date(2026, 3, 2), "CREDIT", 5, 0, False),
            ("free", date(2026, 3, 3), "CREDIT", 2, 0, True),
            ("use", date(2026, 3, 5), "SESSION", 0, 1, False),
            ("refund", date(2026, 3, 6), "CREDIT", -1, 0, False),
        ]])
        calculated, _, _, _ = _calculate_python_model(accounts, events, model_start=date(2026, 3, 1), cutoff=date(2026, 3, 31))
        lots = pd.DataFrame([dict(lot_id=key, account_id="a", student_id="s", student_name="Test", class_name="Math", deferred_paid_credits=credits, unit_rate_thb=rate, lot_kind=kind, package_name="Package") for key, credits, rate, kind in [("paid", 3, 90, "PAID_PACKAGE"), ("free", 2, 0, "COMPLIMENTARY")]])
        package = SimpleNamespace(lots=lots, lot_creation_dates={"paid": date(2026, 3, 2), "free": date(2026, 3, 3)}, recognitions=pd.DataFrame([dict(lot_id="paid", recognition_date=date(2026, 3, day), recognized_paid_credits=1) for day in [5, 6]]), canonical_model=LEGACY_MODEL, account_periods=pd.DataFrame())
        return SimpleNamespace(accounts=accounts, events=calculated, package_lots=package)

    def test_actual_daily_closes_carry_forward_and_reconcile(self):
        report = daily_reports(self.model(), date(2026, 3, 1), date(2026, 4, 2))
        totals = {row["date"]: row["liability_thb"] for row in report["finance"]}
        self.assertEqual(totals["2026-03-01"], 0)
        self.assertEqual(totals["2026-03-02"], 300)
        self.assertEqual(totals["2026-03-04"], 300)
        self.assertEqual(totals["2026-03-05"], 200)
        self.assertEqual(totals["2026-03-06"], 100)
        self.assertEqual(totals["2026-04-02"], 100)
        self.assertEqual(set(report["months"]), {"2026-03", "2026-04"})
        march5 = [row for row in report["months"]["2026-03"]["packages"] if row["date"] == "2026-03-05"]
        self.assertEqual(sum(row["liability_thb"] for row in march5), 200)
        self.assertEqual([row["liability_thb"] for row in march5 if row["kind"] == "VALUATION_ADJUSTMENT"], [20])
        self.assertTrue(all(row["status"] == "PASS" for row in report["qa"]))
        self.assertEqual(len(report["months"]["2026-03"]["students"]), 31)

    def test_mismatched_period_balance_blocks_report(self):
        model = self.model()
        model.package_lots.account_periods = pd.DataFrame([dict(period_end=date(2026, 3, 5), account_id="a", canonical_closing_liability_thb=300, fifo_closing_liability_thb=270)])
        with self.assertRaisesRegex(ValueError, "Daily reconciliation"):
            daily_reports(model, date(2026, 3, 1), date(2026, 3, 6))

    def test_duplicate_or_excess_recognition_fails_closed(self):
        model = self.model()
        model.package_lots.recognitions.loc[0, "recognized_paid_credits"] = 10
        with self.assertRaisesRegex(ValueError, "over-consumption"):
            daily_reports(model, date(2026, 3, 1), date(2026, 3, 6))
