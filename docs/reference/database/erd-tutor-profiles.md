# Database Reference — Tutor Profiles

> **Status:** stable

Scope: the two standalone tables that hold human-curated tutor metadata — contact details (`tutorContacts`) and the parent-facing / internal business profile (`tutorBusinessProfiles`). Both are keyed off a `canonicalKey` string rather than a foreign key, and neither is snapshot-scoped, so they survive snapshot rotation. This editorial context is what Wise does not store and is read by the AI scheduler. Feature purpose, rules, and flows live in [docs/features/tutor-profiles.md](../../features/tutor-profiles.md).

For the full column-by-column reference (types, defaults, indexes), see [docs/reference/database/index.md](./index.md). This page covers grain, key columns, and relationships only.

Both tables are defined in [`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts):

| Drizzle export | SQL table | Grain | schema.ts |
|---|---|---|---|
| `tutorContacts` | `tutor_contacts` | one row per tutor identity (`canonicalKey`) | lines 1197–1213 |
| `tutorBusinessProfiles` | `tutor_business_profiles` | one row per tutor identity (`canonicalKey`) | lines 1214–1249 |

## ER Diagram

Both tables are independent of the snapshot-versioned core data model. They have no SQL foreign keys to `snapshots`, `tutors`, or `tutor_identity_groups`; the only linkage is the `canonicalKey` text value (and the `displayName` / `sourceNames` strings), which is correlated by application logic, not enforced at the database level. The core tables are shown as a single stub node to make that soft, non-FK relationship explicit.

```mermaid
erDiagram
    tutorContacts {
        uuid id PK
        text canonical_key UK "unique index"
        text display_name
        boolean active
    }

    tutorBusinessProfiles {
        text canonical_key PK
        text display_name
        text english_proficiency
        text young_learner_fit
        boolean active
    }

    CORE_TUTOR_DATA {
        uuid snapshot_id "snapshots / tutors / tutor_identity_groups"
    }

    tutorContacts |o..o| CORE_TUTOR_DATA : "canonical_key / name (soft, no FK)"
    tutorBusinessProfiles |o..o| CORE_TUTOR_DATA : "canonical_key / name (soft, no FK)"
    tutorContacts |o..o| tutorBusinessProfiles : "shared canonical_key (no FK)"
```

## Tables

### `tutorContacts` — `tutor_contacts`

Source: `src/lib/db/schema.ts` lines 1197–1213.

Grain: one row per logical tutor contact record, identified by `canonicalKey`. Uniqueness is enforced by `tutor_contacts_canonical_key_idx`, a `uniqueIndex` on `canonicalKey` (schema.ts line 1210), so there is at most one contact row per canonical key.

Key columns:
- `id` — `uuid` primary key, `defaultRandom()` (line 1198). Surrogate PK; the natural key is `canonicalKey`.
- `canonicalKey` — `text`, `notNull`, carries the unique index (lines 1199, 1210). The application-level join key.
- `displayName` — `text`, `notNull` (line 1200).
- `onsiteEmail` / `onlineEmail` / `onsitePhone` / `onlinePhone` — nullable `text` (lines 1201–1204). Contact details are split by modality (onsite vs. online variant), mirroring the online/offline-pair identity model.
- `sourceNames` — `jsonb` typed `string[]`, `notNull`, defaults to `[]` (line 1205). Records the underlying name strings this contact was assembled from.
- `active` — `boolean`, `notNull`, defaults `true` (line 1206); indexed by `tutor_contacts_active_idx` (line 1211) for filtering live records.
- `createdAt` / `updatedAt` — timezone-aware `timestamp`, `notNull`, `defaultNow()` (lines 1207–1208).

Relationships: none enforced in SQL. The row is correlated to the snapshot-based core tutor data (`tutors`, `tutor_identity_groups`, and their `snapshots`) and to `tutorBusinessProfiles` only through the shared `canonicalKey` value (and `displayName` / `sourceNames` strings), resolved by application code rather than a database foreign key.

### `tutorBusinessProfiles` — `tutor_business_profiles`

Source: `src/lib/db/schema.ts` lines 1214–1249.

Grain: one row per tutor business profile, keyed directly on `canonicalKey` as the primary key (line 1215). Because `canonicalKey` is the PK, there is exactly one business profile per canonical key. This is the table the AI scheduler reads to enrich tutor recommendations.

Key columns:
- `canonicalKey` — `text` primary key (line 1215). No separate surrogate id; the natural key is the PK.
- `displayName` — `text`, `notNull` (line 1216); indexed by `tutor_business_profiles_display_name_idx` (line 1246).
- `parentSafeSummary` / `internalNotes` — `text`, `notNull`, default `""` (lines 1217–1218). Split between parent-facing copy and internal-only notes.
- `education` — `jsonb` array of `{ institution, country?, program?, notes? }`, `notNull`, default `[]` (lines 1219–1224).
- `languages` — `jsonb` array of `{ language, proficiency, verificationSource? }`, `notNull`, default `[]` (lines 1225–1229).
- Young-learner fit fields: `englishProficiency`, `youngLearnerFit` (both `text`, `notNull`, default `"unknown"`, lines 1230–1231), `youngestComfortableAge` (nullable `integer`, line 1232), `youngLearnerNotes` (`text`, `notNull`, default `""`, line 1233). The `"unknown"` defaults are fail-closed — never an affirmative capability without evidence.
- Tag/array columns (`jsonb` typed `string[]`, `notNull`, default `[]`): `teachingStyleTags` (line 1234), `strengthTags` (line 1236), `curriculumExperience` (line 1237).
- Free-text notes (`text`, `notNull`, default `""`): `teachingStyleNotes` (line 1235), `studentFitNotes` (line 1238), `doNotUseForNotes` (line 1239).
- Review/audit fields: `verifiedBy` (nullable `text`, line 1240), `lastReviewedAt` (nullable timezone-aware `timestamp`, line 1241).
- `active` — `boolean`, `notNull`, default `true` (line 1242); indexed by `tutor_business_profiles_active_idx` (line 1247).
- `createdAt` / `updatedAt` — timezone-aware `timestamp`, `notNull`, `defaultNow()` (lines 1243–1244).

Relationships: none enforced in SQL. Correlated to the core snapshot-based tutor data and to `tutorContacts` solely via the shared `canonicalKey` (and `displayName`), resolved in application code, not by a database foreign key.

_Verified against HEAD `d4fe6d3` on 2026-06-05._
