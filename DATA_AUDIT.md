# DATA_AUDIT.md

## Purpose
This document tracks Wise readiness issues that must be resolved, mapped, or explicitly accepted before implementation begins and before launch can be approved.

This is a Wise blocker register, not a historical spreadsheet defect log.

[WISE_COMPARISON.md](/Users/kevinhsieh/Desktop/Scheduling/WISE_COMPARISON.md) is the supporting migration decision record that explains why Wise is now the only production source of truth.

## Current Assessment Summary
- Production source under evaluation: Wise tenant `begifted-education`
- Target institute: `696e1f4d90102225641cc413`
- Timezone policy: normalize all production scheduling data to `Asia/Bangkok`
- Production model: Wise-only with normalized persisted snapshots and no sheet fallback
- Known blocker categories:
  - identity normalization gaps
  - paired online/offline Wise identity gaps
  - unresolved modality derivation rules
  - qualification tag normalization gaps
  - API and sync guardrails
  - conflict-model guardrails
  - data completeness gaps against business expectations

## Severity Definitions
- `Critical`: can create false availability results or invalidate core search trust
- `High`: can materially hide, split, or misclassify tutors and must be resolved before launch
- `Medium`: does not block initial implementation alone, but needs explicit policy, monitoring, or fallback handling within Wise-only architecture

## Blocker Register

### AUD-001
- Severity: Critical
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers`
- Exact observed behavior: tutor identity is not one-to-one at the business level; the Wise roster commonly represents the same logical tutor as multiple records such as offline and online variants.
- Impact on availability accuracy: the same tutor can be split across separate identities, causing false exclusions, duplicate results, or incorrect modality handling.
- Required resolution path: define and maintain an explicit identity-group normalization layer that can represent separate Wise records under one logical tutor when approved by the business.
- Resolution location: identity normalization config
- Owner: TBD
- Status: Open

Representative paired identities:

- `Usanee (Aey) Tortermpun`
- `Usanee (Aey) Tortermpun Online`
- `Ratthapon (Da) Punpo`
- `Ratthapon (Da) Punpo Online`
- `Wacharaphol (Gift) Daungsuwan`
- `Wacharaphol (Gift) Daungsuwan Online`
- `Khanittha (Grace) Hongkeaw`
- `Khanittha (Grace) Hongkeaw Online`

### AUD-002
- Severity: Critical
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers`
- Exact observed behavior: nickname extraction helps but is not sufficient to resolve all tutors cleanly across business naming conventions and historical sheet references.
- Impact on availability accuracy: unresolved aliases can cause missing qualifications, lost conflicts, or tutors being omitted from positive results.
- Required resolution path: maintain an explicit alias mapping table after exact-record and nickname-key matching.
- Resolution location: alias mapping config
- Owner: TBD
- Status: Open

Known direct alias mismatches:

| Observed key | Intended mapping |
| --- | --- |
| Kev | Kevin |
| Paoju | Paojuu |
| Poi | Nacha (Poi) |
| Sam | Samantha |

Known unresolved or incomplete keys needing business confirmation:

- `Muk`
- `Pat`
- `Pearcha`
- `Prae-Tarn`

### AUD-003
- Severity: High
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers`
- Exact observed behavior: some tutors exist in Wise but not in former sheet fixtures, and some historically expected tutor keys do not appear cleanly in current Wise nickname extraction.
- Impact on availability accuracy: the business may expect tutors to be searchable under historical names that do not cleanly exist in Wise without explicit normalization or confirmation.
- Required resolution path: confirm whether each gap is a legitimate active tutor, a renamed tutor, a retired tutor, or a business-only alias that needs to be preserved.
- Resolution location: business mapping and identity normalization config
- Owner: TBD
- Status: Open

Wise-only keys observed during comparison:

- `A`
- `Aya`
- `Care`
- `Earng`
- `Fluke-Supha`
- `Palm`
- `Petchy`
- `Phutta`

Historically expected keys not cleanly found in Wise nickname extraction:

- `Kevin`
- `Samantha`
- `Nacha (Poi)`
- `Paojuu`

### AUD-004
- Severity: Critical
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers`, `GET /institutes/{center_id}/sessions?status=FUTURE`, availability payload location fields
- Exact observed behavior: Wise does not currently expose one obvious first-class modality field in the sampled availability payload; online/onsite semantics appear to depend on a combination of paired identities, session type, and location.
- Impact on availability accuracy: incorrect modality derivation can create false matches for `online`, `onsite`, or `either`.
- Required resolution path: document a deterministic modality derivation policy and explicitly mark unresolved cases as review-only.
- Resolution location: modality normalization rules
- Owner: TBD
- Status: Open

Open modality questions to resolve before launch:

- when to treat paired Wise records as separate searchable resources
- whether session `type` alone is sufficient
- whether `location` must participate in modality normalization
- whether some tutors can support both modes under one logical identity

### AUD-005
- Severity: High
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers`
- Exact observed behavior: Wise `tags` are rich and likely sufficient for qualification filters, but raw tags do not yet exist in the app’s canonical `subject`, `curriculum`, `level` model.
- Impact on availability accuracy: filters may produce incorrect inclusions or exclusions until tags are normalized.
- Required resolution path: define a controlled normalization map from raw Wise tags into canonical qualification dimensions.
- Resolution location: qualification normalization config
- Owner: TBD
- Status: Open

Normalization risks already observed:

- tags that collapse multiple sheet-era semantics into one label
- tags that include Wise-specific concepts such as tiering
- tags whose naming mixes subject and curriculum semantics
- tags whose naming may imply modality through identity rather than through the tag itself

### AUD-006
- Severity: Critical
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers/{teacher_id}/availability`
- Exact observed behavior: the Wise availability endpoint only supports time windows up to one week.
- Impact on availability accuracy: a naive sync can miss coverage or build incomplete recurring models if it assumes arbitrary date ranges are allowed.
- Required resolution path: define and test a deterministic one-week stitching strategy for availability ingestion.
- Resolution location: sync architecture
- Owner: TBD
- Status: Open

### AUD-007
- Severity: High
- Affected Wise source/endpoint: all scheduling endpoints returning datetimes
- Exact observed behavior: Wise returns scheduling timestamps in UTC, while business operations and current interpretation are in `Asia/Bangkok`.
- Impact on availability accuracy: incorrect timezone handling can create false session collisions or false free slots.
- Required resolution path: lock timezone normalization to `Asia/Bangkok` throughout ingestion, persistence, indexing, and testing.
- Resolution location: sync and normalization rules
- Owner: TBD
- Status: Open

### AUD-008
- Severity: High
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers`, `GET /institutes/{center_id}/sessions?status=FUTURE`
- Exact observed behavior: full production coverage depends on correct pagination and complete enumeration of tutors and future sessions.
- Impact on availability accuracy: missing pages would silently omit tutors or conflicts from the search index.
- Required resolution path: specify required pagination behavior, completeness checks, and sync failure thresholds before implementation.
- Resolution location: sync architecture
- Owner: TBD
- Status: Open

### AUD-009
- Severity: High
- Affected Wise source/endpoint: scheduled Wise sync process
- Exact observed behavior: the product depends on serving the last successful Wise snapshot when a new sync fails, but this stale-data behavior is not yet operationally defined.
- Impact on availability accuracy: without explicit stale-snapshot rules, the app may fail open, fail closed unnecessarily, or serve inconsistent data after sync issues.
- Required resolution path: define stale snapshot age policy, stale-data UI signaling, and sync failure handling before implementation.
- Resolution location: sync architecture and product policy
- Owner: TBD
- Status: Open

### AUD-010
- Severity: Medium
- Affected Wise source/endpoint: all Wise API calls
- Exact observed behavior: rate-limit, timeout, and retry behavior have not yet been characterized for production-scale syncs.
- Impact on availability accuracy: sync reliability may degrade under load or transient API failures if failure handling is underspecified.
- Required resolution path: characterize Wise API operational limits during implementation planning and add retry/backoff plus explicit failure thresholds.
- Resolution location: sync architecture
- Owner: TBD
- Status: Open

### AUD-011
- Severity: High
- Affected Wise source/endpoint: `POST /institutes/{center_id}/checkSessionsAvailability`
- Exact observed behavior: sampled conflict checks strongly matched session-collision cases, but working-hours conflict behavior was not fully consistent enough to treat this endpoint as the sole availability oracle.
- Impact on availability accuracy: over-trusting this endpoint could produce inconsistent or opaque blocking behavior.
- Required resolution path: lock the primary conflict model to normalized `workingHours`, `leaves`, and future sessions; use `checkSessionsAvailability` only as a secondary validation layer unless further validation changes that conclusion.
- Resolution location: conflict-model rules
- Owner: TBD
- Status: Open

### AUD-012
- Severity: High
- Affected Wise source/endpoint: `GET /institutes/{center_id}/teachers/{teacher_id}/availability`, `GET /institutes/{center_id}/sessions?status=FUTURE`
- Exact observed behavior: leaves, weekly availability, and future sessions all participate in the final availability answer, but the exact precedence and overlap model must be locked before implementation.
- Impact on availability accuracy: unresolved precedence can lead to contradictory search results in edge cases.
- Required resolution path: explicitly document precedence in implementation docs and tests:
  - availability window must cover slot
  - leave overlap blocks
  - future session overlap blocks
  - unresolved modality or identity blocks positive match
- Resolution location: engineering spec and tests
- Owner: TBD
- Status: Open

## Pre-Build Resolution Checklist
Before implementation begins, each open blocker must be assigned one of these outcomes:

- resolved through normalization rules
- resolved through alias or identity-group mapping
- resolved through sync architecture and monitoring
- formally accepted with explicit review-only handling

The minimum pre-build requirement is that no blocker remains undefined in terms of handling path.

## Pre-Launch Requirement
Before production launch:

- all `Critical` issues must be fixed or explicitly handled in a documented fail-closed way
- all `High` issues must have approved mappings, architecture, or normalization rules
- any remaining `Medium` issues must have explicit monitoring and review behavior

## Notes
- This audit replaces the sheet-era blocker register because Wise is now the only production source of truth.
- Historical `.xlsx` files remain useful only as migration reference artifacts.
- If Wise tenant behavior or data shape changes materially, this audit must be updated before the project moves forward.
