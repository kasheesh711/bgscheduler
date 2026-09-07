# Unearned Revenue

**Status: stable (read-only website; V5 compact values publication, with V4 rollback support).** The dashboard is registered under
**Finance & Revenue** at `/unearned-revenue`. A daily importer runs at 01:30 Bangkok and only promotes
a workbook run after the workbook declares itself `PUBLISHED` and every hard accounting check passes.

## Purpose

This workspace answers three finance questions from the same reconciled ledger:

1. What was total unearned revenue at each completed reporting date?
2. How much unearned revenue belongs to each student?
3. Which package lots make up each student's balance?

The website is a read-only presentation layer. The WISE credit ledger and the linked Google workbook
remain the accounting authority. The dashboard never writes to WISE, `Package Control`, or a source
sales workbook.

## Accounting models

The existing Python engine calculates two models on every refresh:

- `LEGACY_ACCOUNT_RATE` values each student/class account using the existing program rate. It remains
  canonical until Finance approves the exact live FIFO version and run in `Package Control`.
- `FIFO_PACKAGE_LOT_V4` uses a three-way evidence bridge — sales row ↔ WISE fee receipt ↔ WISE credit
  event — and consumes paid lots oldest-first before complimentary credits. Receipts prove package
  identity and price but never replace the credit ledger as the balance authority. A protected 1 March
  2026 opening lot freezes the opening paid credits and liability. Purchases repair a negative balance
  before creating deferred liability.

An approval is version- and run-specific. The first V4 cutover must name the exact currently published,
QA-passed shadow run; after that cutover, later refreshes stay canonical while V4 is unchanged. Any V1,
V2, or V3 approval is stale automatically. Finance can also select the legacy model in `Package Control`. The
dashboard uses the workbook's published canonical fields and labels the other result and its delta as
audit evidence.

## Package attribution

The workbook tries, in order, an active Finance override, a unique direct transaction-ID match, a unique
receipt/invoice-identifier chain, and then a strict three-way composite match. Every automatic path first
requires the normalized sales nickname to equal the normalized WISE nickname. A populated mismatch is
rejected rather than offered as a candidate; a missing nickname remains review-only. Direct transaction and
receipt-identifier shortcuts still require `Recorded in WISE? = TRUE`. For the full composite path that checkbox
is advisory: an unchecked sale can be automatic only when the WISE receipt is a positive THB `CHARGED`
payment, receipt student/class IDs equal the ledger event, credits agree within 0.001, money
agrees within THB 0.01, sales **Payment Date** to receipt dates are within three Bangkok days, receipt-to-event dates are
within 21 days, recognized program buckets agree, and all three nodes have exactly one qualifying
counterpart globally. Such rows retain `recorded_in_wise: false` alongside the explicit
`ADVISORY_WISE_PROVEN` policy marker. Transaction Date is used only when Payment Date is missing. Free text and notes are
supporting evidence only.

Near matches are `COMPOSITE_CANDIDATE`; conflicting matches are `AMBIGUOUS`; events with no candidate
are `UNATTRIBUTED`. Those rows, synthetic opening lots, and any other residual use the pinned program
rate instead of being presented as a real package. A negative `Marked as unpaid` receipt reverses only
a unique preceding positive receipt for the same student, class, and absolute amount within 21 days.
Unpaired or non-unique reversals remain review conditions.

`Package Control` is deliberately stable and editable so Google version history preserves Finance's
decisions. Column J optionally records a `wise_receipt_id` for an override. V5 audit files preserve normalized receipt evidence and every candidate
edge; generated Finance values are staged and committed atomically. Invalid, duplicate, or
over-allocated overrides stop publication; ambiguous and residual lots do not.

## Reporting periods and drilldown

History begins on 1 March 2026. The Finance spreadsheet has three visible Thai tabs: `ภาพรวม`, `รายนักเรียน`, and `รายละเอียดแพ็กเกจ`. It shows every actual daily closing total, with date links to immutable monthly student/package reports. The main student and package views show the latest completed Bangkok day. Zero-balance students are retained. Opening/residual amounts and signed valuation adjustments reconcile the package breakdown to the approved `LEGACY_ACCOUNT_RATE` balance.

The website retains completed month-ends plus one `LATEST` row for the latest completed Bangkok day. A partial month always shows its real cutoff, never a future month-end.

The overview exposes opening liability, newly deferred value, recognized revenue, closing liability,
remaining paid credits, population counts, exact-package coverage, model comparison, and review counts.
`CALC_Exact_Package_Overview` in the values contract shows exact liability by literal sales package, split between
automatic evidence and documented Finance overrides. Opening and unresolved lots remain residual and never
appear under a real package name.
The student table aggregates all class accounts by stable WISE student ID. Selecting a student writes
`student=<id>` into the URL and opens a detail drawer with account reconciliation and package lots, so
the drilldown is shareable and browser navigation works.

V5 values retain links to published report rows or their immutable audit file, labelled as published evidence. V4 snapshots retain their original formula links. A matched lot can expose independent links to its
published evidence, original sales row, original credit-ledger row, and normalized WISE receipt evidence.
Opening, ambiguous, and unattributed lots never receive invented source links.

## Publication and failure model

The publisher fetches WISE fee transactions from 1 March 2026 through cutoff in non-overlapping Bangkok
windows with complete pagination and a 10,000-row global safety limit. A failed/truncated receipt fetch
or conflicting duplicate receipt ID blocks workbook publication. The website importer uses bounded
reads: 200 status/QA rows, 500 period/comparison rows, 10,000 receipt rows, 20,000 student and account
rows, 100,000 lot rows, and 500 exact-package summary rows. For V4 it reads model formulas separately and rejects missing or malformed formula rows. V5 reads a checksummed manifest and values contract, verifies audit/report access, mandatory QA, daily coverage and row counts, and preserves manifest metadata on each snapshot. Schema V4 accepts both the historical FIFO V3 and current FIFO V4 runtime
during rollout. It validates receipt IDs, checksums, run lineage, embedded row numbers, automatic nickname
evidence, every lot-to-receipt trace, and exact-package roll-forwards. An unchecked V4 exact lot is rejected
unless it carries the full composite rule, receipt, identity, amount, credit, date, program, and policy evidence. It also
rereads `Model Status` and sheet properties after all
model tabs; a status change or generated-tab ID rotation aborts the run.

A complete snapshot is staged in one database transaction, cross-level totals and lineages are
validated, and only then is it atomically promoted. The source run ID, fingerprint, revision, and
cutoff form the idempotency contract. A failed or not-yet-published workbook leaves the active snapshot
untouched. Snapshot and sync headers are retained forever; detail is retained for the active and
immediately preceding successful snapshots.

Workbook hard checks include:

- `opening + deferred - recognized = closing` for every period and account;
- finance total = students = accounts = package lots;
- exact-package total = attributed liability, and automatic + Finance-reviewed = exact;
- exact-package liability + residual liability = FIFO liability;
- ledger and lot credit balances within 0.001 credits;
- THB identities and Python-versus-Sheet values within THB 1;
- valid formula outputs, override allocations, run IDs, and source lineages.

## Access and operations

The feature has dedicated `viewer` and `access_manager` grants, resolved from Postgres on every
request. These grants may supersede a user's legacy `allowedPages` restriction for this feature only.
An access manager can retry an import and edit the grant matrix; a transaction prevents self-removal
and removal of the final access manager. Every change is recorded in an immutable audit table with an
optimistic-lock version.

Configuration defaults to workbook
`1AY6sAjw3rwAhdJCzMWR6qW0utBU91sv-JZWH1223mZc` and connected account
`kevhsh7@gmail.com`; production should set both explicitly. The Google OAuth token is read from the
existing connected-account store.

Mechanical details: [API](../reference/api/unearned-revenue.md),
[database](../reference/database/erd-unearned-revenue.md), and [cron](../reference/crons.md).

## Local publisher operations

See [V5 publisher runbook](../reference/unearned-revenue-publisher.md) for the Python extension, local runner, capacity checks, archive revisions, atomic cutover, verification and rollback. The existing local 00:15 publisher and Vercel 01:30 importer schedules remain unchanged.
