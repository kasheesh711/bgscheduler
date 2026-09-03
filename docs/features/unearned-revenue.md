# Unearned Revenue

**Status: stable (read-only; FIFO shadow until Finance approval).** The dashboard is registered under
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

The workbook calculates two models on every refresh:

- `LEGACY_ACCOUNT_RATE` values each student/class account using the existing program rate. It remains
  canonical until Finance approves the exact live FIFO version and run in `Package Control`.
- `FIFO_PACKAGE_LOT_V1` attributes paid credit events to sales packages and consumes paid lots
  oldest-first before complimentary credits. A protected 1 March 2026 opening lot freezes the opening
  paid credits and liability. Purchases repair a negative balance before creating deferred liability.

An approval is version-specific. Changing the FIFO algorithm version makes the new result shadow
again automatically. Finance can also select the legacy model in `Package Control`. The dashboard
uses the workbook's published canonical fields and labels the other result and its delta as audit
evidence.

## Package attribution

The workbook tries, in order, an active Finance override, a unique exact transaction-number match,
then a unique match on normalized student nickname, program bucket, credit quantity, and a transaction
date within 21 days. Conflicting candidates remain `AMBIGUOUS`; events with no candidate remain
`UNATTRIBUTED`. Both are visible review conditions and use the pinned program rate rather than being
presented as a real package.

`Package Control` is deliberately stable and editable so Google version history preserves Finance's
decisions. The generated package/model tabs are staged and swapped. Invalid, duplicate, or
over-allocated overrides stop publication; ambiguous and residual lots do not.

## Reporting periods and drilldown

History begins in March 2026. The trend contains completed month-ends plus one `LATEST` row for the
latest completed Bangkok day. A partial month always shows its real cutoff, never a future month-end.

The overview exposes opening liability, newly deferred value, recognized revenue, closing liability,
remaining paid credits, population counts, attribution coverage, model comparison, and review counts.
The student table aggregates all class accounts by stable WISE student ID. Selecting a student writes
`student=<id>` into the URL and opens a detail drawer with account reconciliation and package lots, so
the drilldown is shareable and browser navigation works.

Every finance, student, account, and lot amount retains a numeric Google sheet ID, row, and A1 anchor.
Formula links use `#gid=<sheetId>&range=<A1>`. A matched lot also has a separate link to the immutable
source spreadsheet, source sheet ID, and source row. Opening, ambiguous, and unattributed lots have no
invented source link.

## Publication and failure model

The importer uses bounded reads: 200 status/QA rows, 500 period/comparison rows, 20,000 student and
account rows, and 100,000 lot rows. It reads model formulas separately and rejects missing or malformed
formula rows. It also rereads `Model Status` and sheet properties after all model tabs; a status change
or generated-tab ID rotation aborts the run.

A complete snapshot is staged in one database transaction, cross-level totals and lineages are
validated, and only then is it atomically promoted. The source run ID, fingerprint, revision, and
cutoff form the idempotency contract. A failed or not-yet-published workbook leaves the active snapshot
untouched. Snapshot and sync headers are retained forever; detail is retained for the active and
immediately preceding successful snapshots.

Workbook hard checks include:

- `opening + deferred - recognized = closing` for every period and account;
- finance total = students = accounts = package lots;
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
