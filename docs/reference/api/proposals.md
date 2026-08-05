# Proposals API

**Authoritative source:** the three route handlers under [`src/app/api/proposals/`](../../../src/app/api/proposals/), backed by the data layer at [`src/lib/proposals/data.ts`](../../../src/lib/proposals/data.ts) and the pure overlap helpers at [`src/lib/proposals/overlap.ts`](../../../src/lib/proposals/overlap.ts).

This page is the mechanical reference for the Proposals HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning — what a proposal hold *is*, the soft-hold lifecycle, and why the system is fail-closed about conflicts — lives in [docs/features/proposals.md](../../features/proposals.md).

The three endpoints, in full:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/proposals` | Create one bundle of 1+ tentative holds |
| `GET` | `/api/proposals/active` | List every currently active hold |
| `PATCH` | `/api/proposals/items/[itemId]` | Confirm / release / extend one hold |

Backing tables: `proposal_bundles` ([`schema.ts:2300-2310`](../../../src/lib/db/schema.ts)) and `proposal_items` ([`schema.ts:2312-2340`](../../../src/lib/db/schema.ts)); column-level detail lives in [the database reference](../database/index.md). A `proposal_items` row carries its own `status` — `pending` | `confirmed` | `released` | `expired` | `auto_resolved` ([`types.ts:3-8`](../../../src/lib/proposals/types.ts)) — of which only `pending` and `confirmed` are **active** ([`overlap.ts:9`](../../../src/lib/proposals/overlap.ts)). All times are minute-of-day integers interpreted in Asia/Bangkok.

## Conventions shared across the three endpoints

- **Authentication — any signed-in session; no cron tier, no public tier.** All three handlers call `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and return `401 {"error":"Unauthorized"}` when there is no session ([`route.ts:41-44`](../../../src/app/api/proposals/route.ts), [`active/route.ts:7-10`](../../../src/app/api/proposals/active/route.ts), [`items/[itemId]/route.ts:19-22`](../../../src/app/api/proposals/items/[itemId]/route.ts)). The handlers check for a session only — they do not check role or email. Sign-in itself is fail-closed (`resolveUserAccess` returns one of `admin` / `counselor` / `teacher` / `student` / `parent`, or denies, [`auth-access.ts:56-85`](../../../src/lib/auth-access.ts)); what actually keeps non-admins away from these routes is the middleware gate below. `session.user.email` / `session.user.name` are stamped onto rows when present (`created_by_email` / `created_by_name` on the bundle, `last_action_by_email` / `last_action_by_name` on each item).
- **Middleware runs first.** `/api/proposals/**` is not in the public-route allowlist ([`middleware.ts:4-20`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs; the in-handler `auth()` check is the API-level backstop. For a *restricted* user (`user.allowedPages` non-null — every non-admin role, plus page-restricted admins) the middleware matches the path against each allowed prefix as both a page and its `/api` namespace, returning `403 {"error":"Forbidden"}` for any unmatched `/api/**` path ([`middleware.ts:30-61,79-82`](../../../src/middleware.ts)). Since `allowedPages` would have to contain the literal `"/proposals"` to grant `/api/proposals`, and no such page exists (the UI lives inside `/search`), **every restricted user gets a middleware 403 on all three endpoints** — a status the handlers themselves never emit. Full-access admins have `allowedPages: null` and pass straight through.
- **Reconcile-on-read (side effect on every call).** Every data-layer entry point first runs `reconcileProposalState` ([`data.ts:253-256`](../../../src/lib/proposals/data.ts)), which (a) flips `pending` items whose `expiresAt` has passed to `expired` ([`data.ts:171-188`](../../../src/lib/proposals/data.ts)) and (b) flips `confirmed` items to `auto_resolved` once a matching blocking future session exists in the active snapshot ([`data.ts:190-251`](../../../src/lib/proposals/data.ts)). A `GET`, `POST`, or `PATCH` can therefore mutate item statuses even when that was not the caller's intent. The same reconcile also runs outside this API — range search calls `listActiveProposalHolds(db)` on every query ([`range-search.ts:116`](../../../src/lib/search/range-search.ts)).
- **The `holds` array.** `GET /api/proposals/active` and `PATCH /api/proposals/items/[itemId]` both return `{ holds: ProposalHoldSummary[] }` — the current set of **active** holds, newest first. `POST /api/proposals` instead returns the created bundle. The `ProposalHoldSummary` shape is tabulated once under [`GET /api/proposals/active`](#get-apiproposalsactive) and referenced elsewhere as the **hold summary**.
- **48-hour hold window.** A new `pending` item expires 48 hours after creation (`PENDING_HOLD_MS = 48 * 60 * 60 * 1000`, [`data.ts:21`](../../../src/lib/proposals/data.ts)); `confirm` clears the expiry, `extend` pushes it out another 48 hours from *now*.
- **No route-level runtime config.** None of the three files exports `maxDuration`, `runtime`, `dynamic`, or `revalidate`, and none calls `revalidateTag` — proposal writes do not invalidate the `snapshot` cache tag. (Verified by absence: grep over the three route files returns nothing.)

---

## Reading active holds

### `GET /api/proposals/active`

Returns every currently active proposal hold (statuses `pending` and `confirmed`), reconciling stale state first. Read-mostly: it performs no *intentional* writes, but the reconcile pass can expire or auto-resolve items as a side effect. Handler: [`active/route.ts:6-19`](../../../src/app/api/proposals/active/route.ts).

**Auth:** session required ([`active/route.ts:7-10`](../../../src/app/api/proposals/active/route.ts)).

**Request:** no path params, no query params, no body. `listActiveProposalHolds(getDb())` is called with default options, so `reconcile` defaults to `true` ([`active/route.ts:13`](../../../src/app/api/proposals/active/route.ts), [`data.ts:258-269`](../../../src/lib/proposals/data.ts)).

**Side effects:** the default reconcile pass may update item statuses (`pending`→`expired`, `confirmed`→`auto_resolved`) before the list is read ([`data.ts:262-265`](../../../src/lib/proposals/data.ts)).

**Response 200** — `{ holds: ProposalHoldSummary[] }`, ordered by `createdAt` descending ([`data.ts:168`](../../../src/lib/proposals/data.ts)). Each **hold summary** is assembled by `toSummary` ([`data.ts:98-128`](../../../src/lib/proposals/data.ts)) from the joined `proposal_items` + `proposal_bundles` rows; the TypeScript shape is [`types.ts:12-36`](../../../src/lib/proposals/types.ts):

| Field | Type | Notes |
|-------|------|-------|
| `itemId` | string (UUID) | `proposal_items.id`. |
| `bundleId` | string (UUID) | Parent `proposal_bundles.id`. |
| `studentLabel` | string | From the bundle. |
| `notes` | string \| omitted | Bundle notes; omitted when null. |
| `tutorGroupId` | string \| omitted | Identity-group id captured at creation; nullable column ([`schema.ts:2315`](../../../src/lib/db/schema.ts)), omitted when null. |
| `tutorCanonicalKey` | string | Canonical key used for all overlap matching. |
| `tutorDisplayName` | string | Display name captured at creation. |
| `scope` | `"recurring"` \| `"one_time"` | |
| `weekday` | number | 0 = Sunday .. 6 = Saturday. |
| `date` | string \| omitted | ISO `YYYY-MM-DD`; present for one-time holds, omitted when null. |
| `startMinute` / `endMinute` | number | Minute-of-day, Asia/Bangkok. |
| `startTime` / `endTime` | string | `HH:MM` rendering of those minutes (`formatMinute`, [`overlap.ts:30-34`](../../../src/lib/proposals/overlap.ts)). |
| `subject` / `curriculum` / `level` | string \| omitted | Omitted when null. |
| `status` | `"pending"` \| `"confirmed"` | Only active statuses can appear; `toSummary` throws if asked to summarize an inactive row ([`data.ts:99-101`](../../../src/lib/proposals/data.ts)). |
| `createdByEmail` / `createdByName` | string \| omitted | Bundle creator. |
| `createdAt` | string (ISO) | Item creation time. |
| `expiresAt` | string (ISO) \| omitted | 48h hold window while `pending`; cleared (omitted) once `confirmed`. |
| `confirmedAt` | string (ISO) \| omitted | Set when confirmed. |

**Status codes:**

| Status | When |
|--------|------|
| 200 | `{ holds }` returned. |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user (not emitted by the handler). |
| 500 | Any thrown error; body is `{ error: <message> }` ([`active/route.ts:15-18`](../../../src/app/api/proposals/active/route.ts)). |

---

## Creating a proposal bundle

### `POST /api/proposals`

Creates one bundle with 1+ hold items after resolving each item's tutor against the active in-memory snapshot index and rejecting conflicts. Handler: [`route.ts:40-121`](../../../src/app/api/proposals/route.ts).

**Auth:** session required ([`route.ts:41-44`](../../../src/app/api/proposals/route.ts)). `session.user.email` / `name` are passed as the actor ([`route.ts:96-99`](../../../src/app/api/proposals/route.ts)) and stored on the bundle and on every item.

**Request body** (JSON) is validated by the Zod `proposalCreateSchema` ([`route.ts:28-32`](../../../src/app/api/proposals/route.ts)). A body that is not valid JSON returns `400 {"error":"Invalid JSON"}` ([`route.ts:46-51`](../../../src/app/api/proposals/route.ts)); a schema failure returns `400 {"error":"Invalid request","details": <parsed.error.flatten()>}` ([`route.ts:53-59`](../../../src/app/api/proposals/route.ts)).

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `studentLabel` | string | yes | `.trim().min(1)` — whitespace-only is rejected ([`route.ts:29`](../../../src/app/api/proposals/route.ts)). |
| `notes` | string | no | Optional; trimmed and stored as `null` when blank ([`data.ts:322`](../../../src/lib/proposals/data.ts)). |
| `items` | array | yes | Min length 1 ([`route.ts:31`](../../../src/app/api/proposals/route.ts)). |

Each `items[]` element is validated by `proposalItemSchema` ([`route.ts:16-26`](../../../src/app/api/proposals/route.ts)):

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `tutorGroupId` | string | yes | `min(1)`. Must resolve to a tutor group in the active snapshot (see below). |
| `scope` | `"recurring"` \| `"one_time"` | yes | Enum ([`route.ts:18`](../../../src/app/api/proposals/route.ts)). |
| `weekday` | number | conditional | Int 0–6, Zod-optional. Used directly for `recurring`; **ignored** for `one_time` (derived from `date`). |
| `date` | string | conditional | Zod-optional but must match `^\d{4}-\d{2}-\d{2}$` when present ([`route.ts:14,20`](../../../src/app/api/proposals/route.ts)). Effectively required for `one_time`, since the weekday is derived from it. |
| `startMinute` | number | yes | Int, 0 .. 1440 ([`route.ts:21`](../../../src/app/api/proposals/route.ts)). |
| `endMinute` | number | yes | Int, 1 .. 1440 ([`route.ts:22`](../../../src/app/api/proposals/route.ts)). |
| `subject` / `curriculum` / `level` | string | no | Optional, free text. |

The Zod schema deliberately marks `weekday` and `date` as *independently* optional; the real per-scope requirement is enforced in the handler and the data layer, not the schema.

**Tutor resolution + weekday derivation** ([`route.ts:64-88`](../../../src/app/api/proposals/route.ts)). The handler awaits `ensureIndex(db)` ([`src/lib/search/index.ts:354`](../../../src/lib/search/index.ts)) and builds a `Map` of `IndexedTutorGroup` by id ([`index.ts:65-81`](../../../src/lib/search/index.ts)). Then, per item:

- unknown `tutorGroupId` → `ProposalValidationError("Tutor not found in active snapshot: <id>")` → **400**;
- effective `weekday` = `weekdayForIsoDate(date)` for `one_time` (parsed as `<date>T00:00:00+07:00`, [`overlap.ts:45-47`](../../../src/lib/proposals/overlap.ts)) or the supplied `weekday` for `recurring`. If it comes out `undefined` or `NaN` — a `recurring` item with no `weekday`, or a `one_time` item with no `date` — → `ProposalValidationError("Proposal item needs a valid day/date")` → **400**;
- the item is enriched with the group's `canonicalKey` and `displayName`, which is what actually gets stored and matched on.

Because `ensureIndex` is awaited inside the handler, a cold process pays the index build (or joins an in-flight one) on this request.

**Server-side validation** runs next, inside `createProposalBundle` → `validateCreateInput` ([`data.ts:271-298`](../../../src/lib/proposals/data.ts)), raising `ProposalValidationError` (→ **400**) for: empty `studentLabel`; empty `items`; any item with `endMinute <= startMinute` or minutes outside 0..1440; weekday outside 0–6; a `one_time` item missing `date`; or **two requested items overlapping each other** (`"Requested proposal items overlap each other"`).

**Conflict detection (fail-closed, two layers):**

1. *Application pre-check* — `createProposalBundle` reconciles state, lists active holds, and calls `findConflictingProposal` for each requested item; a match throws `ProposalConflictError(conflict)` carrying the offending hold ([`data.ts:307-315`](../../../src/lib/proposals/data.ts)). Overlap means same `tutorCanonicalKey` + overlapping minute range + (same weekday when both are recurring / same date when both are one-time / same weekday for a mixed pair) ([`overlap.ts:69-82`](../../../src/lib/proposals/overlap.ts)).
2. *Database backstop* — two GIST `EXCLUDE` constraints scoped to `status IN ('pending','confirmed')` reject overlapping inserts at write time: `proposal_items_no_recurring_overlap` (canonical key + weekday + `int4range(start,end,'[)')`) and `proposal_items_no_one_time_overlap` (canonical key + date + range) ([`0006_admin_proposal_holds.sql:48-57`](../../../drizzle/0006_admin_proposal_holds.sql)). On such a violation the data layer deletes the just-created bundle, re-derives the conflicting hold from a refreshed active list, and re-throws `ProposalConflictError` ([`data.ts:360-377`](../../../src/lib/proposals/data.ts)). The route's own `isDatabaseOverlapError` ([`route.ts:34-38`](../../../src/app/api/proposals/route.ts)) is a secondary guard mapping any DB-overlap error that escapes the data layer to **409** — without a `conflict` body.

The same migration also installs three CHECK constraints (`end_minute > start_minute`, `weekday` 0–6, `pending` implies a non-null `expires_at`, [`0006_admin_proposal_holds.sql:41-43`](../../../drizzle/0006_admin_proposal_holds.sql)). The application validation above covers all three, so a violation would surface as an unmapped **500**, not a 400.

**Side effects** ([`data.ts:300-384`](../../../src/lib/proposals/data.ts)): reconciles proposal state; inserts one `proposal_bundles` row ([`data.ts:318-328`](../../../src/lib/proposals/data.ts)); inserts N `proposal_items` rows, each with `status: "pending"` and `expiresAt = now + 48h` ([`data.ts:332-357`](../../../src/lib/proposals/data.ts)). There is no transaction — if the item insert fails, the bundle is removed by an explicit best-effort delete ([`data.ts:361-364`](../../../src/lib/proposals/data.ts)). Downstream, new holds change what other reads return: range search overlays active holds ([`range-search.ts:116`](../../../src/lib/search/range-search.ts)) and the AI scheduler loads them when drafting a reply ([`scheduler-service.ts:61-63`](../../../src/lib/ai/scheduler-service.ts)). Nothing here writes back to Wise — the tables are local-only by design ([`schema.ts:2296-2299`](../../../src/lib/db/schema.ts)).

**Response 201** — the created bundle: `{ bundleId: string, items: ProposalHoldSummary[] }`, where `items` are the freshly created holds filtered out of the refreshed active-holds list ([`data.ts:379-383`](../../../src/lib/proposals/data.ts), returned at [`route.ts:101`](../../../src/app/api/proposals/route.ts)). Each entry is a [hold summary](#get-apiproposalsactive).

**Status codes** (catch order is conflict → validation → DB-overlap → generic, [`route.ts:102-120`](../../../src/app/api/proposals/route.ts)):

| Status | When |
|--------|------|
| 201 | Bundle created. |
| 400 | `{"error":"Invalid JSON"}`; Zod `{"error":"Invalid request","details":…}`; or a `ProposalValidationError` — tutor not in snapshot, invalid day/date, bad time range, items overlapping each other ([`route.ts:49-59,109-111`](../../../src/app/api/proposals/route.ts)). |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user (not emitted by the handler). |
| 409 | Requested slot conflicts with an active hold — `{"error":"Proposal conflicts with an active hold","conflict": <hold summary>}` from `ProposalConflictError` ([`route.ts:103-107`](../../../src/app/api/proposals/route.ts)), or the bare `{"error":"Proposal conflicts with an active hold"}` from the DB-overlap fallback ([`route.ts:112-117`](../../../src/app/api/proposals/route.ts)). |
| 500 | Any other thrown error, including an `ensureIndex` failure; body is `{ error: <message> }` ([`route.ts:118-120`](../../../src/app/api/proposals/route.ts)). |

---

## Acting on a single hold

### `PATCH /api/proposals/items/[itemId]`

Applies one lifecycle action — `confirm`, `release`, or `extend` — to a single proposal item, then returns the refreshed active-holds list. Handler: [`items/[itemId]/route.ts:15-62`](../../../src/app/api/proposals/items/[itemId]/route.ts).

**Auth:** session required ([`items/[itemId]/route.ts:19-22`](../../../src/app/api/proposals/items/[itemId]/route.ts)). `session.user.email` / `name` are recorded as the row's `lastActionByEmail` / `lastActionByName` alongside `lastActionAt` ([`items/[itemId]/route.ts:46-49`](../../../src/app/api/proposals/items/[itemId]/route.ts), [`data.ts:407-412`](../../../src/lib/proposals/data.ts)).

**Path parameter:**

| Param | Type | Notes |
|-------|------|-------|
| `itemId` | string | The `proposal_items.id` (a `uuid` column, [`schema.ts:2313`](../../../src/lib/db/schema.ts)). Awaited from `ctx.params` — a `Promise` under Next.js 16 ([`items/[itemId]/route.ts:17,39`](../../../src/app/api/proposals/items/[itemId]/route.ts)). Not format-validated by the handler; a syntactically invalid UUID reaches Postgres as a `uuid` comparison and therefore surfaces as a **500**, not a 404. |

**Request body** (JSON) is validated by the Zod `patchSchema` ([`items/[itemId]/route.ts:11-13`](../../../src/app/api/proposals/items/[itemId]/route.ts)). A non-JSON body returns `400 {"error":"Invalid JSON"}`; a schema failure returns `400 {"error":"Invalid request","details": <flattened>}` ([`items/[itemId]/route.ts:24-37`](../../../src/app/api/proposals/items/[itemId]/route.ts)).

| Field | Type | Required | Schema rule |
|-------|------|----------|-------------|
| `action` | `"confirm"` \| `"release"` \| `"extend"` | yes | Enum; the only accepted key ([`items/[itemId]/route.ts:12`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |

**Behavior by action** (`patchProposalItem`, [`data.ts:386-474`](../../../src/lib/proposals/data.ts)). The data layer first reconciles state ([`data.ts:393`](../../../src/lib/proposals/data.ts)), then loads the item by id; a missing row throws `ProposalNotFoundError` (`"Proposal item not found"`) → **404** ([`data.ts:395-405`](../../../src/lib/proposals/data.ts)). Each action then has a state guard that throws `ProposalValidationError` → **400** when violated:

| Action | Allowed from status | Effect | Guard message |
|--------|---------------------|--------|---------------|
| `confirm` | `pending` or `confirmed` | Sets `status: "confirmed"`, clears `expiresAt`, sets `confirmedAt`; **and** releases every *other* still-`pending` item in the same bundle (`status: "released"` + `releasedAt`) ([`data.ts:414-442`](../../../src/lib/proposals/data.ts)). | `"Only active proposal holds can be confirmed"` |
| `release` | `pending` or `confirmed` | Sets `status: "released"` and `releasedAt` ([`data.ts:443-454`](../../../src/lib/proposals/data.ts)). | `"Only active proposal holds can be released"` |
| `extend` | `pending` only | Pushes `expiresAt` to `now + 48h` ([`data.ts:455-465`](../../../src/lib/proposals/data.ts)). | `"Only pending proposal holds can be extended"` |

**Side effects:** the row update(s) above; the `confirm` cascade onto sibling pending items; a bump of the parent bundle's `updatedAt` ([`data.ts:468-471`](../../../src/lib/proposals/data.ts)); plus the upfront reconcile pass, which may have expired or auto-resolved unrelated items. As with `POST`, nothing is written back to Wise.

**Response 200** — `{ holds: ProposalHoldSummary[] }`: the refreshed active-holds list *after* the action, read with `reconcile: false` since the reconcile already ran ([`data.ts:473`](../../../src/lib/proposals/data.ts), returned at [`items/[itemId]/route.ts:51`](../../../src/app/api/proposals/items/[itemId]/route.ts)). A just-released item drops out of the list; a just-confirmed item stays, now `status: "confirmed"` with no `expiresAt`. See the [hold summary](#get-apiproposalsactive) shape.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Action applied; `{ holds }` returned. |
| 400 | `{"error":"Invalid JSON"}`; Zod `{"error":"Invalid request","details":…}`; or a `ProposalValidationError` — the action is not allowed from the item's current status ([`items/[itemId]/route.ts:27-37,56-58`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 401 | No session. |
| 403 | Middleware page-access denial for a restricted user (not emitted by the handler). |
| 404 | No `proposal_items` row with that `itemId` (`ProposalNotFoundError`) ([`items/[itemId]/route.ts:53-55`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 500 | Any other thrown error; body is `{ error: <message> }` ([`items/[itemId]/route.ts:59-61`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |

---

## In-repo clients and tests

- UI callers: the hold-creation modal `POST`s to `/api/proposals` ([`proposal-hold-modal.tsx:94`](../../../src/components/search/proposal-hold-modal.tsx)); the search workspace `GET`s `/api/proposals/active` on mount and after each create ([`search-workspace.tsx:240`](../../../src/components/search/search-workspace.tsx)) and `PATCH`es `/api/proposals/items/{itemId}` for each lifecycle action ([`search-workspace.tsx:269`](../../../src/components/search/search-workspace.tsx)). Both callers ignore non-`ok` responses silently.
- Route tests: [`src/app/api/proposals/__tests__/route.test.ts`](../../../src/app/api/proposals/__tests__/route.test.ts) covers the 401 on `GET`, the 200 `{ holds }` list, the 201 create path with tutor identity resolved from the index, the 409 conflict body, and the `PATCH` → `patchProposalItem` wiring. Overlap semantics are tested separately against `src/lib/proposals/overlap.ts`.

## Notes & open questions

- **Restricted users are locked out by namespace, not by design intent.** The proposal UI is embedded in `/search`, but the API namespace is `/api/proposals`, and `isPathAllowed` only grants `/api${page}`. A page-restricted admin granted `["/search"]` would therefore get a middleware **403** on all three endpoints while the surrounding search page works. Should `/api/proposals` be aliased under the `/search` grant, or is holds-for-full-admins-only the intent?
- **`POST` is not transactional.** Bundle and items are inserted in two separate statements with a best-effort compensating delete on failure ([`data.ts:318-377`](../../../src/lib/proposals/data.ts)) — a consequence of the Neon HTTP driver having no transaction support. A crash between the two leaves an orphan `proposal_bundles` row (harmless to reads, which inner-join from items).
- **Reads mutate.** All three endpoints reconcile proposal state before answering, so `GET /api/proposals/active` can change rows. Intentional (there is no proposal cron to do it), but worth knowing when reasoning about idempotence.

_Verified against HEAD + uncommitted WIP on 2026-05-31._
