# Proposals API

**Status: stable.** **Authoritative source:** the three route handlers under [`src/app/api/proposals/`](../../../src/app/api/proposals/), backed by the data layer at [`src/lib/proposals/data.ts`](../../../src/lib/proposals/data.ts) and the overlap helpers at [`src/lib/proposals/overlap.ts`](../../../src/lib/proposals/overlap.ts).

This page is the mechanical reference for the Proposals HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — what a proposal hold *is*, the soft-hold lifecycle, and why conflicts are fail-closed — lives in [docs/features/proposals.md](../../features/proposals.md). The two backing tables (`proposal_bundles`, `proposal_items`) are defined in [`schema.ts:1532`](../../../src/lib/db/schema.ts) and [`schema.ts:1544`](../../../src/lib/db/schema.ts); the two GIST exclusion constraints that enforce overlap-free holds at the DB level live in migration [`0006_admin_proposal_holds.sql:48-57`](../../../drizzle/0006_admin_proposal_holds.sql).

A **proposal** is a soft hold on a tutor's time slot. Holds are grouped into a **bundle** (one student request, 1+ items). A `proposal_items` row carries its own `status` (`pending` | `confirmed` | `released` | `expired` | `auto_resolved`, [`types.ts:3-8`](../../../src/lib/proposals/types.ts)); only `pending` and `confirmed` are **active** ([`overlap.ts:9`](../../../src/lib/proposals/overlap.ts)). All times are minute-of-day integers in Asia/Bangkok.

This API surface is exactly three endpoints:

| Method + path | Purpose |
|---|---|
| `GET /api/proposals/active` | List all currently active holds (pending + confirmed). |
| `POST /api/proposals` | Create a bundle of 1+ holds after resolving tutors and rejecting conflicts. |
| `PATCH /api/proposals/items/[itemId]` | Apply `confirm` / `release` / `extend` to one hold. |

## Conventions shared across the endpoints

- **Authentication.** All three handlers call `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and return `401 {"error":"Unauthorized"}` when there is no session. None of them require an email — but the actor's `session.user.email` / `name` are stamped onto the rows when present (`createdByEmail`/`createdByName` on bundles, `lastActionByEmail`/`lastActionByName` on items).
- **Middleware gating.** The middleware also gates the whole `/api/proposals/**` subtree: it is **not** in the public-route allowlist (`isPublicRoute`, [`middleware.ts:4-15`](../../../src/middleware.ts)), so an unauthenticated browser request is redirected to `/login` before the handler runs. The in-handler `auth()` check is the API-level backstop. A second middleware layer applies to *restricted* admins whose `allowedPages` is non-null: if `/api/proposals/**` is not within their allowed prefixes, the middleware returns `403 {"error":"Forbidden"}` for the `/api/*` path before the handler runs ([`middleware.ts:25-62`](../../../src/middleware.ts)). The handlers themselves emit only `401`, never `403`.
- **Reconcile-on-read.** Every data-layer entry point first runs `reconcileProposalState` ([`data.ts:253-256`](../../../src/lib/proposals/data.ts)), which (a) flips `pending` items whose `expiresAt` has passed to `expired`, and (b) flips `confirmed` items to `auto_resolved` once a matching blocking Wise session exists in the active snapshot. So a `GET`, `POST`, or `PATCH` can change item statuses as a side effect even when that was not the caller's intent.
- **The `holds` array.** `GET /api/proposals/active` and `PATCH /api/proposals/items/[itemId]` both return `{ holds: ProposalHoldSummary[] }` — the current set of **active** holds (statuses `pending` + `confirmed`), newest first. `POST /api/proposals` instead returns the created bundle. The `ProposalHoldSummary` shape is documented once under [`GET /api/proposals/active`](#get-apiproposalsactive) and referenced elsewhere as the **hold summary**.
- **48-hour hold window.** A new `pending` item expires 48 hours after creation (`PENDING_HOLD_MS = 48 * 60 * 60 * 1000`, [`data.ts:21`](../../../src/lib/proposals/data.ts)); `confirm` clears the expiry and `extend` pushes it out another 48 hours from now.

---

## Reading active holds

### `GET /api/proposals/active`

Returns every currently active proposal hold (statuses `pending` and `confirmed`), reconciling stale state first. Read-mostly — performs no *intentional* writes, but the reconcile pass can expire/auto-resolve items as a side effect. Handler: [`active/route.ts:6-19`](../../../src/app/api/proposals/active/route.ts).

**Auth:** session required (`if (!session)`, [`active/route.ts:7-10`](../../../src/app/api/proposals/active/route.ts)).

**Request:** no query parameters, no body. `listActiveProposalHolds(getDb())` is called with default options, so `reconcile` defaults to `true` ([`active/route.ts:13`](../../../src/app/api/proposals/active/route.ts), [`data.ts:258-269`](../../../src/lib/proposals/data.ts)).

**Side effects:** the default reconcile pass may update item statuses (`pending`→`expired`, `confirmed`→`auto_resolved`) before the list is read ([`data.ts:263-265`](../../../src/lib/proposals/data.ts)).

**Response 200** — `{ holds: ProposalHoldSummary[] }`, ordered by `createdAt` descending ([`data.ts:168`](../../../src/lib/proposals/data.ts)). Each **hold summary** is assembled by `toSummary` ([`data.ts:98-128`](../../../src/lib/proposals/data.ts)) from the joined `proposal_items` + `proposal_bundles` rows ([`types.ts:12-36`](../../../src/lib/proposals/types.ts)):

| Field | Type | Notes |
|-------|------|-------|
| `itemId` | string (UUID) | `proposal_items.id`. |
| `bundleId` | string (UUID) | Parent `proposal_bundles.id`. |
| `studentLabel` | string | From the bundle. |
| `notes` | string \| omitted | Bundle notes; omitted when null. |
| `tutorGroupId` | string \| omitted | Identity-group id captured at creation; omitted when null. |
| `tutorCanonicalKey` | string | Canonical key used for overlap matching. |
| `tutorDisplayName` | string | Display name captured at creation. |
| `scope` | `"recurring"` \| `"one_time"` | |
| `weekday` | number | 0=Sunday..6=Saturday. |
| `date` | string \| omitted | ISO `YYYY-MM-DD`; present for one-time holds, omitted when null. |
| `startMinute` / `endMinute` | number | Minute-of-day, Asia/Bangkok. |
| `startTime` / `endTime` | string | `HH:MM` rendering of the minutes (`formatMinute`, [`overlap.ts:30-34`](../../../src/lib/proposals/overlap.ts)). |
| `subject` / `curriculum` / `level` | string \| omitted | Omitted when null. |
| `status` | `"pending"` \| `"confirmed"` | Only active statuses appear here; `toSummary` throws if asked to summarize an inactive row ([`data.ts:99-101`](../../../src/lib/proposals/data.ts)). |
| `createdByEmail` / `createdByName` | string \| omitted | Bundle creator. |
| `createdAt` | string (ISO) | |
| `expiresAt` | string (ISO) \| omitted | 48h hold window for `pending`; cleared (omitted) once `confirmed`. |
| `confirmedAt` | string (ISO) \| omitted | Set when confirmed. |

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ holds }` returned. |
| 401 | No session. |
| 500 | Any thrown error; body carries the error message ([`active/route.ts:15-18`](../../../src/app/api/proposals/active/route.ts)). |

---

## Creating a proposal bundle

### `POST /api/proposals`

Creates one bundle with 1+ hold items after resolving each item's tutor against the active in-memory snapshot and rejecting conflicts. Handler: [`route.ts:40-121`](../../../src/app/api/proposals/route.ts).

**Auth:** session required (`if (!session)`, [`route.ts:41-44`](../../../src/app/api/proposals/route.ts)). `session.user.email` / `name` are stamped onto the bundle and items when present ([`route.ts:96-99`](../../../src/app/api/proposals/route.ts)).

**Request body** (JSON) is validated by Zod `proposalCreateSchema` ([`route.ts:28-32`](../../../src/app/api/proposals/route.ts)). A non-JSON body returns `400 {"error":"Invalid JSON"}` ([`route.ts:46-51`](../../../src/app/api/proposals/route.ts)); a schema failure returns `400 {"error":"Invalid request","details": <flattened>}` ([`route.ts:53-59`](../../../src/app/api/proposals/route.ts)).

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `studentLabel` | string | yes | Trimmed, min length 1 ([`route.ts:29`](../../../src/app/api/proposals/route.ts)). |
| `notes` | string | no | Optional; trimmed to null if blank at insert ([`data.ts:322`](../../../src/lib/proposals/data.ts)). |
| `items` | array | yes | Min length 1 ([`route.ts:31`](../../../src/app/api/proposals/route.ts)). |

Each `items[]` element is validated by `proposalItemSchema` ([`route.ts:16-26`](../../../src/app/api/proposals/route.ts)):

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `tutorGroupId` | string | yes | Min length 1. Must resolve to a tutor group in the active snapshot (see below). |
| `scope` | `"recurring"` \| `"one_time"` | yes | Enum. |
| `weekday` | number | conditional | Int 0–6. Used directly for `recurring`; **ignored** for `one_time` (derived from `date`). |
| `date` | string | conditional | Must match `^\d{4}-\d{2}-\d{2}$` ([`route.ts:14,20`](../../../src/app/api/proposals/route.ts)). Required in effect for `one_time` (the weekday is derived from it). |
| `startMinute` | number | yes | Int, 0 .. 1440. |
| `endMinute` | number | yes | Int, 1 .. 1440. |
| `subject` / `curriculum` / `level` | string | no | Optional. |

Note the Zod schema marks `weekday` and `date` as independently optional; the *real* per-scope requirement is enforced in the handler/data layer, not the schema (see the resolution and validation steps below).

**Tutor resolution + weekday derivation** ([`route.ts:64-88`](../../../src/app/api/proposals/route.ts)): the handler awaits `ensureIndex(db)` and builds a `Map` of `IndexedTutorGroup` by id. For each item:
- if `tutorGroupId` is not in the snapshot → throws `ProposalValidationError("Tutor not found in active snapshot: <id>")` → **400**;
- the effective `weekday` is `weekdayForIsoDate(date)` for `one_time` (Bangkok-based, [`overlap.ts:45-47`](../../../src/lib/proposals/overlap.ts)) or the supplied `weekday` for `recurring`; if it is `undefined`/`NaN` (e.g. a `one_time` item with no/invalid `date`) → throws `ProposalValidationError("Proposal item needs a valid day/date")` → **400**;
- the item is enriched with the group's `canonicalKey` and `displayName` for storage and overlap matching.

**Server-side validation** (in `createProposalBundle` → `validateCreateInput`, [`data.ts:271-298`](../../../src/lib/proposals/data.ts)) runs after resolution and raises `ProposalValidationError` (→ **400**) for: empty `studentLabel`; empty `items`; any item with `endMinute <= startMinute` or out-of-range minutes; weekday outside 0–6; a `one_time` item missing `date`; or **two requested items overlapping each other** (`"Requested proposal items overlap each other"`).

**Conflict detection (fail-closed, two layers):**
1. *Application pre-check* — `createProposalBundle` reconciles state, lists active holds, and for each requested item calls `findConflictingProposal`; a match throws `ProposalConflictError(conflict)` carrying the offending hold ([`data.ts:307-315`](../../../src/lib/proposals/data.ts)). Overlap is same `tutorCanonicalKey` + overlapping minute range + (same weekday for recurring / same date for one-time) ([`overlap.ts:69-82`](../../../src/lib/proposals/overlap.ts)).
2. *Database backstop* — the two GIST `EXCLUDE` constraints (`proposal_items_no_recurring_overlap`, `proposal_items_no_one_time_overlap`, scoped to `status IN ('pending','confirmed')`, [`0006_admin_proposal_holds.sql:48-57`](../../../drizzle/0006_admin_proposal_holds.sql)) reject overlapping inserts at write time. On such a violation the data layer deletes the just-created bundle, re-derives the conflicting hold, and re-throws `ProposalConflictError` ([`data.ts:360-377`](../../../src/lib/proposals/data.ts)). The route's own `isDatabaseOverlapError` ([`route.ts:34-38`](../../../src/app/api/proposals/route.ts)) is a secondary guard that maps any DB-overlap error escaping the data layer to **409**.

**Side effects** ([`data.ts:300-384`](../../../src/lib/proposals/data.ts)): reconciles proposal state; inserts one `proposal_bundles` row; inserts N `proposal_items` rows all with `status: "pending"` and `expiresAt = now + 48h`. If the item insert fails the bundle insert is rolled back via an explicit delete ([`data.ts:361-364`](../../../src/lib/proposals/data.ts)).

**Response 201** — the created bundle: `{ bundleId: string, items: ProposalHoldSummary[] }`, where `items` are the freshly-created holds filtered out of the active-holds list ([`data.ts:379-383`](../../../src/lib/proposals/data.ts), returned via [`route.ts:101`](../../../src/app/api/proposals/route.ts)). Each entry is a [hold summary](#get-apiproposalsactive).

**Status codes:**

| Status | When |
|--------|------|
| 201 | Bundle created. |
| 400 | `Invalid JSON`; Zod `Invalid request` (with `details`); or a `ProposalValidationError` (tutor not in snapshot, invalid day/date, bad time range, self-overlap, etc.) ([`route.ts:49-59,109-111`](../../../src/app/api/proposals/route.ts)). |
| 401 | No session. |
| 409 | Requested slot conflicts with an active hold — `{"error":"Proposal conflicts with an active hold","conflict": <hold summary>}` from a `ProposalConflictError` ([`route.ts:103-107`](../../../src/app/api/proposals/route.ts)), or `{"error":"Proposal conflicts with an active hold"}` from the DB-overlap fallback ([`route.ts:112-117`](../../../src/app/api/proposals/route.ts)). |
| 500 | Any other thrown error; body carries the error message ([`route.ts:118-120`](../../../src/app/api/proposals/route.ts)). |

---

## Acting on a single hold

### `PATCH /api/proposals/items/[itemId]`

Applies one lifecycle action — `confirm`, `release`, or `extend` — to a single proposal item, then returns the refreshed active-holds list. Handler: [`items/[itemId]/route.ts:15-62`](../../../src/app/api/proposals/items/[itemId]/route.ts).

**Auth:** session required (`if (!session)`, [`items/[itemId]/route.ts:19-22`](../../../src/app/api/proposals/items/[itemId]/route.ts)). `session.user.email` / `name` are recorded as the row's `lastActionByEmail` / `lastActionByName` ([`items/[itemId]/route.ts:46-49`](../../../src/app/api/proposals/items/[itemId]/route.ts), [`data.ts:407-412`](../../../src/lib/proposals/data.ts)).

**Path parameter:**

| Param | Type | Notes |
|-------|------|-------|
| `itemId` | string | The `proposal_items.id`. Awaited from `ctx.params` (the param is a `Promise`, [`items/[itemId]/route.ts:17,39`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |

**Request body** (JSON) is validated by Zod `patchSchema` ([`items/[itemId]/route.ts:11-13`](../../../src/app/api/proposals/items/[itemId]/route.ts)). A non-JSON body returns `400 {"error":"Invalid JSON"}`; a schema failure returns `400 {"error":"Invalid request","details": <flattened>}` ([`items/[itemId]/route.ts:24-37`](../../../src/app/api/proposals/items/[itemId]/route.ts)).

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `action` | `"confirm"` \| `"release"` \| `"extend"` | yes | Enum ([`items/[itemId]/route.ts:12`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |

**Behavior by action** (in `patchProposalItem`, [`data.ts:386-474`](../../../src/lib/proposals/data.ts)). The handler first reconciles state, then loads the item by id; a missing row throws `ProposalNotFoundError` (message `"Proposal item not found"`) → **404** ([`data.ts:405`](../../../src/lib/proposals/data.ts)). Each action has a state guard that throws `ProposalValidationError` → **400** when violated:

| Action | Allowed from status | Effect | Guard message |
|--------|---------------------|--------|---------------|
| `confirm` | `pending` or `confirmed` | Sets `status: "confirmed"`, clears `expiresAt`, sets `confirmedAt`; **and** releases all *other* `pending` items in the same bundle (`status: "released"`, `releasedAt`) ([`data.ts:414-442`](../../../src/lib/proposals/data.ts)). | `"Only active proposal holds can be confirmed"` |
| `release` | `pending` or `confirmed` | Sets `status: "released"`, sets `releasedAt` ([`data.ts:443-454`](../../../src/lib/proposals/data.ts)). | `"Only active proposal holds can be released"` |
| `extend` | `pending` only | Pushes `expiresAt` to `now + 48h` ([`data.ts:455-465`](../../../src/lib/proposals/data.ts)). | `"Only pending proposal holds can be extended"` |

**Side effects:** the action's row update(s) above; `confirm` additionally cascades a release to sibling pending items; the parent bundle's `updatedAt` is bumped ([`data.ts:468-471`](../../../src/lib/proposals/data.ts)); plus the upfront reconcile pass ([`data.ts:393`](../../../src/lib/proposals/data.ts)) may have expired/auto-resolved items.

**Response 200** — `{ holds: ProposalHoldSummary[] }`, the refreshed active-holds list after the action ([`data.ts:473`](../../../src/lib/proposals/data.ts), returned via [`items/[itemId]/route.ts:51`](../../../src/app/api/proposals/items/[itemId]/route.ts)). A just-released item drops out of this list; a just-confirmed item remains (now `status: "confirmed"`, no `expiresAt`). See the [hold summary](#get-apiproposalsactive) shape.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Action applied; `{ holds }` returned. |
| 400 | `Invalid JSON`; Zod `Invalid request` (with `details`); or a `ProposalValidationError` (action not allowed from the item's current status) ([`items/[itemId]/route.ts:27-37,56-58`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 401 | No session. |
| 404 | No `proposal_items` row with that `itemId` (`ProposalNotFoundError`) ([`items/[itemId]/route.ts:53-55`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 500 | Any other thrown error; body carries the error message ([`items/[itemId]/route.ts:59-61`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
