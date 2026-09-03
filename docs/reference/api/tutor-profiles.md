# Tutor Profiles API

**4 endpoints**, all under `/api/tutor-profiles`, all admin-session. Feature meaning — why editorial profiles exist, what the import is for, which fields are parent-safe — lives in [docs/features/tutor-profiles.md](../../features/tutor-profiles.md). Column-level detail for `tutor_business_profiles` lives in [docs/reference/database/erd-tutor-profiles.md](../database/erd-tutor-profiles.md). The full cross-group endpoint table is [docs/reference/api/index.md](./index.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

**Authoritative source:** the four handlers under [`src/app/api/tutor-profiles/`](../../../src/app/api/tutor-profiles/), plus the two libs they delegate to — [`src/lib/tutor-business-profiles.ts`](../../../src/lib/tutor-business-profiles.ts) (Zod patch schema, list, upsert) and [`src/lib/tutor-profile-import.ts`](../../../src/lib/tutor-profile-import.ts) (workbook parse, match, merge, preview).

## Endpoint index (4)

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/tutor-profiles` | session | none | [`route.ts:6-19`](../../../src/app/api/tutor-profiles/route.ts) |
| PATCH | `/api/tutor-profiles/[canonicalKey]` | session | one `tutor_business_profiles` upsert + index clear | [`[canonicalKey]/route.ts:18-57`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts) |
| POST | `/api/tutor-profiles/import-preview` | session | none (pure dry-run) | [`import-preview/route.ts:25-71`](../../../src/app/api/tutor-profiles/import-preview/route.ts) |
| POST | `/api/tutor-profiles/import-commit` | session | up to 200 upserts + conditional index clear | [`import-commit/route.ts:19-67`](../../../src/app/api/tutor-profiles/import-commit/route.ts) |

There is **no tutor-profiles cron and no server-side caller**: the only in-repo consumers of all four are the one client workspace component ([`tutor-profiles-workspace.tsx:136,242,283,302`](../../../src/components/tutor-profiles/tutor-profiles-workspace.tsx)). The page itself renders no payload server-side — it only gates on `auth()` and mounts the workspace ([`(app)/tutor-profiles/page.tsx:6-13`](../../../src/app/%28app%29/tutor-profiles/page.tsx)).

---

## Conventions shared by all four endpoints

**Auth.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and returns `401 {"error":"Unauthorized"}` when there is no session ([`route.ts:7-10`](../../../src/app/api/tutor-profiles/route.ts), [`[canonicalKey]/route.ts:22-25`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts), [`import-preview/route.ts:26-29`](../../../src/app/api/tutor-profiles/import-preview/route.ts), [`import-commit/route.ts:20-23`](../../../src/app/api/tutor-profiles/import-commit/route.ts)). There is no role model, no capability grant, and no `session.user.email` requirement — any signed-in user who reaches these paths can read every profile, edit any profile, and commit a bulk import. None of the four is cron-protected or public.

**Middleware.** `/api/tutor-profiles/**` is not in the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)). A restricted user whose `allowedPages` does not include `/tutor-profiles` gets a middleware-level `403 {"error":"Forbidden"}` — `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:59-66`](../../../src/middleware.ts), [`:97-100`](../../../src/middleware.ts)), so a `/tutor-profiles` page grant implicitly covers this whole API namespace. The feature has no special case in that function.

**No route config.** None of the four declares `maxDuration`, `runtime`, `dynamic`, or `"use cache"` — `grep -rn "maxDuration\|export const runtime\|export const dynamic\|use cache" src/app/api/tutor-profiles/` returns nothing. Every request reads Postgres directly on the default function limits.

**The canonical key is the identity.** All four address a tutor by `canonicalKey`, the primary key of `tutor_business_profiles` ([`schema.ts:1986`](../../../src/lib/db/schema.ts)) and the durable cross-snapshot key on `tutor_identity_groups`. Profile rows are snapshot-independent: a Wise sync rotates the snapshot but never touches this table.

**The active snapshot gates every write.** `getActiveSnapshotIdOrThrow` throws the literal `No active snapshot found` when `snapshots.active = true` matches no row ([`active-snapshot.ts:5-17`](../../../src/lib/data/active-snapshot.ts)). `GET`, `import-preview` and `import-commit` all reach it through their list helpers, so on a database with no promoted snapshot they return **500**, not an empty list.

**Missing-table tolerance, read-side only.** `listTutorBusinessProfiles` swallows a missing-or-drifted `tutor_business_profiles` table and returns `[]` instead of throwing — `isMissingTutorProfileTable` matches the table name plus `does not exist` / `column` / SQLSTATE `42P01` / `42703` ([`tutor-business-profiles.ts:185-207`](../../../src/lib/tutor-business-profiles.ts)). The write path (`upsertTutorBusinessProfile`) has no such guard, so the same drift surfaces as a 500 on `PATCH` and `import-commit`.

**Search-index invalidation.** The in-memory search index carries each tutor's profile as `IndexedTutorGroup.businessProfile` ([`search/index.ts:80,317`](../../../src/lib/search/index.ts)), so an edit must invalidate it. Both write endpoints call `clearSearchIndex()`, which nulls the `globalThis` singleton **and** the in-flight build promise ([`search/index.ts:123-126`](../../../src/lib/search/index.ts)) — the next `executeSearch` rebuilds. That only clears the *current process*; other serverless instances pick the change up through the independent staleness check, which compares a `count:max(updated_at)` fingerprint of the table against the cached `profileVersion` ([`search/index.ts:128-137`](../../../src/lib/search/index.ts), [`:368-383`](../../../src/lib/search/index.ts)). So a write is visible everywhere either way; `clearSearchIndex()` only makes it immediate locally.

**Error shape.** Each handler wraps its business logic in `try/catch` and returns `{"error": <message>}` with the handler's own default string for a non-`Error` throw. Zod failures return `{"error":"Invalid request","details": <flatten()>}`.

**Tests.** There are **no route tests** — `src/app/api/tutor-profiles/` contains only the four `route.ts` files, and `src/components/tutor-profiles/` has no `__tests__/`. The one suite in this area is [`src/lib/__tests__/tutor-profile-import.test.ts`](../../../src/lib/__tests__/tutor-profile-import.test.ts): 5 cases in a single `describe`, all against `buildTutorProfileImportPreview` (availability-only flagging, conservative English mapping, alias-stabilized matching, swapped nickname/legal-name matching, ambiguous-match blocking).

### The profile patch schema

Three of the four endpoints share one Zod object, `tutorBusinessProfilePatchSchema` ([`tutor-business-profiles.ts:36-55`](../../../src/lib/tutor-business-profiles.ts)). It is `.strict()`, so an unknown key is a 400 rather than a silently ignored field, and **every field is optional** — an omitted field means "leave the stored value alone", not "clear it".

| Field | Type | Limit |
|-------|------|-------|
| `displayName` | string | trimmed, 1–160 |
| `parentSafeSummary` | string | ≤ 1200 |
| `internalNotes` | string | ≤ 3000 |
| `education` | array of `{ institution, country?, program?, notes? }`, each `.strict()` | ≤ 12 entries; institution ≤ 160, country ≤ 80, program ≤ 240, notes ≤ 500 ([`:23-28`](../../../src/lib/tutor-business-profiles.ts)) |
| `languages` | array of `{ language, proficiency, verificationSource? }`, each `.strict()` | ≤ 12 entries; language ≤ 80, proficiency ≤ 80, source ≤ 160 ([`:30-34`](../../../src/lib/tutor-business-profiles.ts)) |
| `englishProficiency` | enum `native` \| `near-native` \| `fluent` \| `conversational` \| `basic` \| `unknown` | [`:7-14`](../../../src/lib/tutor-business-profiles.ts) |
| `youngLearnerFit` | enum `comfortable` \| `not_comfortable` \| `conditional` \| `unknown` | [`:16-21`](../../../src/lib/tutor-business-profiles.ts) |
| `youngestComfortableAge` | integer \| `null` | 3–20 |
| `youngLearnerNotes` | string | ≤ 2000 |
| `teachingStyleTags` | string[] | ≤ 30 tags, each trimmed 1–80 |
| `teachingStyleNotes` | string | ≤ 2000 |
| `strengthTags` | string[] | ≤ 30 tags, each trimmed 1–80 |
| `curriculumExperience` | string[] | ≤ 30 tags, each trimmed 1–80 |
| `studentFitNotes` | string | ≤ 2000 |
| `doNotUseForNotes` | string | ≤ 2000 |
| `verifiedBy` | string \| `null` | trimmed ≤ 160 |
| `lastReviewedAt` | ISO datetime string \| `null` | `z.string().datetime()` — a bare `YYYY-MM-DD` is **rejected** ([`:53`](../../../src/lib/tutor-business-profiles.ts)) |
| `active` | boolean | — |

**Upsert semantics** (`upsertTutorBusinessProfile`, [`tutor-business-profiles.ts:328-399`](../../../src/lib/tutor-business-profiles.ts)): the row is read first, an absent row is synthesized as an all-defaults profile ([`:151-177`](../../../src/lib/tutor-business-profiles.ts)), then each field falls back to the existing value with `??`. Four fields deviate:

- `displayName` — `patch.displayName?.trim() || existing || fallbackDisplayName`, so an all-whitespace name falls through to the active-snapshot display name rather than being stored ([`:342`](../../../src/lib/tutor-business-profiles.ts)).
- `youngestComfortableAge` — compared with `=== undefined`, so an explicit `null` **does** clear it ([`:349-351`](../../../src/lib/tutor-business-profiles.ts)).
- `verifiedBy` / `lastReviewedAt` — same `=== undefined` test; an explicit `null`, or a `verifiedBy` that trims to empty, clears the column ([`:359-364`](../../../src/lib/tutor-business-profiles.ts)).
- The three tag arrays are pushed through `normalizeList` — trim, drop blanks, de-dupe case-insensitively, first spelling wins ([`:112-124`](../../../src/lib/tutor-business-profiles.ts)).

The write is a single `INSERT … ON CONFLICT (canonical_key) DO UPDATE … RETURNING` ([`:369-396`](../../../src/lib/tutor-business-profiles.ts)) that always bumps `updatedAt` — which is what moves the search index's `profileVersion` fingerprint.

---

## Reading the roster

### `GET /api/tutor-profiles`

Returns one row per tutor in the **active snapshot**, joined to the saved editorial profile. Read-only: no writes, no Wise calls. Handler [`route.ts:6-19`](../../../src/app/api/tutor-profiles/route.ts).

**Auth:** session required ([`route.ts:7-10`](../../../src/app/api/tutor-profiles/route.ts)).

**Request:** none — no query parameters, no body, no path segments. The handler takes no `Request` argument at all.

**Response `200`:** `{ profiles: TutorBusinessProfileListItem[] }` ([`route.ts:14`](../../../src/app/api/tutor-profiles/route.ts)). Each item is a `TutorBusinessProfile` ([`tutor-business-profiles.ts:61-91`](../../../src/lib/tutor-business-profiles.ts)) plus three snapshot-derived keys ([`:93-97`](../../../src/lib/tutor-business-profiles.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `canonicalKey` | string | Join key. |
| `displayName` | string | The saved profile name, falling back to the identity group's ([`:271`](../../../src/lib/tutor-business-profiles.ts)). |
| `parentSafeSummary`, `internalNotes`, `youngLearnerNotes`, `teachingStyleNotes`, `studentFitNotes`, `doNotUseForNotes` | string | `""` when unset — never `null`. |
| `education`, `languages` | object arrays | Stored `jsonb`, `[]` when unset. |
| `englishProficiency`, `youngLearnerFit` | enum strings | Read through `.catch("unknown")`, so a drifted stored value degrades to `unknown` instead of throwing ([`:134-135`](../../../src/lib/tutor-business-profiles.ts)). |
| `youngestComfortableAge` | number \| `null` | — |
| `teachingStyleTags`, `strengthTags`, `curriculumExperience` | string[] | — |
| `verifiedBy`, `lastReviewedAt` | string \| `null` | `lastReviewedAt` is ISO-8601. |
| `active` | boolean | — |
| `updatedAt` | string | ISO-8601; **`1970-01-01T00:00:00.000Z` for a synthesized profile** ([`:175`](../../../src/lib/tutor-business-profiles.ts)) — the marker that no row exists yet. |
| `tutorGroupId` | string | `tutor_identity_groups.id` for the active snapshot. |
| `supportedModes` | string[] | `["online","onsite"]` for `both`, `[]` for `unresolved`, else the single modality ([`:179-183`](../../../src/lib/tutor-business-profiles.ts)) — fail-closed: unresolved yields no mode, never a guess. |
| `subjects` | string[] | Distinct `subject_level_qualifications.subject` for the group, sorted. |

**Shape notes.** The roster is driven by the **snapshot**, not by the profile table: `listTutorBusinessProfiles` lists every identity group in the active snapshot and synthesizes an all-defaults profile for any group with no saved row ([`:262-276`](../../../src/lib/tutor-business-profiles.ts)), so a tutor with no profile still appears. The converse also holds — a saved profile whose `canonicalKey` has left the active snapshot is **not** returned. `active: false` is *not* a filter here: this endpoint reads all rows (`selectAllTutorBusinessProfiles`, [`:209-216`](../../../src/lib/tutor-business-profiles.ts)), unlike `loadTutorBusinessProfileMap`, which the search-index build uses and which selects only `active = true` ([`:218-228,323-326`](../../../src/lib/tutor-business-profiles.ts)). Results are sorted by `displayName.localeCompare` ([`:276`](../../../src/lib/tutor-business-profiles.ts)). Three reads run in parallel (groups, qualifications, profiles) after the active-snapshot lookup ([`:233-251`](../../../src/lib/tutor-business-profiles.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | `{ profiles }`. An empty array is legitimate — a snapshot with no identity groups. |
| 401 | No session. |
| 500 | Any throw, most plausibly `No active snapshot found`. Body `{"error": <message>}`, defaulting to `"Failed to load tutor profiles"` ([`route.ts:16`](../../../src/app/api/tutor-profiles/route.ts)). |

---

## Editing one profile

### `PATCH /api/tutor-profiles/[canonicalKey]`

Upserts one tutor's editorial profile. Handler [`[canonicalKey]/route.ts:18-57`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts).

**Auth:** session required ([`:22-25`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)).

**Path parameter:** `canonicalKey`, awaited from the Next 16 async `params` promise and then `decodeURIComponent`-ed ([`:13-16,43`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)) — so a key containing `/` or `#` must be percent-encoded by the caller, as the workspace does ([`tutor-profiles-workspace.tsx:242`](../../../src/components/tutor-profiles/tutor-profiles-workspace.tsx)).

**Body:** `tutorBusinessProfilePatchSchema` applied to the **whole body** — there is no wrapper key ([`:34`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)). Fields, limits, and clear-vs-leave-alone semantics are in [the profile patch schema](#the-profile-patch-schema) above. `{}` is valid and is a no-op except for the `updatedAt` bump.

**Existence gate.** After validation the handler resolves the tutor's display name from the **active snapshot** (`getActiveTutorDisplayNameByCanonicalKey`, [`tutor-business-profiles.ts:401-415`](../../../src/lib/tutor-business-profiles.ts)); a miss is `404 {"error":"Tutor not found in active snapshot"}` ([`:44-47`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)). Note the ordering: **404 is checked outside the `try/catch`**, so a `No active snapshot found` throw from that same call escapes the handler unhandled rather than becoming the usual 500 JSON.

**Side effects.**

1. One upsert into `tutor_business_profiles` ([`schema.ts:1985-2019`](../../../src/lib/db/schema.ts)), `updatedAt` set to now.
2. `clearSearchIndex()` — unconditional on success ([`:51`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)), so the next search in this process rebuilds from Postgres.

Nothing is written to Wise, and no audit row is recorded — the only trace of who changed what is the client-supplied `verifiedBy` / `lastReviewedAt` pair, which is editorial metadata, not an actor stamp.

**Response `200`:** `{ profile }` — the stored row after the write, as a `TutorBusinessProfile` (no `tutorGroupId` / `supportedModes` / `subjects`; the workspace re-attaches those from its own state, [`tutor-profiles-workspace.tsx:249-258`](../../../src/components/tutor-profiles/tutor-profiles-workspace.tsx)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Profile saved. |
| 400 | Unparseable JSON → `{"error":"Invalid JSON"}` ([`:28-31`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)); or Zod failure → `{"error":"Invalid request","details": …}` ([`:33-40`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)) — including an unknown key (`.strict()`), an over-limit string, an out-of-range age, or a `lastReviewedAt` that is not a full ISO datetime. |
| 401 | No session. |
| 404 | `canonicalKey` absent from the active snapshot. |
| 500 | Any throw from the upsert; body `{"error": <message>}`, defaulting to `"Failed to save tutor profile"` ([`:54`](../../../src/app/api/tutor-profiles/%5BcanonicalKey%5D/route.ts)). Not produced for a missing active snapshot — see the ordering note above. |

---

## Bulk import (preview → commit)

Two endpoints, used strictly in that order by the workspace. The preview is where all the parsing, matching, and merging happens; the commit is a thin persistence step over patches the admin has already seen.

### `POST /api/tutor-profiles/import-preview`

Parses one or two uploaded workbooks, matches each source row to an active tutor, merges the derived patch against the stored profile, and returns the proposal. **Writes nothing.** Handler [`import-preview/route.ts:25-71`](../../../src/app/api/tutor-profiles/import-preview/route.ts).

**Auth:** session required ([`:26-29`](../../../src/app/api/tutor-profiles/import-preview/route.ts)).

**Body:** `multipart/form-data` — the only non-JSON body in this group. There is no Zod schema; the four fields are read by hand ([`:14-23,40-46,62-63`](../../../src/app/api/tutor-profiles/import-preview/route.ts)).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `educationFile` | file | at least one of the two | Ignored unless it is a `File` with `size > 0` ([`:15-17`](../../../src/app/api/tutor-profiles/import-preview/route.ts)); read into a `Buffer` and parsed by `parseEducationWorkbook`. |
| `availabilityFile` | file | at least one of the two | Same treatment; parsed by `parseAvailabilityWorkbook`. |
| `verifiedBy` | string | no | Trimmed; empty → `null` ([`:20-23`](../../../src/app/api/tutor-profiles/import-preview/route.ts)). Stamped onto every candidate patch. |
| `lastReviewedAt` | string | no | Same trim-or-null. Passed through verbatim — **not validated here**, so a non-ISO value survives preview and only fails at commit against `z.string().datetime()`. |

Supplying neither file is `400 {"error":"Upload at least one tutor profile workbook"}` ([`:48-50`](../../../src/app/api/tutor-profiles/import-preview/route.ts)).

**Parsing.** Only the **first worksheet** of each workbook is read, header-row mode, `raw: false`, blank rows dropped ([`tutor-profile-import.ts:276-287`](../../../src/lib/tutor-profile-import.ts)). The education sheet is header-mapped with alias lists per column and rows are kept only when at least one of `canonicalKey` / `firstName` / `lastName` is present ([`:289-312`](../../../src/lib/tutor-profile-import.ts)). The availability sheet supports **two shapes**: a modern single-header sheet detected by the presence of a `canonicalKey` header, otherwise a legacy two-row-header layout read by fixed column indices (tier 0, nickname 1, first 2, last 3, academic background 18, achievement 19, highlights 20, picture 21) ([`:314-359`](../../../src/lib/tutor-profile-import.ts)). `rowNumber` is 1-based against the sheet so the returned diagnostics point at a real spreadsheet row.

**Matching.** Rows from the two sheets are first combined on a normalized name key ([`:604-650`](../../../src/lib/tutor-profile-import.ts)), then resolved against a lookup built from three inputs fetched in parallel with the files: the active-snapshot roster (`listTutorBusinessProfiles`), the identity groups with their Wise display names (`listTutorProfileImportIdentities`), and the `tutor_aliases` table (`listTutorProfileImportAliases`) ([`import-preview/route.ts:40-46`](../../../src/app/api/tutor-profiles/import-preview/route.ts), helpers at [`tutor-business-profiles.ts:279-321`](../../../src/lib/tutor-business-profiles.ts)). Nine deterministic match types are possible — `canonicalKey`, `displayName`, `nickname`, `fullName`, `alias`, `wiseDisplayName`, `wiseFullName`, `wiseNickname`, `wiseNicknameLastName` ([`tutor-profile-import.ts:59-68`](../../../src/lib/tutor-profile-import.ts)). A row matching more than one distinct tutor is **not** guessed: it goes to `ambiguousRows` with its candidates and is excluded from `rows`, so it can never be committed ([`:834-845`](../../../src/lib/tutor-profile-import.ts)).

**Merging.** The candidate patch derived from the sheets is merged against the **existing** profile by `mergePatchWithExisting` ([`:578-602`](../../../src/lib/tutor-profile-import.ts)), which is additive and existing-wins: text fields append only when the incoming text is not already contained; tags union; `youngLearnerFit`, `youngestComfortableAge`, `verifiedBy`, `lastReviewedAt` keep the stored value when set; `doNotUseForNotes` and `active` are carried straight through from the existing row, so an import can never set a do-not-use note or retire a tutor. Derived text is clamped at 1200 (parent summary), 3000 (internal notes), and 2000 (other notes) characters ([`:171-173,439-441`](../../../src/lib/tutor-profile-import.ts)). Weekly availability columns are deliberately dropped, with a note written into `internalNotes` recording that Wise remains the scheduling source of truth ([`:490`](../../../src/lib/tutor-profile-import.ts)).

**Response `200`:** the `TutorProfileImportPreview` object verbatim — no wrapper key ([`import-preview/route.ts:66`](../../../src/app/api/tutor-profiles/import-preview/route.ts)). Shape at [`tutor-profile-import.ts:102-123`](../../../src/lib/tutor-profile-import.ts):

| Key | Type | Notes |
|-----|------|-------|
| `summary` | object | Eight counters: `educationRows`, `availabilityRows`, `matchedRows`, `unmatchedRows`, `duplicateSourceRows`, `availabilityOnlyRows`, `invalidRows`, `ambiguousRows`. |
| `rows` | `TutorProfileImportMatchedRow[]` | The committable proposals, sorted by `displayName`. Each carries `canonicalKey`, `displayName`, `matchedBy`, `matchMethod`, `matchEvidence` (`{matchType, sourceField, sourceValue, matchedValue}`), `sourceName`, `patch`, `warnings`, `sources` ([`:70-87`](../../../src/lib/tutor-profile-import.ts)). |
| `unmatchedRows` | `TutorProfileImportUnmatchedRow[]` | No active tutor matched; carries `tried` — the candidate keys attempted ([`:89-100`](../../../src/lib/tutor-profile-import.ts)). |
| `ambiguousRows` | same type | Multiple tutors matched; additionally carries `candidates`. |
| `duplicateSourceRows` | string[] | Human-readable `"<sheet> row N: <name>"` labels. |
| `availabilityOnlyRows` | string[] | Names present in the availability sheet with no education row. |
| `invalidRows` | string[] | Currently only "invalid youngest comfortable age" ([`:849-850`](../../../src/lib/tutor-profile-import.ts)). |
| `vocabulary` | object | The controlled vocabularies echoed back for the UI chips: `teachingStyleTags` (9 `{tag,label,synonyms}` entries) and `curriculumExperience` (10 strings) ([`tutor-profile-vocabulary.ts:1-60`](../../../src/lib/tutor-profile-vocabulary.ts)). |

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Preview returned. A preview with zero matched rows is still 200. |
| 400 | Body is not multipart → `{"error":"Expected multipart form data"}` ([`:31-36`](../../../src/app/api/tutor-profiles/import-preview/route.ts)); or neither file was supplied. |
| 401 | No session. |
| 500 | Any throw — a corrupt or non-spreadsheet upload reaching `XLSX.read`, or `No active snapshot found`. Body `{"error": <message>}`, defaulting to `"Failed to preview tutor profile import"` ([`:68`](../../../src/app/api/tutor-profiles/import-preview/route.ts)). |

### `POST /api/tutor-profiles/import-commit`

Persists the patches an admin reviewed in the preview. Handler [`import-commit/route.ts:19-67`](../../../src/app/api/tutor-profiles/import-commit/route.ts).

**Auth:** session required ([`:20-23`](../../../src/app/api/tutor-profiles/import-commit/route.ts)).

**Body:** `importCommitSchema` ([`import-commit/route.ts:12-17`](../../../src/app/api/tutor-profiles/import-commit/route.ts)) — `.strict()` at both levels:

```
{ rows: [ { canonicalKey: string, patch: <tutorBusinessProfilePatchSchema> } ] }
```

| Field | Type | Required | Constraint |
|-------|------|----------|------------|
| `rows` | array | **yes** | 1–200 entries ([`:16`](../../../src/app/api/tutor-profiles/import-commit/route.ts)) — an empty array is a 400, and a preview of more than 200 matched rows must be split by the caller. The workspace sends every matched row in one request without chunking ([`tutor-profiles-workspace.tsx:306-310`](../../../src/components/tutor-profiles/tutor-profiles-workspace.tsx)). |
| `rows[].canonicalKey` | string | **yes** | Trimmed, min length 1. |
| `rows[].patch` | object | **yes** | The same [profile patch schema](#the-profile-patch-schema) as `PATCH` — so a preview-produced `lastReviewedAt` that is not a full ISO datetime fails here, for the whole request. |

The endpoint does **not** re-derive anything: it trusts the patches in the body. A client may post patches that never came from a preview.

**Side effects,** in handler order ([`:41-62`](../../../src/app/api/tutor-profiles/import-commit/route.ts)):

1. Load the active-snapshot roster once and index it by `canonicalKey` ([`:42-43`](../../../src/app/api/tutor-profiles/import-commit/route.ts)).
2. For each row, **skip** any key absent from that roster, recording `{ canonicalKey, reason: "Tutor not found in active snapshot" }` — a skip is not an error and does not stop the loop ([`:48-52`](../../../src/app/api/tutor-profiles/import-commit/route.ts)). This is the same existence rule `PATCH` enforces with a 404, expressed per row.
3. Otherwise `await upsertTutorBusinessProfile(db, canonicalKey, activeProfile.displayName, patch)` — **sequentially**, one round-trip per row, up to 200 ([`:53-58`](../../../src/app/api/tutor-profiles/import-commit/route.ts)).
4. `clearSearchIndex()` **only when at least one row saved** ([`:61`](../../../src/app/api/tutor-profiles/import-commit/route.ts)) — an all-skipped commit leaves the index alone.

**There is no transaction.** The loop is a sequence of independent upserts, so a failure partway through leaves the earlier rows committed and returns 500 with no report of which ones landed. A retry is safe in the sense that each upsert is idempotent for the same patch, but the import's text merges were computed in the *preview* against the then-current row, so re-previewing before retrying is the sound recovery. Nothing is written to Wise.

**Response `200`:** `{ savedCount, skipped, profiles }` ([`:62`](../../../src/app/api/tutor-profiles/import-commit/route.ts)) — `savedCount` is `profiles.length`, `skipped` is the array of `{canonicalKey, reason}` objects, and `profiles` holds the written `TutorBusinessProfile` rows in request order.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Commit finished — including the all-skipped case (`savedCount: 0`). |
| 400 | Unparseable JSON → `{"error":"Invalid JSON"}` ([`:28-30`](../../../src/app/api/tutor-profiles/import-commit/route.ts)); or Zod failure → `{"error":"Invalid request","details": …}` ([`:32-38`](../../../src/app/api/tutor-profiles/import-commit/route.ts)) — empty `rows`, more than 200 rows, an unknown key at either level, or any per-patch limit breach. |
| 401 | No session. |
| 500 | Any throw during the roster read or an upsert; body `{"error": <message>}`, defaulting to `"Failed to commit tutor profile import"` ([`:64`](../../../src/app/api/tutor-profiles/import-commit/route.ts)). Partial writes may already be committed. |

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
