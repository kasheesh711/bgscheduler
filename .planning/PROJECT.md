# BGScheduler — Performance & UX Improvement

## What This Is

A performance and UX overhaul of the existing BGScheduler tutor scheduling tool (bgscheduler.vercel.app). The goal is to make data loading near-instant across all views, streamline the search-to-compare workflow into a seamless experience with fewer clicks, and improve calendar readability when multiple tutors are displayed — all without regressing any current functionality. The primary users are non-technical admin staff who need to self-serve tutor comparisons without asking for help.

## Core Value

Admin staff can find, compare, and schedule tutors instantly and independently — no waiting, no confusion, no handholding.

## Requirements

### Validated

- ✓ Google OAuth login with admin email allowlisting — existing
- ✓ Daily Wise API sync with atomic snapshot promotion — existing
- ✓ In-memory search index with stale detection — existing
- ✓ Range search with recurring/one-time modes — existing
- ✓ Qualification and modality filtering — existing
- ✓ Compare up to 3 tutors with week-scoped schedules — existing
- ✓ Conflict detection (same student overlap) — existing
- ✓ Shared free slot computation — existing
- ✓ Client-side tutor cache with incremental fetch — existing
- ✓ GCal-style weekly calendar grid — existing
- ✓ Discovery modal for finding candidate tutors — existing
- ✓ Data health dashboard — existing
- ✓ Fail-closed safety (unresolved → Needs Review) — existing

### Active

- [ ] Near-instant data loading across initial page load, search results, and compare view
- [ ] Unified search+compare workspace that reduces clicks to compare tutors
- [ ] Clear visual separation between days when multiple tutors are displayed in the calendar
- [ ] Calendar readability improvements for admin staff (tutor lanes distinguishable at a glance)

### Out of Scope

- Mobile/tablet responsive redesign — web-first for admin staff on desktop
- Color palette changes — sky blue palette stays per user preference
- Calendar grid layout overhaul — GCal-style weekly grid stays per user preference
- Wise API or sync pipeline changes — data layer is working and not the bottleneck
- New feature additions (notifications, reporting, etc.) — this is a polish/perf milestone

## Context

- **Live production app** at bgscheduler.vercel.app with 8 allowlisted admin users
- **Stack**: Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui, Drizzle ORM, Neon Postgres, Vercel hosting
- **Current architecture**: In-memory search index singleton, all search/compare queries run against it. Client-side tutor cache with incremental fetch already exists.
- **User feedback**: Admin staff find the calendar hard to read when multiple tutors are shown — tutor lanes within each day blur together visually. The workflow from search to compare involves too many clicks. Everything feels sluggish.
- **Brownfield**: Extensive existing codebase with 82 passing tests. All changes must be backward-compatible.

## Constraints

- **Stack**: No stack changes — Next.js 16, Tailwind, shadcn/ui, Drizzle, Neon Postgres
- **Deployment**: Vercel Hobby plan (daily cron, 300s function timeout)
- **Data integrity**: Fail-closed safety rules are non-negotiable
- **Visual**: Keep GCal-style calendar grid and sky blue color palette
- **Regression**: All 82 existing tests must continue to pass

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep GCal-style grid | User preference, familiar to staff | — Pending |
| Keep sky blue palette | User preference, already polished | — Pending |
| Target near-instant feel | Admin staff self-service requires zero friction | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-16 after Phase 4 completion*
