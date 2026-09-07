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

    def test_multiple_package_allocations_remain_separate(self):
        model = self.model()
        second = dict(model.package_lots.lots.iloc[0])
        second.update(lot_id="second", package_name="Second package", deferred_paid_credits=1)
        model.package_lots.lots.loc[0, "deferred_paid_credits"] = 2
        model.package_lots.lots = pd.concat([model.package_lots.lots, pd.DataFrame([second])], ignore_index=True)
        model.package_lots.lot_creation_dates["second"] = date(2026, 3, 2)
        report = daily_reports(model, date(2026, 3, 1), date(2026, 3, 6))
        rows = [r for r in report["months"]["2026-03"]["packages"] if r["date"] == "2026-03-02" and r["kind"] == "PAID_PACKAGE"]
        self.assertEqual({r["lot_id"] for r in rows}, {"paid", "second"})
        self.assertEqual(sum(r["liability_thb"] for r in rows), 270)
        self.assertTrue(all(r["class_subject"] == "Math" for r in rows))

    def test_source_correction_revises_daily_values_and_keeps_original_result(self):
        original = daily_reports(self.model(), date(2026, 3, 1), date(2026, 3, 6))
        corrected = self.model()
        corrected.accounts.loc[0, "selected_rate_thb"] = 120
        corrected.events.loc[:, "account_rate_thb"] = 120
        revised = daily_reports(corrected, date(2026, 3, 1), date(2026, 3, 6))
        self.assertEqual(original["finance"][1]["liability_thb"], 300)
        self.assertEqual(revised["finance"][1]["liability_thb"], 360)
        self.assertNotEqual(original, revised)
        self.assertEqual(sum(r["liability_thb"] for r in revised["months"]["2026-03"]["packages"] if r["date"] == "2026-03-02"), 360)

    def test_unresolved_attribution_is_explicit_and_can_have_negative_adjustment(self):
        model = self.model()
        model.package_lots.lots.loc[0, "lot_kind"] = "UNATTRIBUTED"
        model.package_lots.lots.loc[0, "unit_rate_thb"] = 110
        report = daily_reports(model, date(2026, 3, 1), date(2026, 3, 6))
        rows = [r for r in report["months"]["2026-03"]["packages"] if r["date"] == "2026-03-02"]
        self.assertEqual([r["package_name"] for r in rows if r["kind"] == "UNATTRIBUTED"], ["ยังระบุแพ็กไม่ได้"])
        self.assertEqual([r["liability_thb"] for r in rows if r["kind"] == "VALUATION_ADJUSTMENT"], [-30])
        self.assertEqual(sum(r["liability_thb"] for r in rows), 300)
