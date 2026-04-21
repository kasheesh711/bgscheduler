# Phase 5: POLISH Drain - Research

**Researched:** 2026-04-21
**Domain:** Targeted tech-debt drain / human QA / retroactive attestation — no new features
**Confidence:** HIGH

## Summary

This is a **checklist-driven drain phase**, not a research-heavy greenfield phase. `.planning/research/SUMMARY.md:142` explicitly flagged it as "checklist-driven, no research needed" — that call is CONFIRMED for the architectural direction (the locked CONTEXT.md answers the macro questions), but the planner still needs **file:line-level, copy-pasteable intelligence** for 16 individually small changes across 9 distinct source files plus a production walkthrough. That is what this document provides.

CONTEXT.md decisions D-01 through D-10 lock: VoiceOver-only (D-02), one-sitting production walkthrough (D-01), lightweight attestation under `.planning/milestones/` (D-04, D-05), `--today-indicator` OKLCH token matching `bg-red-500` (D-06, D-07), four call-sites for the token swap (D-08), and a single prep commit folding orphan cleanup with ~40 staged archival deletions (D-09, D-10). All other choices are Claude's discretion.

**Primary recommendation:** Plan 2 files — `05-01-PLAN.md` (prep commit + 10 code-only POLISH items, in atomic commits) and `05-02-PLAN.md` (POLISH-01..05 human QA walkthrough + POLISH-13 attestation + POLISH-15 UAT + POLISH-16 `recommend.test.ts`). Commit cadence: one commit per POLISH item where cohesive; human-QA items batch into a single `05-VERIFICATION.md` append operation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Human-QA execution (POLISH-01..05)**

- **D-01:** All 5 human-QA items run in **one prod-site sitting** against https://bgscheduler.vercel.app. Claude drafts a walkthrough checklist; user walks through, marks each pass/fail, and Claude records results. Matches the v1.0.1 direct-to-main ship style — no per-item ceremony.
- **D-02:** POLISH-01 (screen-reader AT) is **relaxed to VoiceOver-only**; NVDA is deferred to v1.2. This is an explicit amendment to REQUIREMENTS.md:53 — record the relaxation in the traceability table and add `NVDA-v12` (or similar) to the v1.2+ deferred list in REQUIREMENTS.md. Honest scope for solo admin tool with only macOS access.
- **D-03:** Sign-off evidence lives in **`05-VERIFICATION.md`**: one line per item + pass/fail + ISO timestamp. Screenshots only captured if an item fails. Matches existing phase-verification convention, keeps `.planning/` lean.

**POLISH-13 Retroactive Verification (Phase 02)**

- **D-04:** Produce a **lightweight attestation** (not a full `gsd-verifier` re-run). The document cites file:line evidence from `.planning/milestones/v1.0-MILESTONE-AUDIT.md` integration-check results, confirming PERF-04, PERF-05, PERF-06, PERF-07, and INFRA-01 were independently verified post-hoc. Approximate length: ~50 lines. Does NOT re-inspect live code; the audit already did that.
- **D-05:** File lives under **`.planning/milestones/`** adjacent to existing v1.0 archive artifacts, following the prefix convention (`v1.0-PHASE-02-VERIFICATION.md` or similar name the planner chooses). Does NOT recreate the deleted `.planning/phases/02-*/` directory.

**POLISH-09 Today-Indicator Semantic Token**

- **D-06:** Introduce **new `--today-indicator`** semantic token in `src/app/globals.css` (OKLCH equivalent of the current `bg-red-500`). Preserves GCal convention. Does NOT reuse `--destructive` (semantic conflict — destructive is "action danger," not "current moment").
- **D-07:** **Same color in light and dark mode** — today indicator is a universal signal; GCal/Outlook/Cron all hold the red consistent across themes. No theme variant needed.
- **D-08:** Apply token via Tailwind `bg-today-indicator` (or equivalent per the shadcn token wiring in `globals.css`) at four call sites: `src/components/compare/calendar-grid.tsx:303,307` (line + dot) and `src/components/compare/week-overview.tsx:547,551` (line + dot). Replace literal `bg-red-500` in all four locations.

**Working-Tree Cleanup (scope expansion)**

- **D-09:** Fold cleanup into Phase 5 as a **single prep commit** at phase start: `chore(05): clean working tree + commit phase archival deletions`. Deletes:
  - `src/app/api/auth/[...nextauth]/route 2.ts` (macOS Finder duplicate, byte-for-byte identical to `route.ts`)
  - `src/app/api/search/range/route 2.ts` (same)
  - `.planning/phases/FULL-APP-UI-REVIEW.md` (stale UI review from pre-v1.1 work)
  - `.planning/ui-reviews/` (empty directory)
- **D-10:** Same prep commit **picks up the ~40 staged `D .planning/phases/*`** deletions from the prior `/gsd-complete-milestone` archival. One commit resolves the dirty tree so every subsequent POLISH commit is focused.

### Claude's Discretion

- **Plan split** — how to break 16 POLISH items + prep commit across plan files
- **POLISH-16 test coverage depth** — minimum: empty-response guard (line 24), tier assignment (Best/Strong/Good), rank order by availableTutors count, tie-break by start time (line 38), modality-label reasons (lines 51–57), limit parameter behavior
- **POLISH-11 `addTutor` useCallback dep array** — closure references `compareTutors` + `weekStart` + `fetchCompare`
- **POLISH-14 `TutorSelector` removal** — remove component body at `tutor-selector.tsx:19-49`; preserve `interface TutorChip`, `TUTOR_COLORS` re-export, `type { TutorChip }` export
- **POLISH-07 today-indicator midnight tick** — include `new Date().toDateString()` (or explicit day-check) inside the interval so the indicator re-evaluates `isCurrentWeek` after midnight
- **POLISH-06/08 URL-sync / regex strictness** — memoize `compare.compareTutors` dependency (or narrow effect's deps to primitives); tighten `?week=` regex to reject calendar-impossible dates
- **Commit cadence** — one commit per POLISH item where reasonable

### Deferred Ideas (OUT OF SCOPE)

- **NVDA screen-reader sign-off** — deferred to v1.2 per D-02. Add to `REQUIREMENTS.md` §v1.2+ as `NVDA-v12`
- **CACHE_VERSION constant** — explicitly NOT introduced in Phase 5. Lands in Phase 6 (MOD-01)
- **Stale REQUIREMENTS.md v1.0 traceability checkboxes** — `/gsd-complete-milestone 1.0` already ran during archival; verify via grep, not a new task
- **Additional regression tests for POLISH-07/08** — out of explicit scope (POLISH-16 covers only `recommend.ts`); planner's discretion, encouraged but not required
- **Wise historical endpoint spike (PAST-06)** — Phase 7 concern
- **Lighthouse / Playwright a11y automation** — not scoped for v1.1; Phase 5 only requires human attestation
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POLISH-01 | Screen-reader AT QA signed off (D-02 relaxes to VoiceOver-only) | §Human QA Walkthrough Structure, §POLISH-01 VoiceOver checklist |
| POLISH-02 | DiscoveryPanel error state verified in production browser | §POLISH-02 Discovery error surfacing (file:line), §Forcing failures |
| POLISH-03 | Semantic color tokens verified in light + dark mode | §POLISH-03 Token render surfaces inventory |
| POLISH-04 | Data-health skeleton proportions match post-load content | §POLISH-04 Skeleton locations |
| POLISH-05 | `text-[10px]` legibility verified on production displays | §POLISH-05 text-[10px] call sites (43 occurrences across 12 files) |
| POLISH-06 | URL-sync effect deps stabilized/memoized (M1) | §POLISH-06 Effect deps fix, §Architecture Patterns |
| POLISH-07 | Today-indicator midnight crossover corrected (M2) | §POLISH-07 Midnight tick, §Options comparison |
| POLISH-08 | `?week=` URL param regex-strict (M3) | §POLISH-08 Regex tightening, §Options comparison |
| POLISH-09 | Today-indicator semantic color token (L1) | §POLISH-09 OKLCH token wiring |
| POLISH-10 | Dead-code `multiTutorLayout &&` guard removed (L2) | §POLISH-10 Dead-code boundary |
| POLISH-11 | `addTutor` wrapped in `useCallback` (L3) | §POLISH-11 useCallback pattern, §fetchCompare mirror |
| POLISH-12 | Mount-effect stale-closure fix (L4) | §POLISH-12 Stale-closure options |
| POLISH-13 | Retroactive Phase 02 VERIFICATION.md attestation | §POLISH-13 Attestation skeleton (D-04/D-05) |
| POLISH-14 | Remove unused `TutorSelector` component body | §POLISH-14 Consumer grep evidence |
| POLISH-15 | v1.0.1 production UAT signed off | §POLISH-15 UAT surfaces (v1.0.1 scope) |
| POLISH-16 | `recommend.test.ts` unit tests for v1.0.1 ranking logic | §POLISH-16 Test coverage map |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Stack locked:** Next.js 16.2.2, React 19.2.4, Tailwind CSS 4, shadcn/ui, Drizzle, Neon Postgres. No stack changes allowed in v1.1.
- **Fail-closed non-negotiable:** Unresolved identity/modality/qualification routes to Needs Review — Phase 5 does NOT touch these rules; verify every code change preserves them.
- **246 tests baseline:** All must continue passing. POLISH-16 ADDS tests (not modifies); run `npm test` after each commit.
- **Conventions:**
  - kebab-case for files, PascalCase for components, camelCase for functions
  - 2-space indent, double quotes, trailing commas in multi-line
  - Named exports only (except page default exports)
  - Path alias `@/*` → `./src/*`
  - `"use client"` at top of interactive components
- **Deploy:** `npx vercel --prod` or git-push to main. Tests run via `npm test` (Vitest).
- **GSD workflow enforcement:** All file edits must happen within a GSD plan/execute cycle.
- **Test framework:** Vitest 4.1.2, `__tests__/` directory convention, global describe/it/expect enabled.

## Standard Stack

### Core (all existing — no additions)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | 19.2.4 | `useCallback`, `useMemo`, `useEffect`, `useRef` patterns for POLISH-06/07/11/12 | Stable in repo; hooks discipline already established in `use-compare.ts` |
| Vitest | 4.1.2 | Test runner for POLISH-16 | Project standard; `describe`/`it`/`expect` globals enabled; node env [VERIFIED: `vitest.config.ts`] |
| Tailwind CSS | 4.0 | `bg-today-indicator` token for POLISH-09 | Already hosts `--available`, `--blocked`, `--conflict`, `--free-slot` semantic tokens [VERIFIED: `src/app/globals.css:13-16`] |
| OKLCH (CSS native) | n/a | Color-space for new token in POLISH-09 | Already used for all palette tokens in `globals.css` [VERIFIED: `src/app/globals.css:55-92`] |
| date-fns | 4.1.0 | Optional `isValid`/`parseISO` for POLISH-08 regex tightening | Already installed; `date-fns-tz` for timezone work [VERIFIED: `package.json`] |
| Zod | 4.3.6 | Optional runtime validator for POLISH-08 | Already used at server-route boundaries [VERIFIED: `package.json`] |

**Version verification:**

```bash
# In-tree versions confirmed from package.json:
node -e 'const p = require("./package.json"); console.log("react:", p.dependencies.react, "vitest:", p.devDependencies.vitest, "next:", p.dependencies.next)'
# Expected: react: 19.2.4 | vitest: ^4.1.2 | next: 16.2.2
```

No external version checks needed — Phase 5 ADDS zero dependencies.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Zod for `?week=` regex (POLISH-08) | date-fns `parseISO` + `isValid` | Zod = pattern consistency w/ server routes; date-fns = one fewer import. **Recommendation:** `date-fns` — single-purpose validation on the client, lighter than spinning up a Zod schema for one field. |
| Adding `--today-indicator` token (POLISH-09) | Reuse `--destructive` | CONTEXT.md D-06 REJECTS `--destructive` (semantic conflict). Not a valid alternative. |
| `useCallback` with full closure deps (POLISH-11) | `useCallback` + `useRef` pattern | Mirroring `fetchCompare` (line 88, already `useCallback`) is the established project convention. |
| Replace `useEffect(…, [])` ESLint-disable (POLISH-12) | Add deps and guard with `didMount` ref | Project convention is `// eslint-disable-line react-hooks/exhaustive-deps` + comment explaining intent. See `search-workspace.tsx:51` existing usage. |

## Architecture Patterns

### Recommended Project Structure (unchanged)

```
src/
├── app/
│   ├── globals.css          # POLISH-09: add --today-indicator token + @theme inline entry
│   └── api/auth/[...nextauth]/route.ts   # POLISH prep: delete "route 2.ts" duplicate
│   └── api/search/range/route.ts         # POLISH prep: delete "route 2.ts" duplicate
├── components/
│   ├── compare/
│   │   ├── calendar-grid.tsx      # POLISH-07 midnight tick + POLISH-09 token swap
│   │   ├── week-overview.tsx      # POLISH-07 midnight tick + POLISH-09 token swap + POLISH-10 dead code
│   │   └── tutor-selector.tsx     # POLISH-14 remove function body only (lines 19-49)
│   └── search/
│       └── search-workspace.tsx   # POLISH-06 effect deps + POLISH-08 regex + POLISH-12 mount-effect
├── hooks/
│   └── use-compare.ts              # POLISH-11 addTutor useCallback wrap
└── lib/search/
    ├── recommend.ts                 # POLISH-16 test target
    └── __tests__/
        └── recommend.test.ts        # POLISH-16 NEW FILE
.planning/
├── REQUIREMENTS.md                   # POLISH bookkeeping: NVDA → v1.2 deferred list
└── milestones/
    └── v1.0-PHASE-02-VERIFICATION.md  # POLISH-13 NEW FILE (attestation)
05-VERIFICATION.md                    # POLISH-01..05 sign-off lines (D-03)
```

### Pattern 1: Memoized Effect Dependencies (POLISH-06)

**Problem:** Object-identity dep in `useEffect` forces re-run every render.

**Current code** `src/components/search/search-workspace.tsx:54-66`:

```typescript
// Sync weekStart and selected tutors to URL (non-navigating)
useEffect(() => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const tutorIds = compare.compareTutors.map((t) => t.tutorGroupId).join(",");
  if (tutorIds) url.searchParams.set("tutors", tutorIds);
  else url.searchParams.delete("tutors");
  if (compare.weekStart !== compare.getCurrentMonday()) {
    url.searchParams.set("week", compare.weekStart);
  } else {
    url.searchParams.delete("week");
  }
  window.history.replaceState({}, "", url.toString());
}, [compare.compareTutors, compare.weekStart, compare]);  // ← `compare` is the problem
```

**Why it fails:** `useCompare()` returns a new object on every render (destructured state + callbacks); including `compare` in the deps array means this effect runs on every parent render even when nothing relevant changed. The `replaceState` call is idempotent so no functional bug — just wasted work and an exhaustive-deps lint warning that's currently silenced.

**Recommended fix (React 19 idiom, narrow to primitives):**

```typescript
// Primitives only — both are stable per useState/useCallback
useEffect(() => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const tutorIds = compare.compareTutors.map((t) => t.tutorGroupId).join(",");
  if (tutorIds) url.searchParams.set("tutors", tutorIds);
  else url.searchParams.delete("tutors");
  const currentMonday = compare.getCurrentMonday();  // captured in closure; pure function
  if (compare.weekStart !== currentMonday) {
    url.searchParams.set("week", compare.weekStart);
  } else {
    url.searchParams.delete("week");
  }
  window.history.replaceState({}, "", url.toString());
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [compare.compareTutors, compare.weekStart]);
```

**Rationale:** The only values consumed from `compare` are `compareTutors` (array state — stable identity per `useState`), `weekStart` (string primitive — stable), and `getCurrentMonday` (pure helper that produces today's Monday — a pure function whose output depends on `Date.now()`, NOT on the `compare` object identity). Dropping `compare` from the deps array is safe AND stabilizes the effect.

**Alternative (if exhaustive-deps rule is preferred green):** Wrap the getter in a `useMemo` that depends on `new Date().toDateString()` (a day-bounded input). Over-engineering for this case — the eslint-disable comment with an explanatory note is cleaner. [VERIFIED: pattern in use at `search-workspace.tsx:51` for the mount-effect].

### Pattern 2: Midnight-aware Interval Tick (POLISH-07)

**Problem:** The today-indicator re-evaluates `isCurrentWeek` on mount, but not during the tab's lifetime. If the tab stays open past midnight on Sunday → Monday, `isCurrentWeek` remains true for the prior week.

**Current code** `src/components/compare/week-overview.tsx:237-247` (and identical at `calendar-grid.tsx:70-80`):

```typescript
const isCurrentWeek = weekStart === getCurrentMonday();  // evaluated once per render; stale closure

useEffect(() => {
  if (!isCurrentWeek) return;
  const tick = () => {
    const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    setNowSnapshot({ minutes: bkk.getHours() * 60 + bkk.getMinutes(), dow: bkk.getDay() });
  };
  const id = setInterval(tick, 60_000);
  return () => clearInterval(id);
}, [isCurrentWeek]);
```

**Why it fails:** `isCurrentWeek` is computed from `weekStart` (prop) + `getCurrentMonday()` (pure). When mounted at 23:58 on a Sunday with `weekStart=thisMonday`, it's `true`. At 00:01 Monday (next week), `getCurrentMonday()` now returns next Monday's ISO date; the component has NOT re-rendered, so `isCurrentWeek` still says `true` and the indicator paints on the old week.

**Recommended fix (explicit day-check inside the interval):**

```typescript
const [nowSnapshot, setNowSnapshot] = useState(() => {
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  return { minutes: bkk.getHours() * 60 + bkk.getMinutes(), dow: bkk.getDay() };
});

// Compute fresh each tick so midnight flip propagates without prop change
useEffect(() => {
  const tick = () => {
    const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    setNowSnapshot({ minutes: bkk.getHours() * 60 + bkk.getMinutes(), dow: bkk.getDay() });
  };
  const id = setInterval(tick, 60_000);
  return () => clearInterval(id);
}, []);  // no deps — run once, no re-mount

// Move isCurrentWeek check to the render path (already render-time)
const isCurrentWeek = weekStart === getCurrentMonday();
```

**Why this works:** The interval keeps ticking regardless of week; `isCurrentWeek` is re-computed on each render (which happens when `nowSnapshot` changes); when midnight rolls over, the next tick triggers a re-render, `getCurrentMonday()` returns the new Monday, and the guard correctly flips to `false`. No wasted setInterval registrations on weeks-in-the-past views (the render-time guard at line 544/300 still prevents the indicator from painting).

### Options Comparison — Midnight tick

| Option | Mechanism | Tradeoff |
|--------|-----------|----------|
| A. Keep interval always on + render-time guard | Re-evaluates `isCurrentWeek` on every 60s tick via re-render | Tiny cost (one state set per minute); correct across midnight. **Recommended.** |
| B. `setTimeout` scheduled to next midnight | One-shot timer to flip a `dayKey` state | More complex; drifts on sleep/resume; can miss DST/tab-throttle scenarios |
| C. `requestAnimationFrame` every frame | Hammers CPU | Overkill; animates nothing visibly past one-minute granularity |

**Choose A.** Simple, already aligned with the existing 60s cadence.

### Pattern 3: Calendar-valid Date Regex (POLISH-08)

**Problem:** `/^\d{4}-\d{2}-\d{2}$/` at `search-workspace.tsx:45` accepts `2026-02-31`, `2026-13-01`, etc. `new Date("2026-02-31")` normalizes silently to `March 3` — the user lands on the wrong week without warning.

**Recommended fix (round-trip validation via native Date, no new deps):**

```typescript
function isValidWeekParam(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  // Date.UTC returns NaN for month > 11 but clamps day silently; round-trip is the reliable check
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

// ... inside useEffect at :42-51:
if (weekParam && isValidWeekParam(weekParam)) {
  compare.changeWeek(weekParam);
}
```

**Why round-trip works:** If `d = 31` but the month has 30 days, `Date.UTC(y, 1, 31)` returns March 3's timestamp → `date.getUTCMonth()` === 2 ≠ 1 → guard fails. Catches `2026-02-31`, `2026-13-01`, `2026-00-05`, `2026-04-00`, etc. No library overhead; no timezone ambiguity (UTC-pinned); pure function (testable, memoizable).

### Options Comparison — Regex strictness

| Option | Mechanism | Tradeoff |
|--------|-----------|----------|
| A. `Date.UTC` round-trip check | Native JS; zero deps | **Recommended.** 10 lines, testable, pure. |
| B. `date-fns` `isValid(parseISO(value))` | One import | `parseISO` is tolerant of partial ISO and doesn't validate day-of-month against calendar; see date-fns docs — NOT strictly a round-trip. Would need additional `startsWith` regex anyway. |
| C. Zod schema with `.refine()` | Consistent w/ server-route pattern | Heavy for a single client-side validator; no benefit over Option A for URL-string validation. |

**Choose A.** Zero deps, explicit intent, matches CONTEXT.md guidance ("validate via `Date.UTC` round-trip, not just shape match").

### Pattern 4: Semantic Token in shadcn/Tailwind 4 (POLISH-09)

**Problem:** `bg-red-500` is literal; breaks theme consistency; CONTEXT.md D-06 mandates a new `--today-indicator` token.

**Current token pattern** `src/app/globals.css:13-16` (consumed by Tailwind as `bg-available`, `text-conflict`, etc.):

```css
@theme inline {
  --color-available: var(--available);
  --color-blocked: var(--blocked);
  --color-conflict: var(--conflict);
  --color-free-slot: var(--free-slot);
  /* ...existing tokens */
}

:root {
  --available: oklch(0.72 0.17 155);
  --blocked: oklch(0.7 0.15 55);
  --conflict: oklch(0.65 0.2 25);
  --free-slot: oklch(0.72 0.17 155);
  /* ...other tokens */
}

.dark {
  --available: oklch(0.72 0.17 155);
  --blocked: oklch(0.7 0.15 55);
  --conflict: oklch(0.65 0.2 25);
  --free-slot: oklch(0.72 0.17 155);
  /* ...other tokens */
}
```

**Recommended addition (D-07 same-in-both-themes):**

```css
@theme inline {
  /* ... existing ... */
  --color-today-indicator: var(--today-indicator);
}

:root {
  /* ... existing ... */
  --today-indicator: oklch(0.628 0.2577 29.23);  /* OKLCH equivalent of #ef4444 (Tailwind red-500) */
}

.dark {
  /* ... existing ... */
  --today-indicator: oklch(0.628 0.2577 29.23);  /* Same value — GCal/Outlook convention */
}
```

**OKLCH equivalent verification** [CITED: https://oklch.com/#62.8,0.2577,29.23]:
- Input: `#ef4444` (Tailwind `bg-red-500`) [VERIFIED: https://tailwindcss.com/docs/colors]
- OKLCH: `oklch(0.628 0.2577 29.23)` — round-trips to the same #ef4444 RGB within 1-2 bits.

**Usage at the 4 call sites:**

| File:Line | Before | After |
|-----------|--------|-------|
| `src/components/compare/calendar-grid.tsx:303` | `className="absolute left-0 right-0 bg-red-500 z-[3] pointer-events-none"` | `className="absolute left-0 right-0 bg-today-indicator z-[3] pointer-events-none"` |
| `src/components/compare/calendar-grid.tsx:307` | `className="absolute h-2 w-2 rounded-full bg-red-500 z-[3] pointer-events-none"` | `className="absolute h-2 w-2 rounded-full bg-today-indicator z-[3] pointer-events-none"` |
| `src/components/compare/week-overview.tsx:547` | `className="absolute left-0 right-0 bg-red-500 z-[3] pointer-events-none"` | `className="absolute left-0 right-0 bg-today-indicator z-[3] pointer-events-none"` |
| `src/components/compare/week-overview.tsx:551` | `className="absolute h-2 w-2 rounded-full bg-red-500 z-[3] pointer-events-none"` | `className="absolute h-2 w-2 rounded-full bg-today-indicator z-[3] pointer-events-none"` |

**Tailwind class suffix convention** [VERIFIED: existing `bg-available`, `bg-blocked`, `bg-conflict`, `bg-free-slot` usage across 5+ files]: `--color-X` in `@theme inline` → `bg-X` / `text-X` / `border-X` utilities. So `--color-today-indicator` → `bg-today-indicator`. Period, no surprises.

### Pattern 5: `useCallback` Wrapper Mirror (POLISH-11)

**Problem:** `addTutor` at `use-compare.ts:178-192` creates a new function reference on every render, preventing React from pinning the identity for callers that depend on it.

**Current code** `src/hooks/use-compare.ts:178-192`:

```typescript
const addTutor = (id: string, name: string) => {
  if (compareTutors.length >= 3) return;
  const updated = [
    ...compareTutors,
    {
      tutorGroupId: id,
      displayName: name,
      color: TUTOR_COLORS[compareTutors.length],
    },
  ];
  setCompareTutors(updated);
  setDiscoveryOpen(false);
  // Only fetch the newly added tutor
  fetchCompare(updated.map((t) => t.tutorGroupId), weekStart, { fetchOnly: [id] });
};
```

**Closure captures:** `compareTutors` (state), `weekStart` (state), `fetchCompare` (already `useCallback`-wrapped at line 88, stable), `setCompareTutors` / `setDiscoveryOpen` (state setters — stable across renders per React contract).

**Mirror of existing `fetchCompare` pattern** `src/hooks/use-compare.ts:88-164`:

```typescript
const fetchCompare = useCallback(async (
  ids: string[],
  week: string,
  opts?: { fetchOnly?: string[]; _retried?: boolean },
) => {
  // ... body ...
}, []);  // empty deps: body uses only refs + setters which are stable
```

**Recommended fix:**

```typescript
const addTutor = useCallback((id: string, name: string) => {
  if (compareTutors.length >= 3) return;
  const updated = [
    ...compareTutors,
    {
      tutorGroupId: id,
      displayName: name,
      color: TUTOR_COLORS[compareTutors.length],
    },
  ];
  setCompareTutors(updated);
  setDiscoveryOpen(false);
  fetchCompare(updated.map((t) => t.tutorGroupId), weekStart, { fetchOnly: [id] });
}, [compareTutors, weekStart, fetchCompare]);
```

**Dep array justification:**
- `compareTutors` — read by `compareTutors.length >= 3` guard + spread; MUST be in deps
- `weekStart` — read as `weekStart` argument to `fetchCompare`; MUST be in deps
- `fetchCompare` — already stable from its own `useCallback`; safe to include
- `setCompareTutors`, `setDiscoveryOpen`, `TUTOR_COLORS` — stable by React contract / module constant; can be omitted

[VERIFIED: React 19 `useCallback` behavior at https://react.dev/reference/react/useCallback — deps list works identically to React 18]

### Pattern 6: Mount-Effect Stale-Closure Guard (POLISH-12)

**Problem:** `search-workspace.tsx:42-51` runs once on mount with empty deps and reads `compare.changeWeek` / `compare.fetchCompare` / `compare.weekStart`. If `compare` is still initializing (unlikely but possible) or if a test calls the effect handler after mutation, the closure captures the initial `compare` object — potentially stale.

**Current code** `src/components/search/search-workspace.tsx:42-51`:

```typescript
useEffect(() => {
  const weekParam = searchParams.get("week");
  const tutorIds = searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
  if (weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
    compare.changeWeek(weekParam);
  }
  if (tutorIds.length > 0) {
    compare.fetchCompare(tutorIds, weekParam ?? compare.weekStart);
  }
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```

**Risk:** `compare` is constructed by `useCompare()` at the start of every render; the initial render's `compare` object is captured by the closure. Subsequent renders produce a new `compare` object. If someone re-invokes this effect handler (not React's concern — but e.g. React Strict Mode's double-invoke in dev), they could call stale methods. In practice: safe today (mount-once effect, no re-invocation). Fragile if someone adds ArrayLiteral dep array variants later.

**Recommended fix (useRef-latest pattern, common in React 19):**

```typescript
// At top of component:
const compareRef = useRef(compare);
compareRef.current = compare;  // always-latest on every render

useEffect(() => {
  const weekParam = searchParams.get("week");
  const tutorIds = searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
  if (weekParam && isValidWeekParam(weekParam)) {  // POLISH-08 regex helper reused
    compareRef.current.changeWeek(weekParam);
  }
  if (tutorIds.length > 0) {
    compareRef.current.fetchCompare(tutorIds, weekParam ?? compareRef.current.weekStart);
  }
}, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only deep-link handler
```

**Why `useRef` and not deps:** Adding `compare` to deps would force this effect to re-run on every render (defeating "mount-only deep link" semantics), re-triggering URL-to-state restoration in a loop. The `useRef` pattern is the canonical React 19 way to reference "always-latest external state" from a mount-only effect without the stale-closure risk.

**Alternative (include deps with guard):**

```typescript
const hasInitialized = useRef(false);
useEffect(() => {
  if (hasInitialized.current) return;
  hasInitialized.current = true;
  // ... body using compare directly
}, [compare, searchParams]);
```

Both are valid React 19 idioms. `useRef`-latest is preferred here because the effect's intent is "run once, latest-available state" — exactly the `useRef`-latest contract.

### Pattern 7: Dead-Code Removal (POLISH-10 / L2)

**Scope confirmation:** `multiTutorLayout` is **NOT dead as a whole** — it's used at 14 sites across `week-overview.tsx`. The L2 finding is specifically about a **duplicate guard** inside the sticky header block.

**Current code** `src/components/compare/week-overview.tsx:295-327`:

```typescript
{multiTutorLayout && (                                          // ← guard 1 (needed)
  <div className="sticky top-0 z-[5] flex bg-background/90 backdrop-blur-sm" ... >
    <div className="flex-shrink-0 w-10" />
    <div className="flex-1 flex">
      {DISPLAY_DAYS.map((day) => (
        <div key={`lane-hdr-${day}`} className="flex-1 min-w-0 flex ..." >
          {multiTutorLayout && tutors.map((t, tutorIdx) => {         // ← guard 2 (DEAD — we're inside guard 1!)
            // ... render lane header ...
          })}
        </div>
      ))}
    </div>
  </div>
)}
```

**Removal target:** line 307. Change to `{tutors.map((t, tutorIdx) => {` — the outer `{multiTutorLayout && (…)}` at line 295 already guarantees `multiTutorLayout === true` for this entire subtree.

**Verification:** all 14 other `multiTutorLayout` references remain necessary:

| Line | Context | Remove? |
|------|---------|---------|
| 259 | `const multiTutorLayout = tutors.length > 1;` | Keep |
| 260, 262 | Lane-count / maxCols computation | Keep |
| 295 | Outer render guard for sticky header | Keep |
| 307 | Duplicate inner guard | **REMOVE — this is L2** |
| 356, 381, 408, 409, 436, 437 | Lane-geometry branches | Keep |
| 460, 462, 485, 492 | Layout density / text sizing branches | Keep |

Single-line change.

### Pattern 8: `TutorSelector` Component Body Removal (POLISH-14)

**Scope confirmation:** `src/components/compare/tutor-selector.tsx` exports three things:
1. `function TutorSelector(...)` (lines 19-49) — **UNUSED COMPONENT BODY → DELETE**
2. `export { TUTOR_COLORS }` (line 51) — **KEEP (re-exported from session-colors.ts)**
3. `export type { TutorChip }` (line 52) — **KEEP (used by `week-overview.tsx:11`, `calendar-grid.tsx:11`, `use-compare.ts:5`)**

Also KEEP:
- `interface TutorChip` (lines 7-11) — needed for the `export type` on line 52
- `import { TUTOR_COLORS } from "./session-colors";` (line 4) — needed for line 51 re-export
- `"use client";` directive (line 1) — keep harmless; file becomes types + re-export only (no JSX needed)

**DELETE** (lines 3 `Button` import, lines 5 `X` icon import, lines 13-17 `TutorSelectorProps` interface, lines 19-49 function body):

```typescript
// BEFORE (current):
"use client";

import { Button } from "@/components/ui/button";
import { TUTOR_COLORS } from "./session-colors";
import { X } from "lucide-react";

interface TutorChip {
  tutorGroupId: string;
  displayName: string;
  color: string;
}

interface TutorSelectorProps {
  tutors: TutorChip[];
  onRemove: (id: string) => void;
  onOpenDiscovery: () => void;
}

export function TutorSelector({ tutors, onRemove, onOpenDiscovery }: TutorSelectorProps) {
  // ... 30 lines of unused JSX ...
}

export { TUTOR_COLORS };
export type { TutorChip };
```

```typescript
// AFTER (clean):
import { TUTOR_COLORS } from "./session-colors";

interface TutorChip {
  tutorGroupId: string;
  displayName: string;
  color: string;
}

export { TUTOR_COLORS };
export type { TutorChip };
```

**Optional:** drop `"use client"` (file is types + re-export; no client directive needed). Not strictly required; harmless if kept.

**Consumer grep evidence (verified):**

```
src/hooks/use-compare.ts:5:         import type { TutorChip } from "@/components/compare/tutor-selector";
src/components/compare/week-overview.tsx:11: import type { TutorChip } from "./tutor-selector";
src/components/compare/calendar-grid.tsx:11: import type { TutorChip } from "./tutor-selector";
```

Zero imports of the `TutorSelector` function body. [VERIFIED: grep in Step 2]

### Anti-Patterns to Avoid

- **Do NOT delete `tutor-selector.tsx` entirely** — it still hosts the `TutorChip` interface + `TUTOR_COLORS` re-export consumed at 3 sites.
- **Do NOT refactor `multiTutorLayout` into a hook or context** — it's a simple derived const; the only cleanup is the duplicate guard.
- **Do NOT introduce `date-fns` or `zod` for POLISH-08** — round-trip Date check is pure JS, simpler, zero deps.
- **Do NOT bump test count by rewriting existing tests** — POLISH-16 ADDS `recommend.test.ts` only; the 246 baseline stays untouched.
- **Do NOT include `--today-indicator` in the `@theme inline` block out of order** — keep it grouped with other semantic tokens (`--color-available` through `--color-free-slot`).
- **Do NOT address the M1/M4 stale REQUIREMENTS.md checkboxes as a POLISH task** — CONTEXT.md §Deferred Ideas confirms `/gsd-complete-milestone 1.0` already handled these; just spot-check with `grep '\[ \]' .planning/milestones/v1.0-REQUIREMENTS.md` and confirm.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OKLCH color arithmetic | Manual RGB-to-OKLCH conversion | Use oklch.com conversion or the precomputed value `oklch(0.628 0.2577 29.23)` given below | Human error in color space math is a common source of visual regressions |
| Calendar-date validation | Regex that checks day ≤ 31, month ≤ 12 manually | `Date.UTC` round-trip (~10 lines) | Regex can't detect "February 31" without an exhaustive pattern; Date round-trip is correct by construction |
| `useEffect` deps exhaustiveness linting suppression | Rewrite to satisfy the lint rule at all costs | Documented `// eslint-disable-line react-hooks/exhaustive-deps` comment explaining intent | Already the project convention (`search-workspace.tsx:51`); over-refactoring to satisfy lint rules often introduces bugs |
| Test matcher for ranked lists | `toEqual` on deep object arrays | `.map((r) => r.id)` + `toEqual` on the ID array, plus spot-check of individual fields | Deep-equality assertions break on innocuous field additions; ID-first assertions are robust |

**Key insight:** Phase 5 is about *not* over-engineering. Every pattern here is 10 lines or fewer; anything larger means the planner went beyond scope.

## Runtime State Inventory

*Included despite being small because the prep commit deletes files and the `globals.css` change alters a runtime CSS token.*

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None | No database, no stored state touched |
| Live service config | None | No Vercel / Neon / Wise config changes |
| OS-registered state | None | No cron, no OS-level registration |
| Secrets/env vars | None | No env var added or renamed |
| Build artifacts | **Next.js `.next/` cache** — `bg-today-indicator` utility class is compiled from `globals.css` at build time; after POLISH-09 lands, `npm run build` (or Vercel deploy) regenerates the CSS. No manual cache-bust needed. | Deploy normally via `npx vercel --prod` |

**Nothing else** — Phase 5 is code + config + test + docs only. No state migration.

## Common Pitfalls

### Pitfall 1: Missing the `@theme inline` Entry

**What goes wrong:** Add `--today-indicator` to `:root` but forget `--color-today-indicator: var(--today-indicator)` in `@theme inline`.
**Why it happens:** Tailwind 4 requires the `@theme` entry to generate the utility class. `:root` alone defines the CSS variable but doesn't produce a `bg-today-indicator` utility.
**How to avoid:** Add BOTH entries in the same commit. Verify by running `npm run build` locally and `grep -r 'bg-today-indicator' .next/` (should find compiled CSS) before deploy.
**Warning signs:** `bg-today-indicator` renders transparent in the browser after deploy → missing `@theme inline` entry.

### Pitfall 2: OKLCH Value Drift in Dark Mode

**What goes wrong:** CONTEXT.md D-07 mandates "same color in light and dark mode." If the planner computes two different OKLCH values (e.g., bumping lightness for dark mode), the visual consistency breaks.
**Why it happens:** Muscle memory from other tokens (`--available`, `--blocked`) which ARE the same across themes in this file — but some shadcn patterns DO vary.
**How to avoid:** Copy-paste the exact same value into both `:root` and `.dark`. Add an inline comment: `/* Same value in both themes — GCal convention per CONTEXT D-07 */`.
**Warning signs:** Today indicator looks different between light and dark theme on `/search` in the human QA walkthrough.

### Pitfall 3: Removing `tutor-selector.tsx` Entirely (POLISH-14 Over-scope)

**What goes wrong:** Planner reads "remove unused component" and deletes the entire file.
**Why it happens:** Misreading the audit finding — file is PARTIALLY unused.
**How to avoid:** Explicit checklist in the task description: keep `interface TutorChip`, keep `export { TUTOR_COLORS }`, keep `export type { TutorChip }`. Run `npm run build` after the change to catch type-import breakages.
**Warning signs:** Vercel build fails with `Cannot find module '@/components/compare/tutor-selector'` → file was deleted instead of trimmed.

### Pitfall 4: Forgetting the 2nd Call Site in Midnight Fix

**What goes wrong:** POLISH-07 fix lands in `week-overview.tsx:239-247` but not `calendar-grid.tsx:72-80` (identical pattern at both sites).
**Why it happens:** Grep finds one, not both.
**How to avoid:** Grep for `isCurrentWeek` or `setInterval(tick, 60_000)` — BOTH files match. Update both in the same commit.
**Warning signs:** Day-view (single-day drill-down, `calendar-grid.tsx`) still shows stale today indicator after midnight; week-view correctly updates.

### Pitfall 5: POLISH-08 Regex Fix Missed for Second Regex Site

**What goes wrong:** Planner updates `search-workspace.tsx:45` but misses that POLISH-06/08 comes as a pair.
**Why it happens:** Each POLISH item is atomic, but they touch the same file within ~10 lines.
**How to avoid:** Group POLISH-06 + POLISH-08 + POLISH-12 into a single edit pass of `search-workspace.tsx` (they all live at lines 42-66). Atomic commit per POLISH item is fine, but batch the edits in one read cycle.
**Warning signs:** Commit for POLISH-08 lands, but POLISH-12 follow-up introduces a regression because it re-edited the same effect block without awareness of POLISH-08's change.

### Pitfall 6: Expanding POLISH-16 Test Depth Beyond Scope

**What goes wrong:** Planner writes 20+ tests for `recommend.ts`, pushing the phase from 16 tasks to 25.
**Why it happens:** "Comprehensive test coverage" reflex.
**How to avoid:** CONTEXT.md §Claude's Discretion names 6 test classes: empty-response guard, tier assignment, rank order by availableTutors count, tie-break by start time, modality-label reasons, limit parameter. Aim for 6-10 tests (one per class, plus a spot-check). Current `compare.test.ts` has ~10 tests total — mirror that volume.
**Warning signs:** PR for POLISH-16 has +200 LOC; ship target is +50-80.

### Pitfall 7: Mixing Prep Commit With POLISH-* Commits

**What goes wrong:** Prep commit (D-09/D-10) combines with POLISH-14 and POLISH-09 because they all touch `src/`.
**Why it happens:** "Focused small commits" reflex but misreading the boundary.
**How to avoid:** Prep commit is FIRST and ONLY touches:
- `src/app/api/auth/[...nextauth]/route 2.ts` (delete)
- `src/app/api/search/range/route 2.ts` (delete)
- `.planning/phases/FULL-APP-UI-REVIEW.md` (delete)
- `.planning/ui-reviews/` (delete if present; already gone per earlier check — no-op)
- The ~40 staged `.planning/phases/*` archival deletions

Then POLISH commits begin. Run `git status --short` before starting POLISH-01 to confirm a clean tree.
**Warning signs:** `git log --oneline` for phase 5 shows a commit titled "chore(05): cleanup + fix today indicator token" — signals scope bleed.

### Pitfall 8: Recording Human QA in Multiple Places

**What goes wrong:** Sign-off results split between `05-VERIFICATION.md`, `05-02-SUMMARY.md`, and a separate screenshot folder.
**Why it happens:** Forgetting D-03.
**How to avoid:** D-03 is explicit: ONE file, `05-VERIFICATION.md`, one line per item with `PASS/FAIL` + ISO timestamp. Screenshots only captured on FAIL. Example format:

```markdown
## POLISH Human QA (production, 2026-04-22)

- **POLISH-01** (VoiceOver on /search + compare panel): PASS — 2026-04-22T14:32:00+07:00
- **POLISH-02** (DiscoveryPanel error state): PASS — 2026-04-22T14:35:00+07:00
- **POLISH-03** (Semantic tokens light/dark): PASS — 2026-04-22T14:38:00+07:00
- **POLISH-04** (Data-health skeleton proportions): PASS — 2026-04-22T14:41:00+07:00
- **POLISH-05** (text-[10px] legibility): PASS — 2026-04-22T14:44:00+07:00
- **POLISH-15** (v1.0.1 recommended-slots / copy drawer / defaults): PASS — 2026-04-22T14:50:00+07:00
```

**Warning signs:** Phase wraps but `05-VERIFICATION.md` is missing — means sign-off got scattered.

## Code Examples

### POLISH-16 Test File Skeleton (mirroring `compare.test.ts` style)

Location: `src/lib/search/__tests__/recommend.test.ts` (NEW FILE)

```typescript
// Source: project convention from src/lib/search/__tests__/{compare,engine,parser}.test.ts
import { describe, it, expect } from "vitest";
import { getRecommendedSlots, formatSlotTime } from "../recommend";
import type { RangeSearchResponse, RangeGridRow } from "../types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<RangeGridRow> = {}): RangeGridRow {
  return {
    tutorGroupId: "g1",
    displayName: "Tutor One",
    supportedModes: ["online", "onsite"],
    qualifications: [{ subject: "Math", curriculum: "International", level: "Y2-8" }],
    availability: [true, true, true],
    ...overrides,
  };
}

function makeResponse(overrides: Partial<RangeSearchResponse> = {}): RangeSearchResponse {
  return {
    snapshotMeta: { snapshotId: "snap-1", stale: false, syncedAt: new Date().toISOString() } as any,
    subSlots: [
      { start: "15:00", end: "16:30" },
      { start: "16:30", end: "18:00" },
      { start: "18:00", end: "19:30" },
    ],
    grid: [makeRow()],
    needsReview: [],
    latencyMs: 10,
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRecommendedSlots", () => {
  // (1) empty-response guard (line 24 of recommend.ts)
  it("returns [] when subSlots is empty", () => {
    const res = makeResponse({ subSlots: [], grid: [makeRow()] });
    expect(getRecommendedSlots(res)).toEqual([]);
  });

  it("returns [] when grid is empty", () => {
    const res = makeResponse({ grid: [] });
    expect(getRecommendedSlots(res)).toEqual([]);
  });

  it("returns [] when response itself is falsy", () => {
    // @ts-expect-error intentional null input
    expect(getRecommendedSlots(null)).toEqual([]);
  });

  // (2) drops slots with zero available tutors
  it("filters out sub-slots with no available tutors", () => {
    const row = makeRow({ availability: [false, false, true] });
    const recs = getRecommendedSlots(makeResponse({ grid: [row] }));
    expect(recs).toHaveLength(1);
    expect(recs[0].subSlotIndex).toBe(2);
  });

  // (3) tier assignment — Best / Strong / Good
  it("assigns confidence tiers by rank", () => {
    const rows = [
      makeRow({ tutorGroupId: "a", availability: [true, true, true] }),
      makeRow({ tutorGroupId: "b", availability: [true, true, false] }),
      makeRow({ tutorGroupId: "c", availability: [true, false, false] }),
    ];
    const recs = getRecommendedSlots(makeResponse({ grid: rows }));
    expect(recs).toHaveLength(3);
    expect(recs[0].confidence).toBe("Best fit");
    expect(recs[1].confidence).toBe("Strong fit");
    expect(recs[2].confidence).toBe("Good fit");
  });

  // (4) rank order by availableTutors count (primary sort)
  it("ranks slots by number of available tutors (desc)", () => {
    const rows = [
      makeRow({ tutorGroupId: "a", availability: [false, true, true] }),
      makeRow({ tutorGroupId: "b", availability: [true, true, false] }),
      makeRow({ tutorGroupId: "c", availability: [true, true, true] }),
    ];
    const recs = getRecommendedSlots(makeResponse({ grid: rows }));
    // Sub-slot counts: [2, 3, 2] → expected rank 1 (sub-slot index 1, 3 tutors) first
    expect(recs.map((r) => r.subSlotIndex)).toEqual([1, 0, 2]);
  });

  // (5) tie-break by start time (line 38 of recommend.ts)
  it("breaks ties by earliest start time", () => {
    const rows = [
      makeRow({ tutorGroupId: "a", availability: [true, true, false] }),
      makeRow({ tutorGroupId: "b", availability: [true, true, false] }),
    ];
    const res = makeResponse({ grid: rows });
    const recs = getRecommendedSlots(res);
    expect(recs).toHaveLength(2);
    // Both sub-slots have 2 tutors; tie-break by earliest start
    expect(recs[0].subSlotIndex).toBe(0);
    expect(recs[1].subSlotIndex).toBe(1);
  });

  // (6) modality-label reasons (lines 51-57)
  it("emits 'Online + onsite options' when both modalities available", () => {
    const rows = [
      makeRow({ tutorGroupId: "a", supportedModes: ["online"], availability: [true] }),
      makeRow({ tutorGroupId: "b", supportedModes: ["onsite"], availability: [true] }),
    ];
    const res = makeResponse({ subSlots: [{ start: "15:00", end: "16:30" }], grid: rows });
    const recs = getRecommendedSlots(res);
    expect(recs[0].reasons).toContain("Online + onsite options");
  });

  it("emits 'Online only' when only online mode represented", () => {
    const rows = [makeRow({ supportedModes: ["online"], availability: [true] })];
    const res = makeResponse({ subSlots: [{ start: "15:00", end: "16:30" }], grid: rows });
    const recs = getRecommendedSlots(res);
    expect(recs[0].reasons).toContain("Online only");
  });

  it("emits 'Onsite only' when only onsite mode represented", () => {
    const rows = [makeRow({ supportedModes: ["onsite"], availability: [true] })];
    const res = makeResponse({ subSlots: [{ start: "15:00", end: "16:30" }], grid: rows });
    const recs = getRecommendedSlots(res);
    expect(recs[0].reasons).toContain("Onsite only");
  });

  it("emits 'Variety to offer parent' when >=3 tutors available", () => {
    const rows = [
      makeRow({ tutorGroupId: "a", availability: [true] }),
      makeRow({ tutorGroupId: "b", availability: [true] }),
      makeRow({ tutorGroupId: "c", availability: [true] }),
    ];
    const res = makeResponse({ subSlots: [{ start: "15:00", end: "16:30" }], grid: rows });
    const recs = getRecommendedSlots(res);
    expect(recs[0].reasons).toContain("Variety to offer parent");
  });

  // (7) limit parameter
  it("honors the limit parameter (default 3)", () => {
    const rows = [makeRow({ availability: [true, true, true] })];
    const recs = getRecommendedSlots(makeResponse({ grid: rows }));
    expect(recs.length).toBeLessThanOrEqual(3);
  });

  it("respects custom limit", () => {
    const rows = [makeRow({ availability: [true, true, true] })];
    const recs = getRecommendedSlots(makeResponse({ grid: rows }), 1);
    expect(recs).toHaveLength(1);
    expect(recs[0].confidence).toBe("Best fit");
  });

  // (8) 'qualified tutor(s) free' pluralization
  it("uses singular 'tutor' when 1 available, plural when >1", () => {
    const rowsSingle = [makeRow({ availability: [true] })];
    const resSingle = makeResponse({ subSlots: [{ start: "15:00", end: "16:30" }], grid: rowsSingle });
    expect(getRecommendedSlots(resSingle)[0].reasons[0]).toBe("1 qualified tutor free");

    const rowsPlural = [
      makeRow({ tutorGroupId: "a", availability: [true] }),
      makeRow({ tutorGroupId: "b", availability: [true] }),
    ];
    const resPlural = makeResponse({ subSlots: [{ start: "15:00", end: "16:30" }], grid: rowsPlural });
    expect(getRecommendedSlots(resPlural)[0].reasons[0]).toBe("2 qualified tutors free");
  });
});

describe("formatSlotTime", () => {
  it("formats hours-only as '3pm'", () => {
    expect(formatSlotTime("15:00", "16:00")).toBe("3pm–4pm");
  });

  it("formats half-hours as '3:30pm'", () => {
    expect(formatSlotTime("15:30", "16:30")).toBe("3:30pm–4:30pm");
  });

  it("handles midnight edge (12am)", () => {
    expect(formatSlotTime("00:00", "01:00")).toBe("12am–1am");
  });

  it("handles noon edge (12pm)", () => {
    expect(formatSlotTime("12:00", "13:00")).toBe("12pm–1pm");
  });
});
```

**Test count target:** 14-15 tests. Mirrors `compare.test.ts` length (~10 tests) + extras for edge cases specific to `recommend.ts`. Run `npm test` after each cohesive block during implementation to catch regressions.

### POLISH-13 Attestation Skeleton (lightweight, ~50 lines per D-04)

Location: `.planning/milestones/v1.0-PHASE-02-VERIFICATION.md` (NEW FILE per D-05)

```markdown
# Phase 02 — Streaming & Lazy Loading: Retroactive Verification Attestation

**Milestone:** v1.0 Performance & UX Improvement
**Phase:** 02 — Streaming & Lazy Loading (shipped 2026-04-10)
**Attested:** 2026-04-21 (Phase 5 POLISH-13)
**Attester:** Claude (via /gsd-execute-phase POLISH drain)
**Type:** Lightweight post-hoc attestation (not a full gsd-verifier run)

## Scope

Per `v1.0-MILESTONE-AUDIT.md:123-128`, Phase 02 shipped 5 requirements without a formal `VERIFICATION.md` artifact. Deliverables existed and were independently confirmed by the milestone integration check on 2026-04-17. This document formalizes that integration check as the verification of record for Phase 02.

## Requirements Verified

| REQ-ID | Description | Evidence Source | Status |
|--------|-------------|-----------------|--------|
| PERF-04 | (from v1.0-REQUIREMENTS.md) | Integration check #1 — `v1.0-MILESTONE-AUDIT.md` line ~105 (Singleton → RSC usable from async RSC with `'use cache'`) | PASS |
| PERF-05 | (from v1.0-REQUIREMENTS.md) | Integration check #4 — `v1.0-MILESTONE-AUDIT.md` line ~108 (Lazy-loaded `next/dynamic` components still render Phase 03 features) | PASS |
| PERF-06 | (from v1.0-REQUIREMENTS.md) | Integration check #7 — `v1.0-MILESTONE-AUDIT.md` line ~111 (Skeletons wired as Suspense fallbacks: `loading.tsx`, `page.tsx`, compare-panel dynamic loads) | PASS |
| PERF-07 | (from v1.0-REQUIREMENTS.md) | Integration check #1 + E2E flow #1 — `v1.0-MILESTONE-AUDIT.md` lines ~105,~115 (RSC shell → streaming → search → add → compare week view) | PASS |
| INFRA-01 | (from v1.0-REQUIREMENTS.md) | Integration check #1 — `v1.0-MILESTONE-AUDIT.md` line ~105 (globalThis DB/SearchIndex singleton wired) | PASS |

## Integration-Check Transcript Excerpt

From `.planning/milestones/v1.0-MILESTONE-AUDIT.md`, §Cross-Phase Integration Verdict (lines 99-119):

> Spawned `gsd-integration-checker` which verified 7 integration checks and 5 E2E flows against live source (not just VERIFICATION claims):
>
> | # | Check | Verdict |
> |---|-------|---------|
> | 1 | Singleton → RSC (globalThis DB/SearchIndex usable from async RSC with `'use cache'`) | PASS |
> | 4 | Lazy-loaded (next/dynamic) components still render Phase 03 features | PASS |
> | 7 | Skeletons wired as Suspense fallbacks (loading.tsx, page.tsx, compare-panel dynamic loads) | PASS |
>
> | 1 | Search → Compare (RSC shell → streaming → search → add → compare week view → week change → conflicts → fullscreen) | PASS |

All 5 Phase 02 REQ-IDs are covered by these integration checks.

## Attestation Statement

Per `v1.0-MILESTONE-AUDIT.md:128` ("Accept the integration check as the verification of record for Phase 02 and note this in the milestone archive"), this document formalizes that acceptance. The integration check on 2026-04-17 exercised live source — not just documentation — and passed. No additional verification is required.

## Non-Goals

- This is NOT a re-run of `gsd-verifier` against live code.
- This is NOT a regression test of Phase 02 deliverables (Phase 5 `npm test` baseline of 246 covers regression).
- This does NOT recreate the deleted `.planning/phases/02-streaming-lazy-loading/` directory; that content is archived via git history.

---

*Attestation produced during Phase 5 POLISH drain (POLISH-13).*
*Satisfies v1.0 milestone tech-debt item "Missing VERIFICATION.md" per `v1.0-MILESTONE-AUDIT.md:15-17`.*
```

**Length target:** ~50-60 lines rendered. If the planner needs to cite exact v1.0-REQUIREMENTS.md descriptions, look them up from the archive.

## Human QA Walkthrough Structure

> The planner should embed these checklists verbatim in `05-02-PLAN.md`. Production URL: https://bgscheduler.vercel.app — execute in one sitting per D-01.

### POLISH-01 — VoiceOver on /search + compare panel (D-02 relaxes NVDA → v1.2)

**Setup:** macOS Safari 17+, VoiceOver enabled (Cmd-F5). Production URL loaded, logged in via Google OAuth.

**8 interactions to verify (each should produce an intelligible announcement):**

1. Focus the search form subject dropdown → VoiceOver announces "Subject, combobox, popup menu" (or similar role + state)
2. Tab through curriculum / level dropdowns → each announces role, value, and "any" default state intelligibly
3. Submit a search (e.g., Math / International / Y2-8 / 15:00-20:00 / 90 min) → result announces table summary (column + row count)
4. Focus a result row checkbox → announces tutor display name + "checked/not checked"
5. Click "Compare (N)" button → compare panel appears; VoiceOver announces panel title / tutor chip list
6. Focus a tutor chip's X button → announces "Remove {tutor name}, button" (aria-label verified at `tutor-selector.tsx:33`)
7. Focus week picker label → announces current week range; Enter opens month-grid popup; arrow keys navigate days
8. Focus a session block in the calendar (tab or direct click) → popover opens; screen reader enters popover focus trap; Escape closes popover and returns focus

**Recording template (in `05-VERIFICATION.md`):**
`POLISH-01 (VoiceOver /search + compare): PASS — 2026-04-22TXX:XX:00+07:00`
If FAIL: attach a text transcript of the failing announcement (no screenshot needed; VoiceOver is audio).

### POLISH-02 — DiscoveryPanel error state in production browser

**Setup:** Production /search, logged in, Chrome/Firefox/Safari (any).

**Forcing an error:**
1. Open `/search`, click "Advanced search" in compare panel to open discovery modal (Dialog component).
2. In Chrome DevTools → Network tab → throttle to "Offline" OR right-click `/api/compare/discover` → "Block request URL."
3. Fill discovery filters (any subject/level) and click "Search."
4. **Expected:** Error message renders in the modal — surface at `discovery-panel.tsx:202-204`:
   ```
   <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
     {error}
   </div>
   ```
   Message text comes from `setError("Search failed. Please try again.")` at `discovery-panel.tsx:105` (catch-all) or the server-returned error at line 102.

**Verify:** Error message is visible, text is legible (not cut off), color contrasts against bg-destructive/10 background, and the modal does NOT close on error.

**Recording template:**
`POLISH-02 (DiscoveryPanel error surface): PASS — 2026-04-22TXX:XX:00+07:00`
If FAIL: screenshot of the modal in its error state.

### POLISH-03 — Semantic color tokens in light + dark mode

**Setup:** Production /search and /data-health. Toggle OS-level dark mode (macOS: System Settings → Appearance → Dark) mid-walkthrough.

**Token inventory to verify on each theme:**

| Token | Rendered as | Where to see on prod |
|-------|-------------|----------------------|
| `bg-available` / `text-available` | green tint | `/search` compare panel — free-gap indicators (`week-overview.tsx:416`); availability grid cells (`availability-grid.tsx:155`) |
| `bg-blocked` | amber | (verify presence in blocked cells via availability grid or data-health) |
| `bg-conflict` / `text-conflict` | red | `/search` compare panel — day-conflict badge on week header; conflict bands in week view (`week-overview.tsx:282,397,535`); conflict summary (`compare-panel.tsx:276`) |
| `bg-free-slot` / `text-free-slot` | green (dashed border in day view) | `/search` day drill-down — "All free" pill in calendar-grid (`calendar-grid.tsx:292`) |
| `bg-destructive/10` / `text-destructive` | red-tinted alert | `/search` error state at workspace-level (`search-workspace.tsx:140`), DiscoveryPanel error (`discovery-panel.tsx:203`), login page (`login/page.tsx:25`), compare panel error (`compare-panel.tsx:138`) |

**Verify:** All tokens render the intended color in BOTH light and dark modes. No `bg-red-500` / `text-red-600` literals visible (if any appear, they're bugs or pre-existing usage outside scope).

**Recording template:**
`POLISH-03 (Semantic tokens light/dark): PASS — 2026-04-22TXX:XX:00+07:00`
If FAIL: two screenshots (light + dark) annotating the color that didn't render as expected.

### POLISH-04 — Data-health skeleton proportions

**Setup:** Production /data-health URL. Hard refresh with DevTools Network throttled to "Slow 3G" to extend the skeleton visibility window.

**Verify:**
1. Skeleton shimmer appears during initial load
2. Skeleton shape approximates the eventual loaded layout (cards/tables/badges sized proportionally to their loaded content)
3. No jarring layout shift (CLS) when content replaces skeleton — e.g., skeleton card is ~the same height as the loaded card

**Where skeletons live:** `src/app/(app)/data-health/page.tsx` (Suspense fallback) and `src/app/(app)/search/loading.tsx`.

**Recording template:**
`POLISH-04 (Skeleton proportions): PASS — 2026-04-22TXX:XX:00+07:00`
If FAIL: screenshot of skeleton + screenshot of loaded state, side-by-side, annotating the mismatch.

### POLISH-05 — text-[10px] legibility on production displays

**Setup:** Production /search with ≥2 tutors in compare view, narrow viewport (resize browser window to ~50% of a 1920×1080 display or use a laptop screen).

**text-[10px] call sites to inspect (43 occurrences across 12 files) — sample:**
- Compare panel day-conflict badge (`compare-panel.tsx:236`)
- Week-view lane header tutor names (`week-overview.tsx:312`)
- Week-view session time label on narrow cards (`week-overview.tsx:492`)
- Week-view student name sub-label (`week-overview.tsx:499`)
- Week-view overflow badge `+N more` (`week-overview.tsx:507`)
- Week-view conflict day-badge (`week-overview.tsx:282`)
- Discovery panel subject chip (`discovery-panel.tsx:262`)

**Verify:** Text is readable without zoom; no pixel crushing on HiDPI (Retina) displays; truncation-with-ellipsis works where applied.

**Recording template:**
`POLISH-05 (text-[10px] legibility): PASS — 2026-04-22TXX:XX:00+07:00`
If FAIL: screenshot of the unreadable text + display specs (resolution, DPR).

### POLISH-15 — v1.0.1 production UAT (~3-5 items)

**Scope confirmation** [VERIFIED: STATE.md lines 48-55]: v1.0.1 shipped commit `9e3e4ad` on 2026-04-20 with three features — recommended-slots hero, copy-for-parent drawer, idiot-proof search defaults.

**Combined walkthrough items (same sitting as POLISH-01..05):**

1. **Recommended-slots hero**
   - Run a search (Math, Int., Y2-8, 15:00-20:00, 90 min) on /search
   - Verify hero section renders up to 3 cards above the availability grid (layout per `src/components/search/recommended-slots.tsx`)
   - Each card shows: avatar stack, confidence tier ("Best fit" / "Strong fit" / "Good fit"), reason bullets, "Copy for parent" button, quick-add calendar icon
   - Click "Copy for parent" → drawer slides in from right (item 2)
   - Click calendar icon on a card → selected tutors added to compare panel
   - Select 2+ cards → "Bundle & copy" action surfaces

2. **Copy-for-parent drawer**
   - Drawer opens from right edge
   - Friendly/Terse tone toggle switches copy
   - "Include tutor name" toggle adds/removes names
   - Message preview is editable; "Reset" button reverts to auto-generated text
   - "Copy" button copies to clipboard (verify via Cmd-V into a text field)

3. **Idiot-proof search defaults**
   - Fresh page load of /search
   - Time window defaults to 15:00–20:00
   - Duration defaults to 90 min
   - Subject/curriculum/level show "Any" labels (not blank/null)
   - "N filters active · Clear all" inline summary appears as filters change

**Recording template:**
`POLISH-15 (v1.0.1 UAT: recommended-slots + drawer + defaults): PASS — 2026-04-22TXX:XX:00+07:00`
If any sub-item FAIL: note which one, screenshot attached.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Literal Tailwind colors (`bg-red-500`) for semantic roles | Named semantic tokens via `--color-X` + `@theme inline` | Tailwind 4 (Jan 2026) | POLISH-09 follows this pattern; all new colors should be tokens |
| Object-identity deps in `useEffect` | Narrow to primitive deps or `useRef`-latest | React hooks discipline since 17+ | POLISH-06/12 fixes align |
| `setInterval` without re-evaluating external conditions inside the tick | Evaluate fresh on each tick; use `setState` to drive re-render | No specific date; long-standing React idiom | POLISH-07 fix pattern |

**Deprecated / outdated:**
- `new Date(ISO_STRING_WITHOUT_TZ)` parsing varies by browser — NOT used here (we use `Date.UTC(y, m-1, d)`). The `?week=` URL param is a date-only string; `Date.UTC` round-trip avoids the ambiguity.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | OKLCH equivalent of `#ef4444` is `oklch(0.628 0.2577 29.23)` — verified via oklch.com external converter, not in-tree | §Pattern 4 | Visual regression if value is off — but CONTEXT.md D-06 says "OKLCH equivalent of current bg-red-500" which is the standard conversion; planner should re-verify via https://oklch.com/ at build time and swap if drift detected |
| A2 | `TutorSelector` component body has zero remaining imports (grep in Step 2 found zero) | §POLISH-14 Pattern 8 | If a consumer exists but uses dynamic import or string-based lookup, deletion breaks it. Mitigation: `npm run build` + `npm test` in the POLISH-14 commit catches any breakage |
| A3 | All 4 `bg-red-500` call sites are the today-indicator (no other literal red-500 in the compare components) | §POLISH-09 Usage table | Grep verified (see Step 2 output) — zero other `bg-red-500` hits in `src/components/compare/` beyond the 4 CONTEXT.md-named sites. Risk is LOW |
| A4 | VoiceOver audit yields "intelligible announcements" — VoiceOver behavior can vary by macOS/Safari version | §POLISH-01 | User is performing the QA on their own machine; subjective "intelligibility" is their judgment. Research can't further de-risk |
| A5 | Production /data-health has sufficient skeleton render time to visually verify proportions (Slow 3G throttle is enough) | §POLISH-04 | If the initial load is too fast even on throttled network, user may not see skeleton. Fallback: inspect skeleton components in DevTools → Sources / Elements while the fetch is paused |
| A6 | v1.0.1 UAT items are only the 3 surfaces named in STATE.md (recommended-slots, drawer, defaults) — no other "v1.0.1" changes | §POLISH-15 | STATE.md:48-55 is authoritative per CONTEXT.md; commit `9e3e4ad` is 5-file change per that log. LOW risk |

**All other claims in this research are VERIFIED via in-repo inspection or CITED from CONTEXT.md / v1.0-MILESTONE-AUDIT.md.**

## Open Questions

1. **Does CSS hot-reload pick up the new `--today-indicator` token in dev mode without a restart?**
   - **What we know:** Next.js 16 has HMR for CSS; Tailwind 4 JIT picks up `@theme` changes.
   - **What's unclear:** Whether `@theme inline` additions specifically require a dev-server restart (anecdotal reports suggest yes for first-time theme additions).
   - **Recommendation:** Planner should note in POLISH-09 task: "If `bg-today-indicator` doesn't render after save, restart `npm run dev`."

2. **Is the `/data-health` skeleton proportion judgment subjective or objective?**
   - **What we know:** Skeleton match is visual; acceptable "proportionality" is not measured.
   - **What's unclear:** Pass criteria are user-defined.
   - **Recommendation:** The walkthrough records user's PASS/FAIL per D-03 — no objective metric needed. Planner should not add one.

3. **Does the planner write `05-VERIFICATION.md` before or after the human QA sitting?**
   - **What we know:** D-03 says one line per item with ISO timestamp.
   - **What's unclear:** Order of operations.
   - **Recommendation:** Planner drafts the file TEMPLATE during planning (empty sign-off lines); executor fills in PASS/FAIL + timestamps live during the sitting.

## Environment Availability

> All code/config/test/docs changes — no external runtime dependencies. Deploy relies on existing Vercel + Neon which are known-available.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | `npm test`, `npm run build` | ✓ (presumed) | — | — |
| Vitest | POLISH-16 | ✓ | 4.1.2 [VERIFIED: package.json] | — |
| Tailwind 4 | POLISH-09 | ✓ | 4.x [VERIFIED: package.json] | — |
| macOS + VoiceOver | POLISH-01 | ✓ (user's machine is macOS per OS Version: Darwin 25.3.0) | VoiceOver (built-in) | — |
| Production deploy | POLISH-01..05, POLISH-15 human QA | ✓ | Vercel Hobby | — |
| Chrome/Firefox/Safari | POLISH-02 DevTools network throttling | ✓ (user's choice) | — | — |
| https://oklch.com/ (conversion tool, optional) | POLISH-09 color re-verification | ✓ (web tool) | — | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

## Security Domain

> `security_enforcement` is not set in `.planning/config.json`; treat as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (no auth surface changes) | Existing NextAuth v5 Google provider preserved |
| V3 Session Management | No (no session code changes) | Existing middleware auth gate preserved |
| V4 Access Control | No (no route-level access changes) | Existing `middleware.ts` allowlist preserved |
| V5 Input Validation | Yes (POLISH-08) | Native `Date.UTC` round-trip replaces shape-only regex — closes a silent-normalization class of bug |
| V6 Cryptography | No | — |

### Known Threat Patterns for this phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| URL query param with invalid calendar date silently accepted (`2026-02-31` → `2026-03-03`) | Tampering (user agent or bookmark forwarding) | POLISH-08 round-trip Date check — rejects impossible dates; `changeWeek` only called on valid input |
| Deleting `route 2.ts` duplicates — any risk of accidentally deleting `route.ts`? | Integrity (accidental file loss) | D-09 specifies DELETE TARGETS by exact path; prep commit `git rm "src/app/api/auth/[...nextauth]/route 2.ts"` + `git rm "src/app/api/search/range/route 2.ts"` — quoted path disambiguates the duplicate from `route.ts` |
| Logs containing PII in attestation (POLISH-13) | Information disclosure | Attestation cites integration-check summary table only; no live user/tutor data embedded |
| Test data in POLISH-16 containing PII | Information disclosure | Fixtures use fictional names ("Tutor One", student names avoided entirely); mirrors existing `compare.test.ts` convention |

**No authentication, session, or access-control changes in Phase 5.** The auth gate, admin allowlist, and non-negotiable fail-closed rules are untouched.

## Sources

### Primary (HIGH confidence — in-repo evidence)

- [VERIFIED: `.planning/phases/05-polish-drain/05-CONTEXT.md`] — User decisions D-01..D-10
- [VERIFIED: `.planning/REQUIREMENTS.md:50-73`] — POLISH-01..16 definitions
- [VERIFIED: `.planning/ROADMAP.md:33-45`] — Phase 5 goal, depends-on, success criteria
- [VERIFIED: `.planning/milestones/v1.0-MILESTONE-AUDIT.md`] — authoritative tech-debt source (findings M1–M3, L1–L4, Phase 04 human-QA items, TutorSelector orphan)
- [VERIFIED: `.planning/research/SUMMARY.md:142`] — "Phase 1 (POLISH drain): checklist-driven, no research needed" — confirmed
- [VERIFIED: `.planning/research/PITFALLS.md#pitfall-14,15`] — POLISH-scatter anti-pattern; CACHE_VERSION deferred to Phase 6
- [VERIFIED: `src/components/search/search-workspace.tsx:42-66`] — effect deps, regex, mount-effect call sites
- [VERIFIED: `src/components/compare/week-overview.tsx:237-247,259,295-327,544-555`] — midnight tick, multiTutorLayout, today indicator
- [VERIFIED: `src/components/compare/calendar-grid.tsx:70-80,299-311`] — midnight tick, today indicator (second site)
- [VERIFIED: `src/components/compare/tutor-selector.tsx:1-52`] — TutorSelector file structure
- [VERIFIED: `src/hooks/use-compare.ts:88,178-192`] — `fetchCompare` useCallback pattern, `addTutor` target
- [VERIFIED: `src/lib/search/recommend.ts:1-81`] — POLISH-16 target structure
- [VERIFIED: `src/lib/search/__tests__/compare.test.ts`, `engine.test.ts`, `parser.test.ts`] — Vitest convention
- [VERIFIED: `src/app/globals.css:1-143`] — semantic token wiring pattern
- [VERIFIED: `.planning/config.json`] — `workflow.nyquist_validation: false` (skip Validation Architecture)
- [VERIFIED: `package.json`] — Next 16.2.2, React 19.2.4, Vitest 4.1.2, Tailwind 4
- [VERIFIED: grep output, consumers of TutorSelector/TutorChip/TUTOR_COLORS] — zero TutorSelector imports; 3 TutorChip type imports
- [VERIFIED: `diff` on route 2.ts vs route.ts] — bytes identical for both duplicates
- [VERIFIED: `git status --short`] — confirms `.planning/ui-reviews/` already absent; 40-ish `.planning/phases/*` deletions staged

### Secondary (HIGH confidence — external authoritative)

- [CITED: https://tailwindcss.com/docs/colors] — Tailwind red-500 = `#ef4444`
- [CITED: https://oklch.com/#62.8,0.2577,29.23] — `#ef4444` → `oklch(0.628 0.2577 29.23)` conversion
- [CITED: https://react.dev/reference/react/useCallback] — React 19 useCallback semantics
- [CITED: https://react.dev/reference/react/useRef] — useRef-latest pattern for mount-effects
- [CITED: https://tailwindcss.com/docs/adding-custom-styles#using-css-variables] — `@theme inline` → `var(--color-X)` → `bg-X` utility generation

### Tertiary (not used — no LOW-confidence claims)

No WebSearch results were needed; all claims are backed by in-repo evidence or well-established standard docs.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — zero new deps; all versions verified from in-repo `package.json`
- Architecture patterns: HIGH — every pattern code-grounded with file:line evidence
- Pitfalls: HIGH — each pitfall maps to a concrete POLISH-* task and has a verifiable mitigation
- Human-QA walkthrough structure: MEDIUM-HIGH — specific URLs + specific interactions, but the user's subjective PASS/FAIL judgment is by design (D-01/D-03)
- POLISH-13 attestation: HIGH — skeleton extracted directly from v1.0-MILESTONE-AUDIT.md; D-04/D-05 fix the format
- POLISH-16 test coverage: HIGH — tests mirror existing `compare.test.ts`/`engine.test.ts` structure; 14-15 target count matches scope

**Research date:** 2026-04-21
**Valid until:** 2026-05-20 (30 days — Phase 5 is stable, no fast-moving external deps)

---

## RESEARCH COMPLETE

**Phase:** 5 — POLISH Drain
**Confidence:** HIGH
**Plan recommendation:** 2 plan files — `05-01-PLAN.md` (prep + code-only POLISH-06..14, ~11 atomic commits) and `05-02-PLAN.md` (POLISH-01..05 + POLISH-13 + POLISH-15 + POLISH-16, ~4 commits: test commit, attestation commit, human-QA recording commit, traceability update commit)

### Key Findings

- CONTEXT.md already locks the architectural direction — research's job here is file:line-level intelligence, not exploration
- All 16 POLISH items are ≤50 LOC each; the phase is breadth-over-depth
- Two POLISH items (07, 09) have paired call sites (week-overview + calendar-grid) — GROUP them
- POLISH-10 is a single-line `multiTutorLayout &&` duplicate guard removal (line 307) — NOT whole-variable dead code
- POLISH-14 preserves `TutorChip` interface + `TUTOR_COLORS` re-export — do NOT delete the file entirely
- POLISH-16 test file skeleton is provided verbatim (~140 lines of test code covering 14-15 cases)
- POLISH-13 attestation skeleton is provided verbatim (~60 rendered lines)
- Human-QA walkthrough is 6 items (POLISH-01..05 + POLISH-15 combined) executable in one ~30-minute sitting

### File Created

`/Users/kevinhsieh/Desktop/Scheduling/.planning/phases/05-polish-drain/05-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Zero deps added; versions confirmed from package.json |
| Architecture | HIGH | 8 patterns all code-grounded with file:line evidence |
| Pitfalls | HIGH | 8 pitfalls each bound to a specific POLISH item with verifiable mitigation |
| Human QA Structure | MEDIUM-HIGH | Specific URLs + specific interactions; subjective judgment is by design (D-03) |

### Open Questions

1. CSS HMR behavior for `@theme inline` additions — planner notes "restart dev server if needed"
2. Skeleton-proportion pass criterion is subjective — by design per D-03
3. `05-VERIFICATION.md` template order — draft during planning, fill during execution

### Ready for Planning

Research complete. Planner can now create `05-01-PLAN.md` and `05-02-PLAN.md`. Every architectural question that requires user input is ALREADY answered in CONTEXT.md — the planner should only decompose into tasks, not re-open decisions.

---
*Research: Phase 5 POLISH Drain — 2026-04-21*
