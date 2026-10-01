# Task 6 — workforce analytics UI

Implemented by GPT-6.1 Sol on `codex/tutor-offboarding-workforce` in slot-a. Owned changes are confined to Tutor Offboarding Analytics UI and its tests. Domain types, routes, capture and calculations remain with their owners.

## Implementation

- Analytics now leads with monthly workforce counts and a Chart.js chart with separate labelled people and turnover-percentage axes. Selected-month cards follow the report's selected month; the monthly table exposes the calculation and contributor drilldown.
- Shared date, month, role, academic hierarchy and modality filters feed the report GET. Subject/curriculum/level expansion uses stable hierarchy keys. Subject heat maps use one color domain across the report months; unknown capacity is visibly different from confirmed zero. Average-week cell labels expose monthly totals and supported weekday occurrences.
- Overall shared supply is displayed once. Subject rows explicitly overlap. Student bookings and booked demand are not represented as unmet demand.
- Individual utilization supports search, sorting with missing values last, three named rates, visible over-100% values and outside-hours/overlap flags. Detail shows monthly rates, Bangkok selected-week class evidence, retained observations and exceptions. Every rate formula uses the new coverage-matched numerator fields; full-range totals are labelled separately.
- Drilldowns and CSV exports refresh the report once before retrying a stale revision. AbortSignal plus a generation guard prevents late obsolete reads from replacing newer selections. Pagination replaces data if a new revision is returned, rather than mixing contributors from different revisions.
- Quality review lists source windows/timestamps, incomplete evidence and exact unmapped class labels/hours. Mapping writes require an explicit reviewed subject and checkbox, use expected revision, and never retry a stale write automatically. A saved mapping followed by failed report refresh presents a retry-refresh action instead of another save.
- Existing affected-course and departure scenario context remains in a disclosure. Its older proxy/stat cards are hidden in that context to avoid confusing them with monthly turnover. The original context clearly states that its fixed-history/tutor-only scope and scenario filters are separate. Existing removal UI is unchanged.

## MagicPath evidence

Skill read: `/Users/kevinhsieh/.codex/plugins/cache/openai-curated-remote/app-6a883213fb288191aa91f89a5db31f60/2.0.0/skills/magicpath/SKILL.md`.

- Project `456334090107518976`, “BeGifted · Tutor workforce analytics”. Project creation succeeded and canvas opened immediately before the code session.
- Component `456334160852819968`, revision `456334160852819969`; generated name `sharply-soil-1602`.
- Code session `mcs_db2551ee-eb3a-4317-9394-be939c42719b`; build job `456039307275292672-external-agent-456334948559896576`.
- Build status confirmed **completed**. Preview: https://storage.googleapis.com/storage.magicpath.ai/component-previews/f3fe54b2-e34f-4b60-9785-f000313ce42a.png
- Parent independently inspected the preview and reported clear hierarchy/spacing. Production chart explicitly labels both axes and selected-month cards avoid the synthetic sketch's month inconsistency.
- Only fictional names/classes/counts were uploaded. No production evidence, payments or student data was uploaded. No `.magicpath` file was created. Temporary root `component.tgz` was removed.

## Verification

Read local Next16 server/client-components, Cache Components and route-handler guides before implementation; reused installed Chart.js and existing chart tokens/atoms/Base UI Dialog.

RED run: new presentation/request tests initially failed to import missing implementation modules, before UI binding.

GREEN command (Node24):
`npx vitest run --project unit src/components/tutor-offboarding/workforce/__tests__ src/components/tutor-offboarding/__tests__/analytics.test.tsx --maxWorkers=2`

Result: **4 files, 21 tests passed**. Assertions cover shared-filter dependent reset, hierarchy expansion, one heat-map domain, unavailable versus zero, three utilization labels, 125% values, coverage-matched formulas, fictional 45-minute group-credit explanation, seven shared hours, cell monthly/support labels, source-quality explanations, GET/no-store/abort, malformed response, obsolete generation rejection, one stale-revision retry, and coherent fixture rate arithmetic. Existing Analytics tests remain green.

`npx eslint src/components/tutor-offboarding/workforce src/components/tutor-offboarding/analytics-tab.tsx`: passed, zero errors/warnings.

`npm run typecheck`: no UI errors; blocked only by four route/test imports of Task4's not-yet-created `workforce/service` module at the check time. Parent must rerun once Task4 is present.

`git diff --check -- src/components/tutor-offboarding/analytics-tab.tsx`: passed.

## Browser handoff

Ignored synthetic harness: `.tutor-offboarding/capacity-redesign/render-workforce.mjs`.
Build: `PATH=/Users/kevinhsieh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH node .tutor-offboarding/capacity-redesign/render-workforce.mjs --no-shot`.
Serve only public synthetic folder:
`python3 -m http.server 8768 --bind 127.0.0.1 --directory .tutor-offboarding/capacity-redesign/workforce-preview`

URL: http://127.0.0.1:8768/ . Variants `?view=stale` (one409 detail → fresh report → retry), `?view=error` (refresh503 retains old report), `?view=unavailable`, `?theme=dark`. Mapping review uses fictional local mock responses. `window.__workforceRequests` records read/write requests for QA without private data.

This agent's CUA inventory had no browser surfaces; parent has the browser surface and is performing desktop/narrow/keyboard/interaction checks. Parent confirmed the harness opens and caught fixture-only arithmetic mismatch; fixed and rebuilt before commit. Do not treat browser QA as complete until parent's checks finish.

## Remaining integration checks

- Parent: run final typecheck/full suite with completed service, independently review report calculations and mapping API integration, inspect 390px/desktop layouts and keyboard drawer focus/escape, verify exports and stale-detail flow.
- No growth metrics or placeholder values added; that separately approved design awaits implementation-plan approval.
- No local app build, production API call, environment change, push, migration or Wise write was performed by this UI lane.
