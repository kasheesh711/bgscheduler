# Phase 6: MOD-01 Reliable Modality Detection - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Upgrade session-level modality resolution so every session card displays a trustworthy online/onsite/unknown label with confidence grading. Primary signals are `isOnlineVariant` (teacher record) + `sessionType` (Wise session record). The silent `supportedModes[0]` fallback in `src/lib/search/compare.ts:27-70` is eliminated. Display via icon + popover only — never border/color. Add fail-closed test matrix in `compare.test.ts`. Introduce the `CACHE_VERSION` client-cache constant for v1.1 shape changes.

**In scope:** MOD-01..05 (5 requirements) — resolver refactor, confidence grading, UI icon/popover, test matrix, /data-health surfacing, CACHE_VERSION constant.

**Out of scope:** Modality filter dropdown in search (MOD-06, v1.2 deferred). Admin override UI (v1.2+). Group-level `deriveModality` in `src/lib/normalization/modality.ts` — already fail-closes correctly at group level; MOD-01 is session-level work. Dashed-vs-solid border restoration (research Pitfall 3 — explicitly forbidden).

</domain>

<decisions>
## Implementation Decisions

### Confidence rubric

- **D-01:** Session modality resolver returns `{ modality: "online"|"onsite"|"unknown", confidence: "high"|"medium"|"low" }` (or an equivalent shape the planner picks — the signal must be on `CompareSessionBlock`, not a side channel).
- **D-02:** **High** = group has a single teacher record (only one modality possible) OR paired group where `sessionType` agrees with the session's `teacherRecord.isOnlineVariant`. No sessionType is OK for a single-record group (zero ambiguity).
- **D-03:** **Medium** is reserved for future use (e.g., future signals). No tier is emitted as `medium` by the initial MOD-01 implementation — but the type union must include it so later phases can promote from low without a shape change.
- **D-04:** **Low** = paired group where `sessionType` is missing. The inferred modality (from `teacherRecord.isOnlineVariant`) is preserved in data, but the UI renders the card identical to `unknown` (see D-13). Low exists so `/data-health` and future filter UIs can distinguish "inferred without corroboration" from "truly unresolved."
- **D-05:** **Unknown** = paired group with contradicting signals (D-07/D-08) OR resolver cannot determine (should not happen in practice if D-01..04 are implemented correctly; fail-closed default).
- **D-06:** `sessionType` synonym normalization **matches the existing cascade** in `src/lib/search/compare.ts:4-5`: `{online, virtual} → online` and `{onsite, in-person, offline} → onsite`. Preserve the existing `ONLINE_SESSION_TYPES` and `ONSITE_SESSION_TYPES` constants — tests already anchor on them.

### Contradiction policy (fail-closed enforcement)

- **D-07:** **Paired group + contradicting signals** (e.g., `isOnlineVariant=true` but `sessionType='onsite'`): output `modality: "unknown"`, confidence: `"low"` or omitted per planner's typing choice. Emit a `conflict_model` data_issue (enum already exists at `src/lib/db/schema.ts:23-29`) tagged with the session's `wiseSessionId` and a message naming both disagreeing signals.
- **D-08:** **Single-record group + contradicting sessionType** (rare upstream error, e.g., group is online-only but `sessionType='onsite'`): same treatment as D-07 — `"unknown"` + `conflict_model` data_issue. Consistency over pragmatism; fail-closed wins.
- **D-09:** Emit data_issues on the `data_issues` table via the existing sync-write path; they flow into `/data-health` automatically via `src/app/api/data-health/route.ts:65`. No new issue type is needed — `conflict_model` covers this case.

### /data-health dashboard

- **D-10:** **Extend the existing modality counter** (`src/app/api/data-health/route.ts:65` filters `type === "modality"`). The counter should include both the legacy `type: "modality"` issues (group-level unresolved from `deriveModality`) and the new session-level `conflict_model` issues emitted in D-07/D-08. Surface as a single "Modality issues" number — one line that tells the admin whether modality data quality is degrading.
- **D-11:** Post-deploy the counter is **expected to rise** (surface-of-reality, per ROADMAP success criterion #5). Document this in `05-VERIFICATION.md` note template so the QA sign-off doesn't flag the rise as a regression.

### Icon set, placement & low-confidence UX (MOD-04)

- **D-12:** Icons from `lucide-react` 1.7.0 (already installed):
  - **Online** → `Video`
  - **Onsite** → `MapPin`
  - **Unknown** → `HelpCircle`
- **D-13:** **Placement:** top-right corner of each session card, sized `w-3 h-3` (matches existing conflict-badge visual weight). Clicking or hovering the icon opens the existing session popover. Affects cards rendered in `src/components/compare/calendar-grid.tsx` AND `src/components/compare/week-overview.tsx` — both call sites must be updated. The icon is additive to the card; no change to border/color/fill.
- **D-14:** **Low-confidence rendering** (paired group + missing sessionType): **render identical to unknown** — use `HelpCircle` icon, not the inferred `Video`/`MapPin`. The data-layer still carries the inferred modality for `/data-health` and future filter phases, but the UI honors research Pitfall 3 by making no visual claim the data can't back up. Popover reveals `Likely online — unconfirmed` (or mirror for onsite) so admins who care can still see the inference.
- **D-15:** **Popover wording** — terse one-word labels:
  - `high` + modality `online` → "Online"
  - `high` + modality `onsite` → "Onsite"
  - `low` (inferred) → "Likely online — unconfirmed" / "Likely onsite — unconfirmed"
  - `unknown` → "Unknown"
- **D-16:** **No confidence phrasing on `high` labels** — admins don't need "Online (verified)". Confidence lives in data + `/data-health`, not in the user-facing label strings for resolved cases.

### CACHE_VERSION constant (Pitfall 14 closure)

- **D-17:** Constant lives at **`src/lib/search/cache-version.ts`** as a single-line module: `export const CACHE_VERSION = "v1";`. Clean import surface; greppable; matches project's "one-concern module" convention.
- **D-18:** **Namespace:** `src/hooks/use-compare.ts` client-side `tutorCache` Map keys only. Change `${tutorGroupId}:${week}` → `${tutorGroupId}:${week}:${CACHE_VERSION}` in all three call sites (`tutorCache.current.set`, `tutorCache.current.get`, `tutorCache.current.delete`). Recent-searches localStorage is NOT versioned in this phase — it stores search filters, not modality-shaped data; bumping it would be speculative.
- **D-19:** **Starting value `"v1"`**. File comment documents the bump rule: "Bump this string whenever the shape of `CompareTutor` / `CompareSessionBlock` / any client-cached server shape changes. Future v1.1 phases (PAST-01, VPOL-03) MUST bump this alongside their shape change. The bump invalidates long-lived client tabs without a hard reload."
- **D-20:** Do NOT build elaborate invalidation machinery in this phase — the constant + comment + grep discipline is the mechanism. Enforcement is code-review practice, not a runtime check.

### Test matrix (MOD-05)

- **D-21:** Test matrix lives in **`src/lib/search/__tests__/compare.test.ts`** extending the existing `describe("buildCompareTutor", ...)` block (the modality cases at lines 70-96 are the starting point). Cover every combination of `{teacherRecord.isOnlineVariant: true/false, sessionType: online/onsite/missing/virtual/in-person, group shape: single-online / single-onsite / paired}`. For each case, assert both `modality` and `confidence` values.
- **D-22:** Contradiction-case tests (D-07, D-08) MUST assert `modality === "unknown"` AND that a `conflict_model` data_issue is emitted for the session. This locks in the fail-closed contract research Pitfall 1 warned about.

### Claude's Discretion

The following are explicitly left to the planner / executor — no user decision needed:

- **Planner's typing choice** for the confidence signal. Options include extending `CompareSessionBlock.modality` into an object, adding a sibling `modalityConfidence` field, or using a discriminated union. Planner picks based on the rest of the types module (`src/lib/search/types.ts`) and what minimizes UI churn.
- **Resolver structure.** Whether `resolveSessionModality` stays a single function or is split into `classifyGroupShape` + `scoreSignals` + `emit` is up to the planner. The behavioral contract (D-01..09) is what matters.
- **Exact popover markup.** How the icon is wrapped in a `PopoverTrigger` inside the existing `TutorProfilePopover` / session popover infrastructure. Planner decides whether to add a new `<SessionModalityPopover>` or extend the existing session popover.
- **`deriveModality` (group-level) review.** Planner should confirm the group-level resolver in `src/lib/normalization/modality.ts` still makes sense alongside the session-level changes; if no adjustment is needed, that's fine (it already fail-closes correctly).
- **MOD-01 kickoff validation.** Research advisory flag: validate `WiseSession.type` presence rate in production data at phase kickoff — if <50%, the planner can scope MOD-01 down to "icon + Needs Review without confident labels." The planner should run a quick DB query on `future_session_blocks.sessionType` NULL rate as plan step 1 before committing to the full scope.
- **Test matrix size.** Combinatorial enumeration could produce dozens of cases; planner picks a representative subset that covers every branch in the resolver. Minimum bar: every `modality` output × every `confidence` tier × every contradiction branch.
- **Commit cadence.** Resolver + confidence + data_issue emission + UI + CACHE_VERSION + tests. Planner decides commit split; atomic per-concern is fine.

### Folded Todos

No GSD todos surfaced for Phase 6 (todo match returned 0). STATE.md pending items don't overlap MOD-01.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/REQUIREMENTS.md` §Modality — MOD-01..05 specifications with exact phrasing on each requirement
- `.planning/REQUIREMENTS.md` §Traceability — MOD-01..05 all mapped to Phase 6
- `.planning/ROADMAP.md` §"Phase 6: MOD-01 Reliable Modality Detection" — 5 success-criteria truths that must become true, including `/data-health` surfacing

### Project constraints
- `.planning/PROJECT.md` §Constraints — no stack changes, fail-closed non-negotiable, 669 tests must continue passing
- `.planning/PROJECT.md` §Key Decisions (row "Online/onsite detection heuristic") — context on why v1.0 removed dashed-vs-solid border visual distinction
- `AGENTS.md` §"Non-Negotiable Product Rules" (line 146-149) — "Unresolved identity, modality, or qualification → Needs review, never Available" — THE fail-closed anchor for MOD-01
- `CLAUDE.md` §"Known Issues (open)" — current online/onsite heuristic limitations; MOD-01 closes this

### Research intelligence
- `.planning/research/PITFALLS.md#pitfall-1` — MOD-01 silently bypassing fail-closed; test matrix requirement
- `.planning/research/PITFALLS.md#pitfall-2` — `isOnlineVariant` interpretation for paired groups; confidence-grading rationale
- `.planning/research/PITFALLS.md#pitfall-3` — Visual regression prevention (NO dashed vs solid border restoration)
- `.planning/research/PITFALLS.md#pitfall-14` — CACHE_VERSION discipline; lands in Phase 6 as first v1.1 shape-changing phase
- `.planning/research/SUMMARY.md` lines 56, 70, 88-90, 136, 159, 169 — MOD-01 phase-specific guidance + advisory flag on `WiseSession.type` presence validation

### Prior phase context
- `.planning/phases/05-polish-drain/05-CONTEXT.md` §Decisions — semantic OKLCH token pattern (D-06..08) applies if new modality tokens are introduced; deferred ideas §CACHE_VERSION confirms it lands in Phase 6

### Source code — resolver & data model
- `src/lib/search/compare.ts:27-70` — `resolveSessionModality` — THE refactor target. Entry point for session-level modality resolution. Contains the silent `supportedModes[0]` fallback at line 65-68 that MOD-02 eliminates.
- `src/lib/search/compare.ts:4-5` — `ONLINE_SESSION_TYPES` / `ONSITE_SESSION_TYPES` — preserve these constants (D-06)
- `src/lib/search/types.ts:113-128` — `CompareSessionBlock` interface — add/adjust modality + confidence fields here
- `src/lib/search/types.ts:36` — `TutorResult.supportedModes` — leave alone; legacy path
- `src/lib/search/index.ts:207-211` — `wiseRecords[*].isOnline` mapping from DB `isOnlineVariant` column — confirm the field reaches `resolveSessionModality` unchanged
- `src/lib/normalization/modality.ts` — group-level `deriveModality`; reference only, NOT the refactor target
- `src/lib/db/schema.ts:23-29` — `dataIssueTypeEnum` including `conflict_model` (D-07)
- `src/lib/db/schema.ts:96` — `tutorIdentityGroupMembers.isOnlineVariant` column — data source
- `src/lib/db/schema.ts:191` — `futureSessionBlocks.sessionType` column — data source
- `src/lib/sync/orchestrator.ts:285` — sessionType write-through during sync
- `src/lib/sync/orchestrator.ts:315` — existing modality write-through to group table (reference for contradiction data_issue emission timing)

### Source code — UI call sites
- `src/components/compare/calendar-grid.tsx` — session cards rendered in day drill-down + 3-tutor lanes; icon placement site
- `src/components/compare/week-overview.tsx` — session cards rendered in full-week view; icon placement site
- `src/components/compare/session-colors.ts` — shared color utilities; do NOT add border/color branching for modality (research Pitfall 3)
- `src/components/compare/tutor-profile-popover.tsx` — existing popover pattern; reference for session popover shape
- `src/app/api/data-health/route.ts:65` — modality issue counter (D-10 extension target)

### Source code — test surfaces
- `src/lib/search/__tests__/compare.test.ts:70-96` — existing modality cases (anchor point for D-21 matrix extension)
- `src/lib/normalization/__tests__/modality.test.ts` — group-level tests (reference; don't modify unless group-level changes)

### Source code — cache
- `src/hooks/use-compare.ts:84` — `tutorCache` Map declaration
- `src/hooks/use-compare.ts:139, 144, 169` — `tutorCache.current.set/get/delete` call sites (all three need CACHE_VERSION suffix per D-18)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`resolveSessionModality` at `src/lib/search/compare.ts:27-70`** — existing five-step cascade; MOD-01 tightens steps 1-3 and deletes steps 4-5 (location regex + `supportedModes[0]` fallback).
- **`dataIssueTypeEnum`** at `src/lib/db/schema.ts:23-29` includes `conflict_model` — no new enum value needed for D-07/D-08 data_issue emission.
- **`lucide-react` 1.7.0** already a dependency (`Video`, `MapPin`, `HelpCircle` all available).
- **Popover component** at `src/components/ui/popover.tsx` (Base UI) already wraps session cards in `tutor-profile-popover.tsx`. MOD-04 can extend this or add a sibling popover trigger.
- **`ONLINE_SESSION_TYPES` / `ONSITE_SESSION_TYPES` sets** in `compare.ts:4-5` — preserve and reuse; existing tests anchor on these values.
- **Semantic OKLCH token pattern** from Phase 5 D-06..08 (`--today-indicator` in `globals.css`) — available if MOD-04 needs new modality-color tokens (though research Pitfall 3 says don't use color for modality; icons only).

### Established Patterns
- **Fail-closed data_issue emission** — existing `src/lib/normalization/modality.ts:71-91` emits `{ type: "modality", entityType, entityId, entityName, message }`. New session-level `conflict_model` issues follow this shape.
- **Icon chips on session cards** — conflict count badge (numeric) already renders in a card corner. New modality icon chip follows this placement.
- **Client cache Map-of-composite-key** — `tutorCache` uses `${tutorGroupId}:${week}` today. CACHE_VERSION is a clean extension of this pattern.
- **Test file structure** — `src/lib/search/__tests__/compare.test.ts` uses `makeTutor({ overrides })` factory; matrix extension composes naturally.

### Integration Points
- **Sync pipeline (`src/lib/sync/orchestrator.ts`)** — session-level `conflict_model` issues emitted here during per-session iteration. Today, only group-level modality issues emit from `deriveModality`. MOD-01 adds session-iteration-time emission.
- **`/data-health` counter (`src/app/api/data-health/route.ts:65`)** — pure filter on `type === "modality"`. Widening to include `type === "conflict_model"` is a one-line change.
- **In-memory SearchIndex (`src/lib/search/index.ts`)** — no structural change. `resolveSessionModality` is called inside `buildCompareTutor` (compare.ts:122); the index only holds `wiseRecords[*].isOnline` and session rows. Confidence is derived at compare-build time, not index-build time. Cold-start budget unaffected.
- **Client cache (`src/hooks/use-compare.ts`)** — CACHE_VERSION suffix on Map keys; three call sites.

</code_context>

<specifics>
## Specific Ideas

- **"Research Pitfall 3 is a hard rule"** — icons only, never border/color. The v1.0 removal of dashed-vs-solid borders is permanent; MOD-01 does not re-enable it, even in Phase 6 where detection becomes reliable. User explicitly preserves this constraint.
- **"Terse popover labels"** — one-word states ("Online" / "Onsite" / "Unknown") match the compare-panel voice. Only `low` confidence gets the "Likely … — unconfirmed" phrasing.
- **"Confidence lives in data, not in user-facing `high` labels"** — admins don't need to think about confidence tiers when signals are strong. `high` is invisible; `low` renders like unknown; contradiction gets a data_issue. Simple surface, rigorous internals.
- **"MOD-01 is the first shape-changing phase"** — bumping CACHE_VERSION here establishes the discipline for PAST-01 (Phase 7) and VPOL-03 (Phase 9). The bump rule comment at `src/lib/search/cache-version.ts` IS the docs.
- **"Fail-closed counter rise is expected"** — /data-health modality count goes UP post-deploy. Document this in the verification artifact so QA doesn't flag it as regression.

</specifics>

<deferred>
## Deferred Ideas

- **MOD-06 (modality filter dropdown in search)** — v1.2 territory. MOD-01 lays the data-layer groundwork (confidence field, reliable resolution) that MOD-06 consumes, but no filter UI in Phase 6.
- **MOD-07 (modality summary in tutor profile popover)** — v1.2 territory. Distinct from the session-card popover; separate UX problem.
- **Admin override UI for modality** — v1.2+ (explicit out-of-scope per REQUIREMENTS.md §Out of Scope). Admins cannot edit resolved modality in Phase 6.
- **Dashed-vs-solid border for online/onsite** — explicitly rejected (research Pitfall 3, PROJECT Key Decisions). Do not attempt.
- **New data_issue enum types** — `conflict_model` already covers the contradiction case; no schema change needed.
- **Invalidation machinery beyond CACHE_VERSION string bump** — runtime check / version-skew detector / long-tab warning banner are all out of scope. The constant + grep discipline is the mechanism.
- **Group-level `deriveModality` refactor** — out of scope; already fail-closes at group level. MOD-01 is session-level.
- **`WiseSession.type` presence validation as a phase blocker** — research advisory only; planner runs this query at phase kickoff, and if presence is <50% they scope down. Not a separate phase.
- **Medium-tier emission** — MOD-01 implementation never emits `medium`. The union includes it for future phases (e.g., if a future signal provides corroboration that upgrades a `low` case to `medium`).

### Reviewed Todos (not folded)

None — todo match returned 0 results for Phase 6.

</deferred>

---

*Phase: 06-mod-01-reliable-modality-detection*
*Context gathered: 2026-04-21*
