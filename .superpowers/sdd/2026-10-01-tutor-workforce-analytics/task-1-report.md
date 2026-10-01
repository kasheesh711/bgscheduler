# Task 1 — Wise source contracts

## Implementation

- Frozen shared workforce contracts are in `src/lib/tutor-offboarding/workforce/types.ts` (parent commit `528d7e06`).
- Added a bounded, GET-only Wise adapter in `src/lib/tutor-offboarding/workforce/wise-source.ts`. It reuses `WiseClient`'s queue and limiter, stops on 429, enforces a request cap and a 20-second per-request timeout, tiles historical dates into bounded DATE windows, continues after exact-full pages, checks page-count consistency, and deduplicates session IDs.
- Session facts preserve Wise class/session/tutor IDs and the exact session title. Missing title, interval, or tutor facts remain issues. Returned participant IDs are explicitly partial because the source does not prove removed historical students remain in `students`.
- Credit normalization uses only a single `SESSION` history row whose `_id` exactly matches the requested session as verified net credits. It ignores unrelated `CREDIT` balance movements. The owner-confirmed one-credit-per-scheduled-hour policy derives `normalCredits` from scheduled minutes; ambiguous refunds and missing net history remain unknown. Credit-example cap exhaustion does not invalidate complete session-date coverage.
- Added an operator probe at `scripts/probe-tutor-workforce-history.ts`. Every date/page/request/credit cap is explicit. It only emits aggregate status to stdout; optional detailed output is created with mode `0600`.

## Tests and checks

- RED check before the adapter: the requested Vitest command failed because `../wise-source` did not exist.
- GREEN check: `npx vitest run --project unit src/lib/tutor-offboarding/workforce/__tests__/wise-source.test.ts` — 7 tests passed. Fixtures cover exact page boundaries, duplicate IDs, absent historical participants, GET-only calls, seven-day availability limits, credit unknown states, and request-cap coverage behavior.
- `npm run typecheck` has no diagnostics in Task 1 files. The repository check remains blocked by concurrent Task 4/UI work: missing `workforce/service` and `dashboard` modules plus a route-test `WorkforcePersonRow` fixture mismatch.

## Bounded live source findings

Private outputs are ignored under `.tutor-offboarding/capacity-redesign/`:

- March 1–31, 2026: 36 GETs, 24 session pages, 2,343 sessions; session-date pagination complete. Ten credit examples yielded three exact matching `SESSION` entries and seven without a matching entry.
- September 24–30, 2026: 15 GETs, 8 session pages, 755 sessions; session-date pagination complete. Six credit examples yielded six exact matching `SESSION` entries: three had zero credits with `CANCELLED`, and three had one credit with `ENDED`. A two-participant group example was included.
- Credit history contains per-session `SESSION` rows and separate `CREDIT` movements. The sampled `CREDIT` rows must not be summed into session net. Verified net can be retained independently; expected historical normal credits were absent in all examples.
- No negative/refund example was found in these bounded samples. Refund interpretation remains unknown. The Wise response does not expose a normal-charge denominator; the owner-confirmed policy supplies it from scheduled duration.
- Availability returned a default schedule, timezone `Asia/Bangkok`, and a `workingHours` object with slots. The March sample returned the same default schedule over two separate seven-day requests (10 slots each). September was a single seven-day sample (7 slots).
- Historical membership is partial. Demand counts based on returned `students` must carry that limitation; current classroom membership was not substituted.

No Wise or database writes were made. The full raw samples, including IDs and exact labels, remain local and uncommitted.

## Owner-confirmed credit-hour rule update

After the bounded probes, the owner confirmed that one Wise credit always equals one scheduled teaching hour, including group and historical bookings. The adapter derives `normalCredits` from the scheduled interval (`scheduledMinutes / 60`) and adds `OWNER_CONFIRMED_ONE_CREDIT_PER_HOUR`; it does not derive duration from the charged-credit amount. The Wise endpoint itself does not expose that denominator. Verified session net and refund interpretation remain separate; unknown/ambiguous net remains null. Returned historical participant lists remain partial, so this policy alone does not make consumed-hours totals complete.
