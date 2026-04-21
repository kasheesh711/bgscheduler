# Phase 5: POLISH Drain - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Clear the v1.0 polish & tech-debt backlog (POLISH-01..16) so v1.1 features ship on a verified-clean baseline, and establish the a11y attestation required by downstream VPOL-03 (Phase 9).

**In scope:** 16 explicitly enumerated requirements from REQUIREMENTS.md covering (a) Phase 04 human-QA sign-off, (b) Phase 03 M1–M3 + L1–L4 code findings, (c) retroactive Phase 02 VERIFICATION.md, (d) `TutorSelector` dead-code removal, (e) v1.0.1 production UAT, (f) `recommend.test.ts` authoring.

**Out of scope:** any shape-changing work (deferred to Phase 6+), CACHE_VERSION constant (lands in Phase 6 per research), new features, visual/UX changes beyond the today-indicator token swap.

</domain>

<decisions>
## Implementation Decisions

### Human-QA Execution (POLISH-01..05)

- **D-01:** All 5 human-QA items run in **one prod-site sitting** against https://bgscheduler.vercel.app. Claude drafts a walkthrough checklist; user walks through, marks each pass/fail, and Claude records results. Matches the v1.0.1 direct-to-main ship style — no per-item ceremony.
- **D-02:** POLISH-01 (screen-reader AT) is **relaxed to VoiceOver-only**; NVDA is deferred to v1.2. This is an explicit amendment to REQUIREMENTS.md:53 — record the relaxation in the traceability table and add `NVDA-v12` (or similar) to the v1.2+ deferred list in REQUIREMENTS.md. Honest scope for solo admin tool with only macOS access.
- **D-03:** Sign-off evidence lives in **`05-VERIFICATION.md`**: one line per item + pass/fail + ISO timestamp. Screenshots only captured if an item fails. Matches existing phase-verification convention, keeps `.planning/` lean.

### POLISH-13 Retroactive Verification (Phase 02)

- **D-04:** Produce a **lightweight attestation** (not a full `gsd-verifier` re-run). The document cites file:line evidence from `.planning/milestones/v1.0-MILESTONE-AUDIT.md` integration-check results, confirming PERF-04, PERF-05, PERF-06, PERF-07, and INFRA-01 were independently verified post-hoc. Approximate length: ~50 lines. Does NOT re-inspect live code; the audit already did that.
- **D-05:** File lives under **`.planning/milestones/`** adjacent to existing v1.0 archive artifacts, following the prefix convention (`v1.0-PHASE-02-VERIFICATION.md` or similar name the planner chooses). Does NOT recreate the deleted `.planning/phases/02-*/` directory.

### POLISH-09 Today-Indicator Semantic Token

- **D-06:** Introduce **new `--today-indicator`** semantic token in `src/app/globals.css` (OKLCH equivalent of the current `bg-red-500`). Preserves GCal convention. Does NOT reuse `--destructive` (semantic conflict — destructive is "action danger," not "current moment").
- **D-07:** **Same color in light and dark mode** — today indicator is a universal signal; GCal/Outlook/Cron all hold the red consistent across themes. No theme variant needed.
- **D-08:** Apply token via Tailwind `bg-today-indicator` (or equivalent per the shadcn token wiring in `globals.css`) at four call sites: `src/components/compare/calendar-grid.tsx:303,307` (line + dot) and `src/components/compare/week-overview.tsx:547,551` (line + dot). Replace literal `bg-red-500` in all four locations.

### Working-Tree Cleanup (scope expansion)

- **D-09:** Fold cleanup into Phase 5 as a **single prep commit** at phase start: `chore(05): clean working tree + commit phase archival deletions`. Deletes:
  - `src/app/api/auth/[...nextauth]/route 2.ts` (macOS Finder duplicate, byte-for-byte identical to `route.ts`)
  - `src/app/api/search/range/route 2.ts` (same)
  - `.planning/phases/FULL-APP-UI-REVIEW.md` (stale UI review from pre-v1.1 work)
  - `.planning/ui-reviews/` (empty directory)
- **D-10:** Same prep commit **picks up the ~40 staged `D .planning/phases/*`** deletions from the prior `/gsd-complete-milestone` archival. One commit resolves the dirty tree so every subsequent POLISH commit is focused.

### Claude's Discretion

The following are explicitly left to the planner / executor — no user decision needed:

- **Plan split:** how to break the 16 POLISH items + prep commit across plan files (single `05-01-PLAN.md`, two plans, or plan-per-category). User expects the planner to optimize for commit cadence, not ceremony.
- **POLISH-16 test coverage depth:** pick sensible Vitest cases for `src/lib/search/recommend.ts` — at minimum: empty-response guard (line 24), tier assignment (Best/Strong/Good), rank order by availableTutors count, tie-break by start time (line 38), modality-label reasons (lines 51–57), limit parameter behavior. Comprehensive enough to regression-guard, not exhaustive.
- **POLISH-11 addTutor useCallback dep array:** the closure references `compareTutors` + `weekStart` + `fetchCompare`; planner picks the exact deps per standard practice.
- **POLISH-14 TutorSelector removal:** remove the component body (`export function TutorSelector(...)`) at `src/components/compare/tutor-selector.tsx:19-49`; preserve `interface TutorChip`, the `TUTOR_COLORS` re-export, and the `type { TutorChip }` export — these are still consumed elsewhere.
- **POLISH-07 today-indicator midnight tick:** include `new Date().toDateString()` (or an explicit day-check) inside the interval so the indicator re-evaluates `isCurrentWeek` after midnight.
- **POLISH-06/08 URL-sync / regex strictness:** memoize `compare.compareTutors` dependency (or narrow the effect's deps to primitives); tighten the `?week=` regex to reject calendar-impossible dates (e.g., validate via `Date.UTC` round-trip, not just shape match).
- **Commit cadence:** one commit per POLISH item where reasonable. Prep commit, then atomic per-item commits, matching GSD executor default.

### Folded Todos

No GSD todos surfaced for Phase 5 (todo match returned 0). STATE.md pending todos (orphan cleanup, v1.0.1 UAT, `recommend.test.ts`) are already mirrored as POLISH-14/15/16 requirements.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/REQUIREMENTS.md` §"Backlog Drain — Phase 04 human QA / Phase 03 findings / Cross-phase tech debt" — POLISH-01..16 specifications with specific line references
- `.planning/REQUIREMENTS.md` §Traceability — POLISH-01..16 all mapped to Phase 5
- `.planning/ROADMAP.md` §"Phase 5: POLISH Drain" — 5 success-criteria truths that must become true

### Project constraints
- `.planning/PROJECT.md` §Constraints — no stack changes, fail-closed non-negotiable, 246 tests must continue passing
- `.planning/PROJECT.md` §Key Decisions — today indicator "⚠️ Revisit" flagged for semantic token (applies directly to POLISH-09)
- `AGENTS.md` §"Non-Negotiable Product Rules" — fail-closed rules (POLISH items do not touch these but planner must not regress them)
- `CLAUDE.md` §"Running Commands" — deploy/test/migrate commands

### Research intelligence
- `.planning/research/SUMMARY.md:142` — "Phase 1 (POLISH drain): checklist-driven, no research needed" (confirms no separate RESEARCH.md pass needed for Phase 5)
- `.planning/research/PITFALLS.md#pitfall-15` — POLISH scatter anti-pattern; POLISH-14 noted as zero-cost exception
- `.planning/research/PITFALLS.md#pitfall-14` — CACHE_VERSION discipline lands in Phase 6, NOT Phase 5 (Phase 5 ships no shape changes)

### Source of truth for each POLISH item
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md` §"Tech Debt Detail" — authoritative list of Phase 03 M1–M3 + L1–L4 findings, Phase 04 human-QA items, cross-cutting TutorSelector orphan
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md:32` — TutorSelector orphan file:line evidence (POLISH-14 source)
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md:60,124-128` — Phase 02 VERIFICATION.md gap evidence (POLISH-13 citation target)

### Implementation call sites (planner should read these files)
- `src/components/search/search-workspace.tsx:42-51` — mount-effect deep-link handler (POLISH-12 / L4 stale-closure fix)
- `src/components/search/search-workspace.tsx:45` — `?week=` regex `/^\d{4}-\d{2}-\d{2}$/` (POLISH-08 / M3 tighten)
- `src/components/search/search-workspace.tsx:54-66` — URL-sync effect with `[compare.compareTutors, compare.weekStart, compare]` deps (POLISH-06 / M1 memoize)
- `src/components/compare/week-overview.tsx:237,240-247,544-551` — isCurrentWeek + today indicator (POLISH-07, POLISH-09)
- `src/components/compare/calendar-grid.tsx:70,73-80,300-307` — isCurrentWeek + today indicator (POLISH-07, POLISH-09)
- `src/components/compare/week-overview.tsx:259,295-492` — `multiTutorLayout` declaration and usages (POLISH-10 / L2 dead-code guard)
- `src/hooks/use-compare.ts:178-192` — `addTutor` function body (POLISH-11 / L3 useCallback wrap)
- `src/components/compare/tutor-selector.tsx:19-49` — unused `TutorSelector` component body (POLISH-14 removal target)
- `src/lib/search/recommend.ts` — ranking logic for test target (POLISH-16)
- `src/app/globals.css` — semantic-token declarations (POLISH-09 target: add `--today-indicator`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Semantic token pattern already established** — `globals.css` has `--available`, `--blocked`, `--conflict`, `--free-slot` OKLCH tokens consumed via Tailwind. POLISH-09 follows this exact pattern.
- **Vitest configured with `__tests__/` convention** — `src/lib/search/__tests__/` already has `compare.test.ts`, `engine.test.ts`, etc. POLISH-16 follows the same layout for `recommend.test.ts`.
- **Milestone archive naming convention** — `.planning/milestones/v1.0-ROADMAP.md`, `v1.0-REQUIREMENTS.md`, `v1.0-MILESTONE-AUDIT.md`. POLISH-13 follows this prefix pattern.
- **TUTOR_COLORS + TutorChip** exported from `src/components/compare/tutor-selector.tsx` — both still consumed (do NOT delete the file; only delete the unused component body).

### Established Patterns
- **Atomic commits per concern** — v1.0 shipped 11 plans each as focused commits; POLISH items naturally decompose this way.
- **useCallback on stable deps only** — existing hooks in `use-compare.ts` already use `useCallback` (e.g., `fetchCompare` line 88). POLISH-11 matches this.
- **Effect-dep memoization** — `search-workspace.tsx` already uses `useCallback` for handlers. POLISH-06 needs to extend that discipline to the URL-sync effect's `compare` dep.
- **Regex validation at route boundaries** — Zod `.safeParse` is the project default. POLISH-08 tightens the client-side regex separately (the server route already validates via Zod).

### Integration Points
- **No server-route changes** — every POLISH item is client-side, test-side, CSS-side, or docs-side. Sync pipeline, API routes, and DB schema are untouched.
- **No regression risk to the 246 test baseline** if tests are added (POLISH-16) rather than modified. Planner should verify `npm test` passes after each commit.
- **v1.0.1 production UAT (POLISH-15)** overlaps with the human-QA sitting but targets different surfaces (recommended-slots hero, copy-for-parent drawer, search defaults). Combine into a single prod walkthrough where feasible.

</code_context>

<specifics>
## Specific Ideas

- **"One prod-site sitting" framing** — user explicitly wants minimal ceremony. Plan the QA walkthrough as a single Markdown checklist in the plan file so the executor can produce a short `05-VERIFICATION.md` entry per item in real time, not as a formal report.
- **GCal red is non-negotiable for today indicator** — do not propose alternate colors; the OKLCH value should visually match the current `bg-red-500` (#ef4444 approx) so there is zero visual regression on production.
- **"Lightweight attestation" for POLISH-13** — mirror the phrasing from `v1.0-MILESTONE-AUDIT.md:128`: "Accept the integration check as the verification of record for Phase 02 and note this in the milestone archive." The new artifact IS that note, formalized.
- **Prep-commit discipline** — orphan cleanup + archival deletions land together BEFORE any POLISH-* commit so `git log --oneline .planning/phases/05-polish-drain/` reads cleanly.

</specifics>

<deferred>
## Deferred Ideas

- **NVDA screen-reader sign-off** — deferred to v1.2 per D-02. Add to `REQUIREMENTS.md` §v1.2+ as `NVDA-v12` (or next reasonable ID) during planning.
- **CACHE_VERSION constant** — explicitly NOT introduced in Phase 5. Lands in Phase 6 (MOD-01) per research convergence. Phase 5 ships no shape changes.
- **Stale REQUIREMENTS.md v1.0 traceability checkboxes** — cross-cutting tech-debt item from audit (`v1.0-MILESTONE-AUDIT.md:33`). `/gsd-complete-milestone 1.0` already ran during archival, so this should be resolved; planner should verify via grep for `[ ]` in the v1.0-REQUIREMENTS.md archive. Not a new Phase 5 task.
- **Additional Phase 03 test coverage for M2 midnight fix / M3 regex fix** — out of Phase 5 explicit scope (POLISH-16 covers only `recommend.ts`). Planner's discretion whether to add regression tests alongside POLISH-07/08 — encouraged but not required.
- **Wise historical endpoint spike (PAST-06)** — Phase 7 concern, not Phase 5.
- **Lighthouse / Playwright a11y automation** — not scoped for v1.1; Phase 5 only requires human attestation.

### Reviewed Todos (not folded)

None — todo match returned 0 results for Phase 5. The STATE.md "Pending Todos" list is already fully mirrored by POLISH-14/15/16 requirements.

</deferred>

---

*Phase: 05-polish-drain*
*Context gathered: 2026-04-21*
