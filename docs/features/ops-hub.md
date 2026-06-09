# Ops Hub

**Status: stable**

## Purpose

The Ops Hub is BGScheduler's landing experience — the page an admin lands on at `/` after login. It answers a single question for non-technical admin staff: _"What needs my attention across all the operational subsystems right now, and is the data behind them fresh?"_

Rather than dropping the user into one feature (the app previously redirected `/` → `/search`), it presents a single read-only home that rolls up the action queues, data freshness, and shortcuts a daily operator cares about. Every signal it shows is access-filtered to the viewer's `allowedPages`, so a restricted account only sees the queues it can actually open.

The hub is built from three pieces that landed together in commit `d4fe6d3` ("feat: add ops hub navigation"):

- a **home page** at `/` (`src/app/(app)/page.tsx`) that renders the hub;
- a **home-summary aggregator** (`src/lib/home/summary.ts`) behind a single read endpoint;
- a **navigation tool registry** (`src/lib/navigation/tools.ts`) that is the shared source of truth for both the hub and the reworked top nav.

## What the hub surfaces

The hub renders three sections (`src/components/home/home-hub.tsx`), titled **"BeGifted Ops"**:

### Action Queues

A grid of cards, one per accessible queue, each showing a count, a one-line detail, and a link into the owning workspace. The count and detail are aggregated server-side by `getHomeSummaryPayload` (`src/lib/home/summary.ts`). Cards are tinted by state: amber when the value is `> 0` (work waiting), emerald when zero, red on a source error (the value renders as `!`). The seven queues, with the exact signal each pulls:

| Queue | Count | Detail | Source |
|---|---|---|---|
| **Leave Requests** | `unreadActionCount` | `{new} new, {needsReview} needs review` | `listLeaveRequests(db, { summaryOnly: true })` |
| **LINE AI Review** | rows in `line_scheduler_reviews` with status `pending_review` | "Pending parent-message reviews" | direct count query (`countLinePendingReviews`) |
| **Progress Tests** | `due + approaching` cycles | `{due} due, {approaching} approaching` | direct count of `progress_test_cycle_state` by status (`countProgressTestActions`) |
| **Credit Control** | at-risk `queue.students` | `{packages.notify} notify packages` | `getCreditControlPayload` |
| **Payroll** | current-month `summary.issueCount` | `{unresolvedTutorCount} unresolved tutors` | `getPayrollPayload(db, <Bangkok YYYY-MM>)` |
| **Wise Audit** | `rowsNeedingReview` | `{matched} matched of {saleRows} rows`, or "No imported package-sales source" | `getWiseReconciliationActionSummary` (package-sales reconciliation) |
| **Data Health** | `lateCount + failingCount` crons | the data-health `overall.detail` string | `getDataHealthDashboardPayload` |

For what these signals mean, see the owning feature docs — this card row does not restate their mechanics:
- [Credit Control](./credit-control.md) (at-risk queue + notify packages),
- [Wise Activity Audit](./wise-activity-audit.md) (package-sales reconciliation rows needing review),
- [Data Health](./data-health.md) (cron health counts).

### Data Freshness

A three-card strip derived entirely from the Data Health dashboard payload plus the Google token status:

- **Wise snapshot** — the staleness of the active search snapshot (`staleMinutes`, formatted as "min/h ago"), keyed off Data Health's last successful sync. Tinted amber past 120 minutes.
- **Cron health** — `{healthy} healthy, {late+failing} issues`, with `running` / `manual-only` / `unknown` counts as detail. Red if any cron is failing or Data Health itself errored.
- **Google Sheets** — connection state of the viewer's Google OAuth token ("Connected with write access" / "Connected read-only" / "Not connected"), from `getGoogleTokenStatus(email, db)`. This backs the Sheets-dependent imports (sales, leave requests).

### Curated Shortcuts

A grid of quick-jump cards built from the navigation registry's "shortcut" tools (see below), access-filtered to the viewer. The default shortcut set is Scheduler, Search, Class Assignments, Data Health.

## Navigation tooling

`src/lib/navigation/tools.ts` is **not** a command palette or an AI tool surface — it is a plain, static **navigation registry**: the single declarative source of truth for the app's pages, the section they group under, their badge wiring, and access rules. Both the Ops Hub and the reworked top nav (`src/components/layout/app-nav.tsx`) consume it; the home-summary aggregator also reads it to resolve labels/hrefs and to access-gate each queue.

It declares:

- **`NAV_SECTIONS`** — four business-function groups, in display order: **Scheduling & Tutors**, **Student Lifecycle**, **Finance & Revenue**, **Data & Audit**.
- **`NAV_TOOLS`** — the 15 in-app tools (`/scheduler`, `/search`, `/line-review`, `/leave-requests`, `/class-assignments`, `/tutor-profiles`, `/room-capacity`, `/scheduler/metrics`, `/progress-tests`, `/student-promotions`, `/sales-dashboard`, `/credit-control`, `/payroll`, `/wise-activity`, `/data-health`), each with a `label`, `description`, owning `section`, an optional `badgeKey` (the 7 action-queue counts above), and an optional `shortcut` flag.
- **`HOME_HREF`** (`"/"`) and a set of pure helpers: `canAccessHref` (access predicate), `filterToolsByAccess` / `sectionTools` / `visibleSections` (access-filtered grouping), `isActivePath` / `activeSection` (active-link detection), and `shortcutTools` (the curated shortcut set).

The top nav uses this registry to render section dropdowns, highlight the active section, and show badge counts. It fetches `GET /api/home/summary` once on mount (only when a visible badged tool exists) and overlays each tool's count as an amber badge, summing per section — so the badge numbers in the nav and the action-card values on the hub come from the same payload.

## Access model

The hub and its data are gated by the same page-level `allowedPages` model used across the app (a `null` `allowedPages` means a full-access admin; a list means a restricted account).

- **The page (`src/app/(app)/page.tsx`)** calls `auth()` and redirects to `/login` with no session. For a restricted user with exactly one allowed page, it redirects straight to that page (`allowedPages[0]`) — single-page accounts skip the hub entirely. Everyone else (full admins, and restricted users with two or more pages) sees the hub.
- **Middleware (`src/middleware.ts`)** gates `/` for restricted users: `isPathAllowed` returns `true` for `/` only when `allowedPages.length > 1`; a restricted user who is not allowed `/` is redirected to their landing page. The same commit also explicitly allowlists the summary endpoint in middleware — `if (pathname === "/api/home/summary") return true;` — so the nav can always fetch badge counts regardless of which specific pages the user is scoped to (the handler still enforces its own auth, and the payload is itself access-filtered).
- **The registry's `canAccessHref("/", allowedPages)`** mirrors this rule: `true` for full admins and for restricted users with more than one allowed page, `false` for a single-page (or empty) restriction.
- **The aggregator (`getHomeSummaryPayload`)** is itself access-aware: each of the seven action queues is only loaded and emitted when `canAccessHref(tool.href, allowedPages)` passes, so a restricted user's payload contains only the queues they can open (e.g. a `["/progress-tests"]` account gets a single `progressTests` action). Google Sheets status is always fetched.

All times are `Asia/Bangkok` (the payroll month and the snapshot staleness are computed against Bangkok), and the "Updated HH:MM" badge renders in 24-hour `en-GB` time.

## `/` entry-point change

This commit **changes what `/` does**. Previously `src/app/page.tsx` was a four-line redirect (`redirect("/search")`); that file was deleted, and `/` now resolves to `src/app/(app)/page.tsx`, which renders the Ops Hub (inside the authed `(app)` route group, so it gets the standard nav shell). The legacy `/compare` → `/search` redirect is unaffected — only the root path changed.

## API surface

One endpoint, **admin/authenticated** tier (Auth.js `auth()`, 401 if no session). Full request/response contract lives in [docs/reference/api/misc.md](../reference/api/misc.md#home--ops-hub).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/home/summary` | Returns the access-filtered hub payload — action-queue counts + data-freshness strip — by delegating to `getHomeSummaryPayload({ allowedPages, email }, getDb())`. Consumed by the top nav for badge counts; the home page itself server-fetches the same helper directly rather than via this route. |

## UI

- **Page**: `src/app/(app)/page.tsx` — an async Server Component (`HomeBody`) that calls `auth()` (redirect to `/login` if no email; redirect to the sole allowed page for single-page accounts), server-fetches `getHomeSummaryPayload(...)`, and passes it to the client shell. Wrapped in `<Suspense>` with a skeleton (`HomeSkeleton`).
- **Hub shell**: `src/components/home/home-hub.tsx` (`HomeHub`) — renders the action-queue grid, the freshness strip, and the curated-shortcut grid. Pure presentational component over the payload + `allowedPages` (shortcuts re-filtered client-side via `shortcutTools`).
- **Top nav**: `src/components/layout/app-nav.tsx` (`AppNav`) — `"use client"`; renders the registry's sections as dropdowns, fetches `GET /api/home/summary` once on mount to overlay badge counts, and routes the brand link to `/` for hub-eligible users (or to the user's landing page otherwise).

## Business rules & edge cases

- **Fail-soft aggregation.** Each source is loaded through `loadSource`, which catches and returns `{ data, error }` rather than throwing. One failing source (e.g. payroll) marks only that card `status: "error"` (value `null`, detail "Summary unavailable"); the other queues still render. Verified by a test that rejects `getPayrollPayload` and asserts the leave-requests card still carries its value.
- **Access-filtered queues.** A queue is loaded only if its tool's href passes `canAccessHref`; inaccessible queues are neither fetched nor emitted. The `Promise.all` fans out exactly the accessible loaders (inaccessible ones resolve to `{ data: null, error: null }` immediately).
- **Single-page accounts bypass the hub.** Both the page (`allowedPages?.length === 1` → redirect) and the access predicate (`canAccessHref("/", …)` requires `length > 1`) keep the hub off single-purpose logins.
- **Freshness degrades to an error card.** If the Data Health payload can't be loaded (or the feature isn't accessible), `freshness` is built by `freshnessError(...)` with zeroed cron counts and an error message, and the snapshot card renders "Unavailable".
- **Credit-control read is non-mutating from the hub.** The hub calls `getCreditControlPayload(undefined, { clearRecoveredActionStates: false })` so that merely loading the summary does not clear recovered action states as a side effect.
- **Wise reconciliation with no source.** When no package-sales source is selected, the Wise Audit detail reads "No imported package-sales source" instead of a match ratio.

## Tests

Test files live beside the code under `__tests__/` directories:

- `src/lib/home/__tests__/summary.test.ts` — maps action counts + freshness into the access-filtered payload; keeps other queues available when one source throws; omits inaccessible queues for restricted users.
- `src/lib/navigation/__tests__/tools.test.ts` — section grouping/order, `filterToolsByAccess`, the `/` access rule (`canAccessHref("/", …)`), active-section detection, and the curated shortcut set.
- `src/components/home/__tests__/home-hub.test.tsx` — renders the three sections, the zero-action empty state, and shortcut filtering by `allowedPages`.
- `src/app/api/home/summary/__tests__/route.test.ts` — `GET` returns 401 unauth, 200 passing session access into the payload, 500 JSON on aggregation error.
- `src/__tests__/middleware.test.ts` and `src/components/layout/__tests__/app-nav.test.tsx` — middleware gating of `/` + the summary endpoint, and the reworked nav, were extended in the same commit.

## Open questions

- **Freshness "Wise snapshot" age is sourced from Data Health, not the snapshot directly.** The hub's snapshot staleness (`staleMinutes`, `wiseSnapshotLastSuccess`) is read from `getDataHealthDashboardPayload`, so if Data Health is inaccessible to a restricted user the freshness strip shows "Unavailable" even though the snapshot itself may be fine. Intended, or should freshness fall back to a lighter snapshot-only query?
- **`student-promotions`, `scheduler-metrics`, `tutor-profiles`, `room-capacity`, `sales-dashboard` are registry tools with no `badgeKey`.** They appear in the nav/sections but never contribute an action card or badge count. Confirm these are intentionally "navigation-only" (no actionable queue) rather than missing wiring.
- **Badge counts in the nav are fetched once on mount and not polled.** `AppNav` fetches `/api/home/summary` a single time per mount (no interval, no revalidation on route change), so badge numbers can lag until a full reload. Confirm this is acceptable for the daily-ops cadence.

_Verified against HEAD (commit `d4fe6d3`) on 2026-06-05._
