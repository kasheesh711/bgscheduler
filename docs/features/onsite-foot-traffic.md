# Onsite Foot Traffic

**Status: stable in code; production rollout requires migration `0073` and an immutable pseudonym secret.** The dashboard, sync, exports, report snapshots, and HTML/PDF renderers are implemented and tested. Until `FOOT_TRAFFIC_PSEUDONYM_SECRET` is configured and the first backfill succeeds, the page correctly shows no coverage rather than inventing actuals.

## Purpose

Onsite Foot Traffic is the internal research view for the number of students BeGifted classes bring into the centre. Its primary metric is a **student-visit**: one qualifying student attending one onsite class. This is a class-attendance proxy, not a physical door-counter measurement; it cannot observe companions, staff, passers-by, or a student entering more than once.

The default research preset is 1 March–30 September 2026. Before September closes, the dashboard labels the final month **September MTD** and caps it at the latest fully reconciled Bangkok day. The collector continues daily after September, and operators may select any authenticated date range up to 366 days.

The feature is intentionally separate from [Room Capacity](./room-capacity.md). Room Capacity measures scheduled room-hours from its older utilization store. Foot Traffic uses Wise's `PAST` feed, attendance evidence, positive consumed credit, and a dedicated reconciliation ledger. No Room Capacity UI or calculation changes as part of this feature.

## Counting rules

A participant contributes exactly one visit when all of these are true:

1. the session has ended;
2. the session type resolves to offline / onsite / in-person;
3. the Wise location maps to an active `classroom_rooms` row whose category is not `online_only`;
4. the participant is not marked or role-labelled as a teacher; and
5. the participant has positive consumed credit.

An onsite class is counted only when at least one qualifying visit survives those rules. Unique students are distinct HMAC-SHA256 fingerprints of stable Wise student IDs. A visit with positive attendance evidence but no stable ID still contributes to visits and class counts, but not to unique students. This keeps the headline attendance number honest without claiming an identity the source did not provide.

The canonical classifier lives in `src/lib/onsite-foot-traffic/model.ts`. It stores no student name, raw student ID, session title, or class name. Subject, tutor, room, time, Wise session ID, consumed credit, and the pseudonymous fingerprint are the only detailed export fields.

## Data quality and exclusions

The dashboard and report carry the same quality ledger as the canonical session rows:

- cancelled and missed sessions;
- records whose end state cannot be proved;
- online or otherwise non-onsite types;
- missing, unknown, inactive, or `online_only` rooms;
- sessions and participant rows without positive-credit attendance evidence; and
- qualifying visits without a stable participant ID.

These signals may overlap at participant and session level, so the dashboard presents them as diagnostic counts rather than a single mutually exclusive funnel. Unknown rooms fail closed: they never become visits until the room catalogue maps them.

## Collection and correction model

`runOnsiteFootTrafficSync` (`src/lib/onsite-foot-traffic/sync.ts`) reads Wise PAST sessions in bounded windows. Wise treats the source request's `endDate` as exclusive, so each internal request advances that boundary by one Bangkok day while the dashboard range remains inclusive; adjacent chunks meet exactly without dropping their boundary dates. With no successful run, it backfills from `2026-03-01` through the latest completed Bangkok day. Later scheduled runs replace the previous 35 completed days, so delayed attendance edits and cancellations remove or replace prior rows.

All Wise fetches finish before the database replacement starts. The requested window is then deleted and rebuilt transactionally; if a fetch or classification fails, existing canonical data remains untouched. A partial unique index permits one `running` ledger row, and stale runs older than 20 minutes are failed before the next claim. The scheduled route is `GET /api/internal/sync-onsite-foot-traffic`, daily at 01:18 Bangkok (`18 18 * * *` UTC), with an 800-second ceiling and direct `cron_invocations` audit. Data Health also reads `onsite_foot_traffic_sync_runs` as inferred evidence.

For an explicit repair or first rollout, run:

```bash
npm run foot-traffic:backfill -- --start-date=2026-03-01 --end-date=2026-09-03
```

Omit `--end-date` to use the latest completed Bangkok date. The script requires `DATABASE_URL`, Wise credentials, `WISE_INSTITUTE_ID`, and `FOOT_TRAFFIC_PSEUDONYM_SECRET`. The secret is an identity boundary: generate it once, store it in the deployment secret manager, and never rotate it. Rotation would split one student's historical fingerprint into two identities until all affected history was rebuilt with the same key.

When the production pseudonym key is stored as a non-exportable Vercel sensitive value, operators can run the same repair inside the deployed function with `GET /api/internal/sync-onsite-foot-traffic?mode=backfill&startDate=2026-03-01&endDate=YYYY-MM-DD` and the normal `CRON_SECRET` bearer header. Date overrides are rejected unless `mode=backfill`; an unparameterized scheduled request retains rolling behavior.

## Dashboard and exports

The authenticated `/onsite-foot-traffic` page is registered as **Foot Traffic** under Scheduling & Tutors. Full admins see it automatically. Middleware's normal page-to-API prefix rule means restricted admins need `/onsite-foot-traffic` in `allowedPages`; that grant also admits `/api/onsite-foot-traffic/**` and does not grant any other feature.

Date, room, and weekday selections are URL-backed. The response is capped at successful source coverage and includes a freshness timestamp, requested-versus-effective dates, partial week/month flags, and a September MTD flag. The page presents four KPIs, directly labelled weekly and monthly charts, weekday and room patterns, accessible text descriptions, and exact tables below every chart.

Five CSV exports reproduce the current filters. Aggregate files contain boundaries, partial-period state, visits, unique students, classes, averages, and source freshness. The visit file is de-identified and never includes student names or raw IDs. All CSVs are UTF-8 with a BOM, quote every field, and use CRLF rows for spreadsheet compatibility.

The feature-scoped visual layer follows the BeGifted design system: orange data marks, blue supporting UI, Cormorant Garamond display headings, Sarabun body/numerals, cream surfaces, and responsive layouts. Those tokens are scoped beneath `.begifted`, so the rest of BGScheduler remains unchanged.

## Analytics pack

**Create analytics pack** persists the current aggregate payload as an immutable, de-identified snapshot. Both downloads render that exact JSON snapshot, so a later sync cannot make the PDF disagree with the HTML. Snapshot links expire after 30 days; already downloaded files are standalone.

The HTML embeds the BeGifted logo, fonts, CSS, data, and labelled SVG charts without network references. The PDF route dynamically imports `playwright-core` and `@sparticuz/chromium`, renders the same HTML as portrait A4, and closes Chromium in `finally`. A response-size guard rejects files over 4.4 MB instead of risking a platform truncation. The pack includes executive KPIs, weekly/monthly trends, weekday and room patterns, exact tables, methodology, quality caveats, freshness, and next steps.

## Owned interfaces

- API mechanics: [Onsite Foot Traffic API](../reference/api/onsite-foot-traffic.md)
- Tables and relationships: [Onsite Foot Traffic database](../reference/database/erd-onsite-foot-traffic.md)
- Schedule and health evidence: [Cron reference](../reference/crons.md)
- Configuration: [Environment reference](../reference/env.md)

## Verification and rollout

Unit and component coverage pins classification, participant parsing, HMAC stability, Bangkok boundaries, Monday weeks, partial periods, repeated-student uniqueness, quality exclusions, CSV escaping/PII removal, filters, accessibility, and MTD labels. Postgres integration coverage pins idempotent replacement, cancellation removal, failed-fetch preservation, single-flight, and immutable reports. The report integration test uses real Chrome plus `pdfinfo`, `pdftotext`, and rendered page images to check portrait A4 geometry, selectable text, complete sections, nonblank pages, and the response limit.

Production activation remains an operator step: configure the immutable secret, apply migration `0073_funny_ego.sql`, deploy, run the full backfill, grant the research teammate access if restricted, reconcile representative March and August weeks against Wise, and watch the first scheduled runs in Data Health.
