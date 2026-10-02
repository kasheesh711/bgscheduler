# Fix the misleading "The forward scan failed" incidents

## Context

The autowriter dashboard's "What needs you" list showed three critical items, all titled **"The forward scan failed"**:
two about Lukas's guided post (style reviewer had no verdict, then flagged a style correction) and one about the
Atom collector (`collection_failed`, the transient 2 Oct incident already handled by draft PR #139).

No forward scan exists yet (it is dashboard PR 3, not built). Two newer jobs reuse the incident kind `scan_failed`
because the table's CHECK constraint only allows the eight original kinds:

- `src/lib/feedback-autowriter/atom/collector.ts:142` — Atom collection failure
- `src/lib/feedback-autowriter/iseb-review.ts:52` — guided post missing source evidence / factual verdicts
- `src/lib/feedback-autowriter/iseb-review.ts:87` — style review flagged or unavailable

`src/lib/feedback-autowriter/inbox.ts:74` maps `scan_failed` → "The forward scan failed", so all three get that title
(inbox list and `item-drawer.tsx:386`).

Owner decisions (2 Oct):
1. Give each source its own incident kind via a migration (not a title-only hack).
2. A style check result (flagged, or checker unavailable) is **dashboard-only** — no email, does not keep the review
   job red. Facts were already judged before posting; the checker retries itself after 6 h.
3. Scope = this fix only; no diagnosis of Lukas's post.

Not decided by the owner, so kept as today: Atom collection failure stays **critical**; "guided post missing source
evidence or factual verdicts" stays **critical** (that is closer to an unverifiable post than a style nit).

## Approach

Work in `.claude/worktrees/slot-a` or `slot-b` (worktree policy), branch `fix/autowriter-incident-kinds` from
`origin/main` (the main checkout is on an old branch with unrelated dirty tutor-attendance work — don't touch it).
Start through `/gsd-quick`.

### 1. Migration `drizzle/0110_feedback_autowriter_incident_kinds.sql` (+ journal entry idx 110)

- Drop and re-add the kind CHECK on `feedback_autowriter_incidents` (inline check from 0101 →
  auto-named `feedback_autowriter_incidents_kind_check`; confirm name against a fresh 0101 DB in the integration
  container; use `DROP CONSTRAINT IF EXISTS`). New allowed set = the old eight + `atom_collection_failed`,
  `style_review_flagged`, `style_review_unavailable`, `style_review_source_missing`. Keep `scan_failed` for the
  future forward scan.
- Relabel existing rows by dedupe-key prefix:
  - `atom-collection:%` → `atom_collection_failed`
  - `iseb-review-source:%` → `style_review_source_missing`
  - `iseb-style:%:flagged` → `style_review_flagged`; `iseb-style:%:unavailable` → `style_review_unavailable`
- For the two style kinds: `severity = 'info'`, and `push_status = 'not_required'`, `next_push_at = null` where
  `push_status = 'pending'` (stops retrying alerts that are now dashboard-only; already-sent/acknowledged rows keep
  their history).
- Hand-write the SQL (drizzle snapshot drift — don't trust `db:generate`); `when` greater than 0109's 1790865000000.

### 2. Schema + writers

- `src/lib/db/schema.ts` (~6484): add the four kinds to the `kind` `$type<…>` union.
- `atom/collector.ts:144`: `kind: "atom_collection_failed"` (severity critical unchanged). Note: draft PR #139
  (`fix/atom-timetable-transition`) edits the same `recordIncident` call — whichever merges second rebases.
- `iseb-review.ts:52`: `kind: "style_review_source_missing"` (critical).
- `iseb-review.ts:87-91`: `kind: status === "flagged" ? "style_review_flagged" : "style_review_unavailable"`,
  `severity: "info"`. Dedupe keys unchanged so no duplicate rows appear after deploy.

### 3. Titles and "dashboard only" visibility

- `inbox.ts` `INCIDENT_TITLES`: add
  - `atom_collection_failed: "Atom lesson collection failed"`
  - `style_review_flagged: "A guided post needs a style fix"`
  - `style_review_unavailable: "A guided post's style check could not run"`
  - `style_review_source_missing: "A guided post is missing its evidence or fact checks"`
  - keep `scan_failed: "The forward scan failed"`.
- `buildInbox` lists only critical incidents today, so an info style incident would vanish from "What needs you" and
  only appear under System details → "Incidents and the review job". "Dashboard only" should still be visible:
  list **unacknowledged `style_review_flagged`** incidents in the inbox with urgency `normal` (not `critical`),
  after the critical incidents group; keep `style_review_unavailable` out of the inbox (System details only — it
  retries itself and a later flagged/passed result supersedes it). Update the `buildInbox` JSDoc ordering.
- `countUndeliveredCritical` / the drain already ignore info rows (`pushStatus = not_required`) — verify, no change.

### 4. Tests

- `src/lib/feedback-autowriter/__tests__/inbox.test.ts`: titles for the four new kinds; style-flagged info incident
  listed with `normal` urgency; style-unavailable info not listed; existing `scan_failed` case still titled.
- Existing collector / iseb-review unit tests (find under `src/lib/feedback-autowriter/**/__tests__`): assert new
  kind + severity in the `recordIncident` calls.
- Migration check in the autowriter integration suite if one covers incidents; otherwise a small Testcontainers
  test that applies migrations, inserts rows with the old kind/dedupe keys before 0110, and asserts relabel +
  severity/push_status changes.

## Verification

1. `npx vitest run src/lib/feedback-autowriter` (Node 22: `/opt/homebrew/opt/node@22/bin`), then `npm test`,
   `npm run typecheck`, `npm run test:integration` for the migration test.
2. Render the inbox with fixtures (`scripts/dev/render-autowriter-dashboard.mjs`) containing one of each new kind;
   screenshot to show the owner the new titles and that the style flag sits below criticals as non-red.
3. Open a **draft** PR; independent code review; owner OK before applying 0110 to prod (`DATABASE_URL=... npm run
   db:migrate`, migration first, then merge via `gh pr update-branch` → 5 checks → `gh pr merge --merge`).
4. After deploy: dashboard shows the three existing items retitled (Atom → "Atom lesson collection failed",
   Lukas's two → style kinds, no longer red); read-only query confirms no `pending` push on style rows.
