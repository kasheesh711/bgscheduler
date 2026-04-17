# Roadmap: BGScheduler

## Milestones

- ✅ **v1.0 Performance & UX Improvement** — Phases 1–4 (shipped 2026-04-17) — see [MILESTONES.md](MILESTONES.md)

## Phases

<details>
<summary>✅ v1.0 Performance & UX Improvement (Phases 1–4) — SHIPPED 2026-04-17</summary>

- [x] Phase 1: Component Architecture (3/3 plans) — completed 2026-04-10
- [x] Phase 2: Streaming & Lazy Loading (3/3 plans) — completed 2026-04-10
- [x] Phase 3: Calendar Readability & Workflow Polish (3/3 plans) — completed 2026-04-17
- [x] Phase 4: UI Audit Polish (2/2 plans) — completed 2026-04-17

Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

## Next Milestone

No milestone in progress. Start the next one with:

```
/gsd-new-milestone
```

This will guide questioning → research → requirements → new roadmap.

### v1.1 Candidate Backlog

Sourced from the v1.0 audit (tech debt) and the v2 requirements section of `milestones/v1.0-REQUIREMENTS.md`. None are committed until `/gsd-new-milestone` produces a fresh REQUIREMENTS.md.

- Phase 04 human QA sign-off — screen-reader announcement (VoiceOver/NVDA), discovery-panel browser error state, semantic-color rendering light/dark, data-health skeleton proportions, text-[10px] legibility
- Phase 02 retroactive `VERIFICATION.md` (process cleanup)
- Phase 03 polish findings — URL-sync effect memoization (M1), midnight crossover for today indicator (M2), strict `?week=` validation (M3), semantic token for today line (L1), `useCallback` for `addTutor` (L3), drop duplicate multiTutorLayout guard (L2), mount-effect stale-closure fix (L4)
- Remove unused `TutorSelector` component body at `src/components/compare/tutor-selector.tsx:19`
- v2 visual polish carry-forward — VPOL-01 view transitions, VPOL-02 sticky tutor legend, VPOL-03 mini-map density overview
- v2 advanced workflow carry-forward — AWRK-01 inline free-slot actions, AWRK-02 conflict resolution suggestions, AWRK-03 drag-to-select

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Component Architecture | v1.0 | 3/3 | Complete | 2026-04-10 |
| 2. Streaming & Lazy Loading | v1.0 | 3/3 | Complete | 2026-04-10 |
| 3. Calendar Readability & Workflow Polish | v1.0 | 3/3 | Complete | 2026-04-17 |
| 4. UI Audit Polish | v1.0 | 2/2 | Complete | 2026-04-17 |
