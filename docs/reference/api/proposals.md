# Proposals API

**Authoritative source:** the three route handlers under [`src/app/api/proposals/`](../../../src/app/api/proposals/), backed by the data layer at [`src/lib/proposals/data.ts`](../../../src/lib/proposals/data.ts), the pure overlap helpers at [`src/lib/proposals/overlap.ts`](../../../src/lib/proposals/overlap.ts), and the shared types at [`src/lib/proposals/types.ts`](../../../src/lib/proposals/types.ts).

This page is the mechanical reference for the three Proposals HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Meaning — what a hold *is*, the negotiation workflow it models, and why it is deliberately advisory — lives in [docs/features/proposals.md](../../features/proposals.md), which also carries the feature's **experimental** status label. Table grain, columns, and enum value sets live in [docs/reference/database/erd-ai-and-proposals.md](../database/erd-ai-and-proposals.md); the two backing tables are declared at [`schema.ts:2303-2313`](../../../src/lib/db/schema.ts) (`proposal_bundles`) and [`schema.ts:2315-2343`](../../../src/lib/db/schema.ts) (`proposal_items`).

## Endpoint summary

| Method | Path | Auth | Handler |
|---|---|---|---|
| `POST` | `/api/proposals` | session | [`route.ts:40-121`](../../../src/app/api/proposals/route.ts) |
| `GET` | `/api/proposals/active` | session | [`active/route.ts:6-19`](../../../src/app/api/proposals/active/route.ts) |
| `PATCH` | `/api/proposals/items/[itemId]` | session | [`items/[itemId]/route.ts:15-62`](../../../src/app/api/proposals/items/[itemId]/route.ts) |

That is the whole HTTP surface — three files, three exported handlers, no `GET` on the collection, no `DELETE`, and no internal/cron route. Neither `vercel.json` nor the in-app cron registry ([`src/lib/data-health/cron-registry.ts`](../../../src/lib/data-health/cron-registry.ts)) contains the string `proposal`, so nothing schedules proposal maintenance; the lifecycle is reconciled on read instead (see below).

## Conventions shared across the three endpoints

- **Auth is "any signed-in session", checked in-handler.** All three call `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and return **401** `{"error":"Unauthorized"}` when it resolves falsy ([`route.ts:41-44`](../../../src/app/api/proposals/route.ts), [`active/route.ts:7-10`](../../../src/app/api/proposals/active/route.ts), [`items/[itemId]/route.ts:19-22`](../../../src/app/api/proposals/items/[itemId]/route.ts)). No handler inspects role, email, or a capability grant. Sign-in itself is fail-closed and assigns one of five roles ([`auth-access.ts:31,56-85`](../../../src/lib/auth-access.ts)).
- **Middleware runs first and is what actually narrows the audience.** `/api/proposals/**` is not on the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)) — the in-handler `auth()` is the API-level backstop. For a restricted user (`allowedPages` non-null) `isPathAllowed` matches each granted page both as `/x` and as `/api/x` ([`middleware.ts:59-66`](../../../src/middleware.ts)) and returns **403** `{"error":"Forbidden"}` for an unmatched `/api/**` path ([`middleware.ts:97-100`](../../../src/middleware.ts)). Granting `/api/proposals` would require the literal page `"/proposals"` in `allowedPages`; no such page exists and `src/lib/navigation/tools.ts` has no proposals entry, and every non-admin role is pinned to `/admissions` or `/progress-tests` ([`auth-access.ts:56-85`](../../../src/lib/auth-access.ts)). **In practice these endpoints are reachable only by full-access admins** (`allowedPages: null`), and **403** is a status the handlers themselves never emit.
- **Every call reconciles state before answering.** `reconcileProposalState` ([`data.ts:253-256`](../../../src/lib/proposals/data.ts)) runs at the head of all three data-layer entry points. It (a) flips `pending` items whose `expires_at` has passed to `expired` ([`data.ts:171-188`](../../../src/lib/proposals/data.ts)) and (b) flips `confirmed` items to `auto_resolved` when a blocking `future_session_blocks` row on the **active snapshot** now covers the same tutor/day/time ([`data.ts:190-251`](../../../src/lib/proposals/data.ts), matching by [`overlap.ts:116-138`](../../../src/lib/proposals/overlap.ts)). A `GET` therefore writes. This is the only reconciler — there is no cron — and it also fires outside this API, because range search calls `listActiveProposalHolds(db)` on every query ([`range-search.ts:116`](../../../src/lib/search/range-search.ts)).
- **Only `pending` and `confirmed` are "active".** `ProposalStatus` has five values ([`types.ts:3-8`](../../../src/lib/proposals/types.ts)); `ACTIVE_PROPOSAL_STATUSES` is the two-value subset ([`overlap.ts:9`](../../../src/lib/proposals/overlap.ts)) used as the `WHERE status IN (…)` filter for every list read ([`data.ts:267`](../../../src/lib/proposals/data.ts)). `toSummary` throws if handed an inactive row ([`data.ts:99-101`](../../../src/lib/proposals/data.ts)).
- **Two of the three return the same envelope.** `GET /api/proposals/active` and `PATCH /api/proposals/items/[itemId]` both answer `{ holds: ProposalHoldSummary[] }`. `POST /api/proposals` answers `{ bundleId, items }`. The `ProposalHoldSummary` shape is tabulated once, under [`GET /api/proposals/active`](#get-apiproposalsactive), and referred to elsewhere as the **hold summary**.
- **48-hour hold window.** A new item is created `pending` with `expires_at = now + PENDING_HOLD_MS`, where `PENDING_HOLD_MS = 48 * 60 * 60 * 1000` ([`data.ts:21,85-87`](../../../src/lib/proposals/data.ts)). `confirm` clears the expiry; `extend` pushes it 48 hours out from *now*.
- **Times are minute-of-day integers, Asia/Bangkok.** `startMinute`/`endMinute` are `0..1440`; `startTime`/`endTime` in responses are their `HH:MM` rendering (`formatMinute`, [`overlap.ts:30-34`](../../../src/lib/proposals/overlap.ts)). A one-time hold's weekday is derived by parsing `` `${date}T00:00:00+07:00` `` ([`overlap.ts:45-47`](../../../src/lib/proposals/overlap.ts)).
- **No route segment config, no cache tags.** None of the three files exports `maxDuration`, `runtime`, `dynamic`, or `revalidate`, declares `"use cache"`, or calls `revalidateTag` — proposal writes do not invalidate the `snapshot` tag. (Verified by reading all three files end to end; they are 121, 19, and 62 lines.)
- **Nothing is written back to Wise.** The schema carries the intent as a comment: these rows deliberately do not write to Wise, which remains the source of truth for bookings ([`schema.ts:2299-2302`](../../../src/lib/db/schema.ts)).

---

## Reading active holds

### `GET /api/proposals/active`

Returns every currently active hold, reconciling stale state first. Handler: [`active/route.ts:6-19`](../../../src/app/api/proposals/active/route.ts).

**Auth:** session ([`active/route.ts:7-10`](../../../src/app/api/proposals/active/route.ts)).

**Request:** no path params, no query params, no body, no Zod schema. The handler calls `listActiveProposalHolds(getDb())` with no options ([`active/route.ts:13`](../../../src/app/api/proposals/active/route.ts)), so `reconcile` takes its default of `true` ([`data.ts:258-269`](../../../src/lib/proposals/data.ts)) — the `opts.reconcile !== false` test at [`data.ts:263`](../../../src/lib/proposals/data.ts) means only an explicit `false` skips it, and the route cannot pass one.

**Side effects:** the reconcile pass may flip rows `pending → expired` and `confirmed → auto_resolved` before the list is read ([`data.ts:253-256`](../../../src/lib/proposals/data.ts)). The auto-resolve half additionally reads the active snapshot and its blocking future sessions ([`data.ts:198-224`](../../../src/lib/proposals/data.ts)); with no active snapshot it returns 0 and changes nothing ([`data.ts:204`](../../../src/lib/proposals/data.ts)).

**Response 200** — `{ holds: ProposalHoldSummary[] }`, ordered by `proposal_items.created_at` **descending** ([`data.ts:168`](../../../src/lib/proposals/data.ts)). Each entry is built by `toSummary` ([`data.ts:98-128`](../../../src/lib/proposals/data.ts)) from the `proposal_items ⋈ proposal_bundles` inner join ([`data.ts:130-169`](../../../src/lib/proposals/data.ts)); the TypeScript interface is [`types.ts:12-36`](../../../src/lib/proposals/types.ts). Nullable columns are mapped to `undefined`, so they are **absent** from the JSON rather than `null`.

| Field | Type | Notes |
|---|---|---|
| `itemId` | string (uuid) | `proposal_items.id`. |
| `bundleId` | string (uuid) | Parent `proposal_bundles.id`. |
| `studentLabel` | string | From the bundle; free text, not a student reference. |
| `notes` | string \| absent | Bundle notes. |
| `tutorGroupId` | string \| absent | Identity-group id captured at create time; a bare `uuid` column with no FK ([`schema.ts:2318`](../../../src/lib/db/schema.ts)). |
| `tutorCanonicalKey` | string | The stable key every overlap check joins on. |
| `tutorDisplayName` | string | Captured at create time. |
| `scope` | `"recurring"` \| `"one_time"` | |
| `weekday` | number | `0` = Sunday … `6` = Saturday (JS `getDay()` semantics). |
| `date` | string \| absent | `YYYY-MM-DD`; set for one-time holds only ([`data.ts:342`](../../../src/lib/proposals/data.ts)). |
| `startMinute` / `endMinute` | number | Minute-of-day, Asia/Bangkok. |
| `startTime` / `endTime` | string | `HH:MM` rendering of those minutes. |
| `subject` / `curriculum` / `level` | string \| absent | Free text carried through from the create call. |
| `status` | `"pending"` \| `"confirmed"` | Inactive statuses can never appear here. |
| `createdByEmail` / `createdByName` | string \| absent | From the **bundle**, i.e. the creator — not the last actor. |
| `createdAt` | string (ISO 8601) | Item creation time. |
| `expiresAt` | string (ISO 8601) \| absent | The 48h window while `pending`; cleared on confirm. |
| `confirmedAt` | string (ISO 8601) \| absent | Set on confirm. |

The summary intentionally omits the item's `released_at`, `auto_resolved_at`, and `last_action_by_*` / `last_action_at` columns — they are written but never surfaced by this API.

**Status codes:**

| Status | Body | When |
|---|---|---|
| 200 | `{ holds }` | Normal. |
| 401 | `{"error":"Unauthorized"}` | No session ([`active/route.ts:8-10`](../../../src/app/api/proposals/active/route.ts)). |
| 403 | `{"error":"Forbidden"}` | Middleware denial for a restricted user; never emitted by the handler. |
| 500 | `{ error: <message> }` | Any thrown error, message-passthrough with fallback `"Failed to load proposals"` ([`active/route.ts:15-18`](../../../src/app/api/proposals/active/route.ts)). |

---

## Creating a proposal bundle

### `POST /api/proposals`

Creates one bundle plus 1+ `pending` hold items, resolving each item's tutor against the active in-memory search index and rejecting overlaps. Handler: [`route.ts:40-121`](../../../src/app/api/proposals/route.ts).

**Auth:** session ([`route.ts:41-44`](../../../src/app/api/proposals/route.ts)). `session.user?.email` / `?.name` are passed as the actor ([`route.ts:96-99`](../../../src/app/api/proposals/route.ts)) and stored on the bundle (`created_by_*`) and on every item (`last_action_by_*`) ([`data.ts:323-324,352-354`](../../../src/lib/proposals/data.ts)).

**Request body** (JSON) — Zod `proposalCreateSchema` ([`route.ts:28-32`](../../../src/app/api/proposals/route.ts)):

| Field | Type | Required | Rule |
|---|---|---|---|
| `studentLabel` | string | yes | `.trim().min(1)` — whitespace-only rejected ([`route.ts:29`](../../../src/app/api/proposals/route.ts)). |
| `notes` | string | no | Free text; trimmed at insert and stored `null` when blank ([`data.ts:322`](../../../src/lib/proposals/data.ts)). |
| `items` | array | yes | `.min(1)` ([`route.ts:31`](../../../src/app/api/proposals/route.ts)). |

Each `items[]` element — Zod `proposalItemSchema` ([`route.ts:16-26`](../../../src/app/api/proposals/route.ts)):

| Field | Type | Required | Rule |
|---|---|---|---|
| `tutorGroupId` | string | yes | `.min(1)`; must resolve in the active index (below). |
| `scope` | `"recurring"` \| `"one_time"` | yes | Enum ([`route.ts:18`](../../../src/app/api/proposals/route.ts)). |
| `weekday` | number | conditional | Int `0..6`, Zod-optional. Used as-is for `recurring`; **ignored** for `one_time`. |
| `date` | string | conditional | Zod-optional; when present must match `/^\d{4}-\d{2}-\d{2}$/` ([`route.ts:14,20`](../../../src/app/api/proposals/route.ts)). Required in practice for `one_time`; **dropped** for `recurring`, where the insert forces `proposal_date = null` ([`data.ts:342`](../../../src/lib/proposals/data.ts)). |
| `startMinute` | number | yes | Int `0..1440` ([`route.ts:21`](../../../src/app/api/proposals/route.ts)). |
| `endMinute` | number | yes | Int `1..1440` ([`route.ts:22`](../../../src/app/api/proposals/route.ts)). Zod does **not** check `end > start`; the data layer does. |
| `subject` / `curriculum` / `level` | string | no | Free text, stored verbatim. |

Zod marks `weekday` and `date` independently optional; the real per-scope requirement is enforced by the handler and `validateCreateInput`, not by the schema.

**Pipeline, in order:**

1. **Parse** — non-JSON body → **400** `{"error":"Invalid JSON"}` ([`route.ts:46-51`](../../../src/app/api/proposals/route.ts)); schema failure → **400** `{"error":"Invalid request","details": <parsed.error.flatten()>}` ([`route.ts:53-59`](../../../src/app/api/proposals/route.ts)).
2. **Resolve tutors against the active snapshot** — `await ensureIndex(db)` ([`route.ts:64`](../../../src/app/api/proposals/route.ts), [`search/index.ts:354`](../../../src/lib/search/index.ts)), then a `Map` of `IndexedTutorGroup` by id ([`route.ts:65`](../../../src/app/api/proposals/route.ts)). An unknown `tutorGroupId` throws `ProposalValidationError("Tutor not found in active snapshot: <id>")` → **400** ([`route.ts:68-71`](../../../src/app/api/proposals/route.ts)). A cold process pays the index build (or joins an in-flight one) inside this request.
3. **Derive the weekday** — `weekdayForIsoDate(date ?? "")` for `one_time`, else the supplied `weekday` ([`route.ts:73-76`](../../../src/app/api/proposals/route.ts)). `undefined` or `NaN` — a `recurring` item with no `weekday`, or a `one_time` item with no/invalid `date` — throws `ProposalValidationError("Proposal item needs a valid day/date")` → **400** ([`route.ts:77-79`](../../../src/app/api/proposals/route.ts)).
4. **Denormalize identity** — the item is rewritten with the group's `id`, `canonicalKey`, and `displayName` ([`route.ts:81-87`](../../../src/app/api/proposals/route.ts)); the canonical key is what gets stored and matched on, which is why a hold survives the 30-minute snapshot rebuild that reissues every identity-group id.
5. **Server-side validation** — `validateCreateInput` ([`data.ts:271-298`](../../../src/lib/proposals/data.ts)) raises `ProposalValidationError` → **400** for: empty `studentLabel`; empty `items`; `endMinute <= startMinute` or minutes outside `0..1440` (`"Each proposal item needs a valid time range"`); weekday outside `0..6`; a `one_time` item with no `date`; or **two requested items overlapping each other** (`"Requested proposal items overlap each other"`).
6. **Conflict pre-check** — reconcile, list active holds with `reconcile: false`, and run `findConflictingProposal` per item ([`data.ts:307-315`](../../../src/lib/proposals/data.ts)). Overlap means same `tutorCanonicalKey` **and** overlapping minute range **and** matching day: same weekday when both are recurring, same `date` when both are one-time, same weekday for a mixed pair ([`overlap.ts:69-82`](../../../src/lib/proposals/overlap.ts)). A hit throws `ProposalConflictError` carrying the offending hold → **409**.
7. **Insert** — one `proposal_bundles` row ([`data.ts:318-328`](../../../src/lib/proposals/data.ts)), then N `proposal_items` rows in a single statement, each `status: "pending"` with the shared `expiresAt` ([`data.ts:332-357`](../../../src/lib/proposals/data.ts)).

**Database backstop (fail-closed second layer).** Two GiST `EXCLUDE` constraints scoped to `status IN ('pending','confirmed')` reject an overlapping insert at write time: `proposal_items_no_recurring_overlap` (canonical key `=`, weekday `=`, `int4range(start,end,'[)')` `&&`, `WHERE scope = 'recurring'`) and `proposal_items_no_one_time_overlap` (canonical key, `proposal_date`, same range operator, `WHERE scope = 'one_time'`) ([`0006_admin_proposal_holds.sql:48-57`](../../../drizzle/0006_admin_proposal_holds.sql)). On such a violation the data layer deletes the just-created bundle (best-effort, `.catch(() => undefined)`), re-derives the conflicting hold from a refreshed active list, and re-throws `ProposalConflictError` ([`data.ts:360-377`](../../../src/lib/proposals/data.ts)); its detector accepts SQLSTATE `23P01`, either constraint name, or the name appearing in the message ([`data.ts:68-83`](../../../src/lib/proposals/data.ts)). The route keeps a **narrower** duplicate of that detector — message-substring only ([`route.ts:34-38`](../../../src/app/api/proposals/route.ts)) — as a secondary guard mapping any DB-overlap error that escapes the data layer to **409 without a `conflict` body**.

The same migration installs three CHECK constraints — `end_minute > start_minute`, `weekday` between 0 and 6, and `status <> 'pending' OR expires_at IS NOT NULL` ([`0006_admin_proposal_holds.sql:41-43`](../../../drizzle/0006_admin_proposal_holds.sql)). Application validation covers all three first, so a violation reaching Postgres would surface as an unmapped **500**, not a 400.

**Side effects:** the bundle + item inserts above; the upfront reconcile, which can expire or auto-resolve unrelated items. **There is no transaction** — bundle and items are two separate statements with a compensating delete on failure ([`data.ts:318-364`](../../../src/lib/proposals/data.ts)), a consequence of the Neon HTTP driver. Downstream, a new hold changes what other reads return: range search overlays active holds ([`range-search.ts:116`](../../../src/lib/search/range-search.ts)) and the AI scheduler loads them when drafting a parent reply ([`scheduler-service.ts:61-63`](../../../src/lib/ai/scheduler-service.ts)). Nothing reaches Wise.

**Response 201** ([`route.ts:101`](../../../src/app/api/proposals/route.ts), assembled at [`data.ts:379-383`](../../../src/lib/proposals/data.ts)):

```json
{
  "bundleId": "…uuid…",
  "items": [ { "itemId": "…", "status": "pending", "startTime": "15:00", "endTime": "16:30", "…": "…" } ]
}
```

`items` is the just-created set, filtered out of a refreshed active-holds read (`reconcile: false`); each entry is a [hold summary](#get-apiproposalsactive).

**Status codes** — the catch chain is conflict → validation → DB-overlap → generic ([`route.ts:102-120`](../../../src/app/api/proposals/route.ts)):

| Status | Body | When |
|---|---|---|
| 201 | `{ bundleId, items }` | Bundle created. |
| 400 | `{"error":"Invalid JSON"}` | Body is not JSON ([`route.ts:49-51`](../../../src/app/api/proposals/route.ts)). |
| 400 | `{"error":"Invalid request","details":…}` | Zod failure ([`route.ts:53-59`](../../../src/app/api/proposals/route.ts)). |
| 400 | `{ error: <message> }` | `ProposalValidationError` — tutor not in snapshot, invalid day/date, bad time range, one-time without date, items overlapping each other ([`route.ts:109-111`](../../../src/app/api/proposals/route.ts)). |
| 401 | `{"error":"Unauthorized"}` | No session. |
| 403 | `{"error":"Forbidden"}` | Middleware denial; not emitted by the handler. |
| 409 | `{"error":"Proposal conflicts with an active hold","conflict": <hold summary>}` | `ProposalConflictError` from either the pre-check or the DB-backstop re-derivation ([`route.ts:103-108`](../../../src/app/api/proposals/route.ts)). |
| 409 | `{"error":"Proposal conflicts with an active hold"}` | DB-overlap error that escaped the data layer — **no `conflict` key** ([`route.ts:112-117`](../../../src/app/api/proposals/route.ts)). |
| 500 | `{ error: <message> }` | Anything else, including an `ensureIndex` failure; fallback `"Failed to create proposal"` ([`route.ts:118-120`](../../../src/app/api/proposals/route.ts)). |

---

## Acting on a single hold

### `PATCH /api/proposals/items/[itemId]`

Applies one lifecycle action — `confirm`, `release`, or `extend` — to one item, then returns the refreshed active list. Handler: [`items/[itemId]/route.ts:15-62`](../../../src/app/api/proposals/items/[itemId]/route.ts).

**Auth:** session ([`items/[itemId]/route.ts:19-22`](../../../src/app/api/proposals/items/[itemId]/route.ts)). `session.user?.email` / `?.name` are recorded as `last_action_by_email` / `last_action_by_name` alongside `last_action_at` and `updated_at` ([`items/[itemId]/route.ts:46-49`](../../../src/app/api/proposals/items/[itemId]/route.ts), [`data.ts:407-412`](../../../src/lib/proposals/data.ts)).

**Path parameter:**

| Param | Type | Notes |
|---|---|---|
| `itemId` | string | The `proposal_items.id` (`uuid`, [`schema.ts:2316`](../../../src/lib/db/schema.ts)). Awaited from `ctx.params`, a `Promise` under Next.js 16 ([`items/[itemId]/route.ts:17,39`](../../../src/app/api/proposals/items/[itemId]/route.ts)). The handler does **not** validate its format, so a non-UUID string reaches Postgres as a `uuid` comparison and surfaces through the generic catch as **500**, not 404. |

**Request body** (JSON) — Zod `patchSchema` ([`items/[itemId]/route.ts:11-13`](../../../src/app/api/proposals/items/[itemId]/route.ts)):

| Field | Type | Required | Rule |
|---|---|---|---|
| `action` | `"confirm"` \| `"release"` \| `"extend"` | yes | Enum; the only key the schema declares (`ProposalPatchAction`, [`types.ts:68`](../../../src/lib/proposals/types.ts)). |

**Behavior by action** — `patchProposalItem` ([`data.ts:386-474`](../../../src/lib/proposals/data.ts)) reconciles ([`data.ts:393`](../../../src/lib/proposals/data.ts)), loads the item by id, and throws `ProposalNotFoundError("Proposal item not found")` → **404** when there is no row ([`data.ts:395-405,54-59`](../../../src/lib/proposals/data.ts)). Each action then applies a state guard that throws `ProposalValidationError` → **400**:

| Action | Allowed from | Effect | Guard message on violation |
|---|---|---|---|
| `confirm` | `pending`, `confirmed` | `status = 'confirmed'`, `expires_at = null`, `confirmed_at = now`; **and** every *other* still-`pending` item in the same bundle is set `released` with `released_at` ([`data.ts:414-442`](../../../src/lib/proposals/data.ts)). Re-confirming an already-confirmed item is allowed and re-stamps `confirmed_at`. | `"Only active proposal holds can be confirmed"` |
| `release` | `pending`, `confirmed` | `status = 'released'`, `released_at = now` ([`data.ts:443-454`](../../../src/lib/proposals/data.ts)). | `"Only active proposal holds can be released"` |
| `extend` | `pending` only | `expires_at = now + 48h`; status unchanged ([`data.ts:455-465`](../../../src/lib/proposals/data.ts)). | `"Only pending proposal holds can be extended"` |

**Side effects:** the update(s) above; the `confirm` cascade onto sibling pending items in the same bundle; an unconditional bump of the parent bundle's `updated_at` ([`data.ts:468-471`](../../../src/lib/proposals/data.ts)); plus the upfront reconcile, which may have expired or auto-resolved unrelated items. Nothing reaches Wise.

**Response 200** — `{ holds: ProposalHoldSummary[] }`: the active list *after* the action, read with `reconcile: false` because the reconcile already ran ([`data.ts:473`](../../../src/lib/proposals/data.ts), returned at [`items/[itemId]/route.ts:51`](../../../src/app/api/proposals/items/[itemId]/route.ts)). A just-released item drops out; a just-confirmed item stays with `status: "confirmed"` and no `expiresAt`. Same [hold summary](#get-apiproposalsactive) shape.

**Status codes:**

| Status | Body | When |
|---|---|---|
| 200 | `{ holds }` | Action applied. |
| 400 | `{"error":"Invalid JSON"}` | Body is not JSON ([`items/[itemId]/route.ts:27-30`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 400 | `{"error":"Invalid request","details":…}` | `action` missing or not one of the three ([`items/[itemId]/route.ts:31-37`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 400 | `{ error: <guard message> }` | `ProposalValidationError` — action not allowed from the item's current status ([`items/[itemId]/route.ts:56-58`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 401 | `{"error":"Unauthorized"}` | No session. |
| 403 | `{"error":"Forbidden"}` | Middleware denial; not emitted by the handler. |
| 404 | `{"error":"Proposal item not found"}` | No row with that id ([`items/[itemId]/route.ts:53-55`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |
| 500 | `{ error: <message> }` | Anything else, including a malformed `itemId`; fallback `"Failed to update proposal"` ([`items/[itemId]/route.ts:59-61`](../../../src/app/api/proposals/items/[itemId]/route.ts)). |

---

## In-repo clients and tests

- **UI callers**, all inside the `/search` workspace — there is no proposals page. The hold modal `POST`s to `/api/proposals` ([`proposal-hold-modal.tsx:94`](../../../src/components/search/proposal-hold-modal.tsx)) and is the one caller that reads an error body: on `409` with a `conflict` key it renders "<tutor> is already held for <student> at <start>-<end>", otherwise it surfaces `data.error` ([`proposal-hold-modal.tsx:114-121`](../../../src/components/search/proposal-hold-modal.tsx)), then hands `data.items` to its `onCreated` callback ([`:126`](../../../src/components/search/proposal-hold-modal.tsx)). The workspace `GET`s `/api/proposals/active` on mount and after each create ([`search-workspace.tsx:240`](../../../src/components/search/search-workspace.tsx)) and `PATCH`es `/api/proposals/items/{itemId}` per action ([`search-workspace.tsx:269`](../../../src/components/search/search-workspace.tsx)); both of those bail silently on a non-`ok` response.
- **Route tests** — [`src/app/api/proposals/__tests__/route.test.ts`](../../../src/app/api/proposals/__tests__/route.test.ts), one file covering all three handlers with the data layer and `ensureIndex` mocked: 401 on `GET`, the 200 `{ holds }` list, the 201 create with tutor identity resolved from the index, the 409 conflict body, and the `PATCH` → `patchProposalItem` wiring (including the awaited `params` promise). Overlap semantics are tested separately against `src/lib/proposals/overlap.ts`.

## Notes and open questions

- **Restricted users are locked out by namespace, not by explicit design.** The UI lives in `/search` but the API namespace is `/api/proposals`, and `isPathAllowed` only grants `/api${page}`. A page-restricted admin granted `["/search"]` gets a middleware **403** on all three endpoints while the surrounding search page works. Is holds-for-full-admins-only the intent, or should `/api/proposals` be aliased under a `/search` grant?
- **Reads mutate.** All three endpoints reconcile before answering, so `GET /api/proposals/active` is not idempotent at the row level. This is deliberate given there is no proposal cron, but it makes the read path dependent on the active snapshot and on `future_session_blocks`.
- **The route-level DB-overlap detector is weaker than the data layer's.** [`route.ts:34-38`](../../../src/app/api/proposals/route.ts) matches on message substring only, while [`data.ts:68-83`](../../../src/lib/proposals/data.ts) also matches SQLSTATE `23P01` and the `constraint` property. A driver that surfaces the constraint only as a code, and an error that somehow bypassed the data layer's own handler, would fall through to **500** instead of 409.
- **`POST` is not transactional**, so a crash between the bundle insert and the item insert leaves an orphan `proposal_bundles` row. Harmless to every read here — they all inner-join from `proposal_items` — but it is unreferenced data.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
