# Feedback Autowriter dashboard redesign — design

Date: 2026-09-30. Owner: Kevin. Status: design approved in conversation (three parts), awaiting spec review.

Mockup (layout A, made-up data, designed by GPT-6.1 Sol):
[`assets/2026-09-30-autowriter-dashboard-mockup-a.png`](assets/2026-09-30-autowriter-dashboard-mockup-a.png)
(source: [`…-mockup-a.html`](assets/2026-09-30-autowriter-dashboard-mockup-a.html)). The mockup shows structure and tone;
this document decides content and behaviour where they differ.

## 1. Why

`/feedback-autowriter` opens on nine identical number cards and hides its most important facts (the expansion
gate, accuracy, what is waiting for the owner) on two other tabs. The operating loop the owner asked for on
29 Sep needs the page to answer, in this order: **what needs me**, **are we getting better**, **who is next**.
Three of those asks have no data behind them yet (tutor-facing hold tracking, the forward-scan decision queue,
expansion candidates); the owner chose to build them together with the redesign.

Goals:

- The top of the page is a to-do list for the owner, not a wall of totals.
- Accuracy, coverage, speed/cost and evidence/model trends as daily values with a 7-day moving average.
- Per-tutor results in one table; clicking a tutor filters the whole page.
- The page states the system's current configuration (mode, models, evidence mode, prompt versions).
- Holds are tracked until someone writes the class; upcoming risks become decisions; the next tutors are ranked.

Non-goals: changing what the autowriter writes or how it posts; the Mac agent loop (Phase 5 of the operating-loop
plan); moving the roster out of `roster.ts`; any tutor-facing UI.

## 2. Owner decisions (30 Sep)

| Topic | Decision |
|---|---|
| Top of page | "What needs me?" — the to-do list first |
| Trends | All four: accuracy and gate, coverage, speed and cost, evidence and models; daily values plus a 7-day moving average |
| Per tutor | Overview charts plus one tutor table; clicking a tutor filters the page |
| Scope | Redesign, hold tracker, forward-scan decisions and expansion candidates in one project |
| Layout | A: to-do list left, health rail right, detail in a side drawer |
| Access | All admins can view, as today; only the owner can review, decide, retry, pause or switch tutors |
| Forward-scan decisions | Two choices: let it run, or leave to the tutor (no "hold for my review" in this version) |
| Build | One spec, five PRs, in the order of section 9 |

Earlier decisions this design relies on: accuracy = reviewed posts needing no real fix; gate = rolling 14 days,
Wilson 95% lower bound ≥ 80%, no critical error, coverage ≥ 70%; head start at a lower bound of 70%; expansion
+50% rounded up (5 → 8 → 12 → 18); new tutors reviewed at 100% for their first 15 posts; coverage leaves out only
data-quality holds (D-03); a late deduction on a held class is waived only if the tutor was told less than 24 hours
before the deadline (D-04).

## 3. The page (PR 1)

One scrolling page. The three tabs (Overview, Quality, Review) and the nine cards are removed; nothing they showed
is lost (section 3.8 says where each item goes).

### 3.1 Header and system line

- Header: title, "Updated hh:mm", Refresh, and a range selector (14, 30 or 90 days) that drives the trends and the
  tutor table.
- System line, one slim row: mode (live / shadow / off, plus "Halted"); writer, fallback writer and judge models
  (from `AUTOWRITER_MODELS` in `config.ts`, labelled through `model-labels.ts`); evidence mode ("Transcript first:
  on/off", "Second pass: on/off" from the env switches); `PROMPT_VERSION` / `JUDGE_PROMPT_VERSION`; last sweep;
  last review run and its status; last Wise webhook delivery.
- Owner controls (switch mode, pause, resume) move into a "Controls" menu on the system line (`Popover`). They call
  the existing `POST /api/feedback-autowriter/control` with the same confirmations.
- The red "Posting is halted" banner stays directly under the system line.

### 3.2 "What needs you" (left, two thirds)

The list keeps its own height: it is not stretched to the rail's. The trend charts (3.5) follow it in the same left
column, and the right column (the rail, then the quality cards of 3.4a) spans both rows (amended 2 Oct 2026: a short
list left a tall blank panel). Narrow screens stack the list, the right column, then the trends.

A grouped list. Groups appear only when they have items, in this fixed order:

1. **Incidents** — unacknowledged `critical` incidents. Action: Open (drawer with the incident and its class),
   Acknowledge (owner).
2. **Held** — classes in state `held`, soonest deadline first. Each row: tutor, class time, the hold reason in plain
   words (section 4.3), a deadline countdown, and from PR 2 "tutor told hh:mm". Amber under 24 hours, red under
   6 hours. Action: Open.
3. **To review** — required reviews without a verdict, flagged ones first, then oldest first. Each row: tutor,
   class time, evidence (summary / transcript), writer model. Action: Review.
4. **Decisions** (from PR 3) — open forward-scan findings that need a rule. Action: Decide.
5. **Failed posts** — rows in `verify_failed`, `unknown_outcome` or `rejected`. Action: Open.
6. **Expansion** (from PR 4) — one item when the gate passes: "Confirm the next N tutors". Action: Confirm.

Rules:

- The group header shows its count; the list header shows the total ("8 open").
- Empty list: "Nothing needs you." with the time the next roster class ends, when known.
- Admins who are not the owner see the same list; drawers open read-only ("Only the owner records verdicts").
- The tutor filter (3.6) narrows the list; the header then says "filtered to <tutor>".

### 3.3 Detail drawer

A right-hand sheet built on the `Dialog` primitive. One drawer component, four bodies:

- **Review**: first shot next to the current text with the word diff, saves in Wise, corrections, verdict log and
  the verdict form. This is today's review card (`feedback-autowriter-review-queue.tsx`) split into reusable parts;
  the request body, 409 handling and downgrade rules do not change.
- **Hold**: reason, deadline, the stored draft if any, the judge's problems, alert and notice times, "Open in Wise",
  and from PR 2 a Retry button (owner).
- **Decision** (PR 3): the finding, the classes it covers, the evidence counts, and the two choices.
- **Incident / failed post**: what happened, the class, Acknowledge.

After any successful action the drawer closes and the page data reloads.

### 3.4 Health rail (right, one third)

- **Gate card**: status as one sentence built from the gate facts, e.g. "Gate blocked until 13 Oct: critical on
  29 Sep." / "Head start: lower bound 72%, needs 80%." / "Not enough reviews yet." Below it, only the criteria
  that are not met (from `gate.reasons`), and the lower-bound bar with the 70% and 80% marks (`LowerBoundBar`).
  The "blocked until" date is the critical class's Bangkok date + 14 days, the same rule the backfill prints.
- **Accuracy** and **coverage** mini charts (last 14 days, daily points and the 7-day line), each with its
  current 14-day figure and counts ("46 of 51 reviewed").
- **Today** line: posted · waiting for a recording · held · tutor wrote first · out of scope, for classes ending
  today in Bangkok. This one line replaces the nine cards.

### 3.4a Quality cards under the rail (amended 2 Oct 2026)

The right column holds the rail and two cards, in this order. The second card is shown only when it fits beside
the left column (the to-do list and the trends), so it never makes the page taller.

- **Placement.** One wrapper in the grid's right column (`lg:col-start-3 lg:row-span-2 lg:row-start-1`, a flex
  column with the grid's 20px gap). Nothing in it is sticky: a column this tall would hide its own bottom.
- **Fitting.** A `useFits` hook (ResizeObserver on the to-do list, the trends and the right column) shows the second
  card when the rail, the first card and the second card fit in the left column's height, with 24px of hysteresis
  so it does not flicker. The first card is always shown, even when it makes the page taller. On the server and
  below the `lg` breakpoint the hook answers false and true respectively: server markup never has the second card,
  narrow screens always do.
- **Scope.** Both cards are fleet-level like the rail: every tutor, the gate's 14 Bangkok dates. Each subtitle says
  "all tutors · 23 Sep – 6 Oct". The tutor filter does not change them.
- **No review data.** Neither card is drawn; the rail already says why.

**Card 1, "What goes wrong"** — what to fix in the prompt next. Built from the review payload only.

- Headline: "4 of 26 reviewed needed a fix": required reviews in the window whose current verdict is `needs_fix`,
  of required reviews with a verdict (the gate's own counts, so it agrees with the rail).
- Chart (about 110px): one stacked bar per class date, from the window's required queue items that have a current
  verdict: approved, cosmetic, factual, critical (green, sky, amber, `--conflict`). A date with no verdict is a gap.
  The daily rows are not used here: their severity counts include optional reviews and their `accurate` includes
  cosmetic fixes, so the segments would not add up.
- **Fields fixed**: for each feedback field, how many of those reviewed posts changed it after the first shot
  (`queue[].changed`, `diff[].field`), most first, with the field labels of `format.ts` ("Homework 3 · Summary 2").
  When the queue is cut (`queueTotals.shown < all`) the line ends "of the N shown".
- **Critical kinds**: chips for each critical category with a count (wrong person, billing or status, invented
  content, should not have posted). With none, one green line: "No critical verdict in these 14 days."
- Nothing reviewed yet: "No reviewed posts yet."

**Card 2, "Review backlog"** — whether the owner keeps up while every new tutor's post is reviewed.

- Headline: "3 required pending · oldest 2 days" (the earliest class date among queue items `needs_review` or
  `flagged`, counted in Bangkok days to today), and "1 flagged" when `queueTotals.flagged > 0`.
- Chart: one stacked bar per class date: reviewed (`daily.reviewed`) and still pending (`daily.requiredPending`,
  amber). Both count required reviews only.
- Footer: "Every new tutor's post is reviewed until the gate passes."
- Nothing required in the window: "Nothing to review."

### 3.5 Trends (2 × 2)

Four charts on the shared `ChartCanvas` wrapper (`src/components/sales-dashboard/chart-canvas.tsx`) with
`chartColors()` tokens. Definitions are in section 4.2.

| Chart | Series | Footer |
|---|---|---|
| Accuracy and gate | Daily accuracy points; 7-day line; rolling 14-day Wilson lower bound; dashed 80% line; a red marker on any day with a critical verdict | Gate sentence; fix rounds per post (0 / 1 / 2 / 3+ / unresolved) |
| Coverage | Daily coverage points; 7-day line; dashed 70% floor | Misses and exclusions by kind (today's coverage chips) |
| Speed and cost | Median minutes from class end to posted (left axis); cost per posted class (right axis); both with 7-day lines | Totals for the range; p90 minutes |
| Evidence and models | Stacked bars per day: posted from summary vs transcript; line: 7-day transcript share | Writer share for the range (Sol / Luna / GLM); holds by reason category |

- A day with no data is a gap, never zero.
- Until there are 7 days of history the 7-day line covers the days available and the chart says "since 29 Sep".
- A legend row in the DOM (not the canvas) explains points, line, lower bound and target.

### 3.6 Tutor table

Columns: tutor; accuracy (accurate / reviewed) for the range; Wilson lower bound; coverage (posted / eligible);
holds (open / total); real fixes (and critical count); review phase (full review, or sampled; from PR 4 probation
progress "9 / 15"); status (On / Partly on / Off, with the owner's switch).

Amended 2 Oct 2026, for a pilot of 18 tutors and growing:

- One line per tutor. The accuracy cell carries an interval bar: a band from the Wilson lower bound to the accuracy,
  a dot at the accuracy, hairlines at the 70% head-start and 80% pass bars.
- The review-phase column is dropped while every tutor is in full review; a sampled tutor gets a "Sampled" tag by
  the name. PR 4's probation progress goes there too.
- A search by name, and four views with their counts: All, Needs attention (below a bar, a critical verdict, an
  open hold, a post to review, or partly on), No posts yet, Off.
- Every figure column sorts (accuracy, highest first, by default); a tutor without the figure stays last.
- Tutors with no post and no hold in the window are folded into a row of chips under the table (name, status, the
  owner's switch); a chip filters the page like a row.

Clicking a row sets the page's tutor filter: the to-do list is filtered on the client, the trends reload for that
tutor, the table highlights the row, and a "Showing <tutor> ×" chip clears it.

### 3.7 Next in line (PR 4)

Until PR 4 this section is absent. Section 7 describes it.

### 3.8 All classes and details (collapsed by default)

- **All classes**: today's "Recent classes" table with filters (state, tutor, evidence). A posted class opens the
  Review drawer; a held one the Hold drawer. Reviewed posts and their verdict history are reached here.
- **By day**: the existing daily table, for exact numbers.
- **Cost by model**, **Wise webhooks**, **All incidents** (acknowledged ones too), the review job's last run.

Where the old items went:

| Old | New |
|---|---|
| 9 cards | Today line (3.4); speed and cost chart; evidence and models chart |
| Tutors table (Overview) and By tutor (Quality) | One tutor table (3.6) |
| Expansion gate card, criteria | Gate card (3.4), accuracy chart |
| Coverage chips, fix-round chips | Chart footers (3.5) |
| Review tab | "To review" group and the Review drawer; history through All classes |
| Incidents list | Incidents group (open), All incidents (details) |
| Recent classes, cost, webhooks | Section 3.8 |

### 3.9 States

- Loading: a skeleton that mirrors the new layout (system line, list and rail, four chart boxes).
- Review tables unavailable or a failed load: the to-do list shows holds and failed posts only, and the rail and
  trends show the existing "quality data could not load" message. The page never goes blank.
- Errors from an action show inline in the drawer; a 409 reloads the item, as today.

## 4. Data (PR 1)

### 4.1 Payloads and routes

Existing, unchanged: `GET /api/feedback-autowriter?days=` (`loadAutowriterDashboard`),
`GET /api/feedback-autowriter/review` (`loadAutowriterReview`), and the owner-only `control`, `verdicts` and
`incidents` routes.

New:

- `src/lib/feedback-autowriter/trends.ts` — pure series builders and `loadAutowriterTrends(db, { days, tutorKey })`.
- `GET /api/feedback-autowriter/trends?days=14|30|90&tutor=<tutorKey|*>` — admin session, same error mapper.
- `src/lib/feedback-autowriter/inbox.ts` — pure `buildInbox(dashboard, review, extras)` returning `InboxItem[]`.
  It runs on the client from the two payloads the page already has, so there is no inbox route.
- `src/lib/feedback-autowriter/system-status.ts` — `loadAutowriterSystemStatus()`: models, versions, switches and
  commit, added to the dashboard payload as `system`.
- `src/lib/feedback-autowriter/hold-reasons.ts` — `holdReasonCategory(reason)` and `holdReasonLabel(reason)`.

The page's server component loads dashboard, review and trends in parallel. The client polls the dashboard every
60 seconds (as now) and the review data every 5 minutes and after each action; trends reload when the range or the
tutor filter changes.

```ts
type InboxItemKind = "incident" | "hold" | "review" | "decision" | "failed_post" | "expansion_ready";
interface InboxItem {
  id: string;
  kind: InboxItemKind;
  urgency: "critical" | "soon" | "normal";
  title: string;
  detail: string;
  tutorKey: string | null;
  wiseSessionId: string | null;
  classEndedAt: string | null;
  deadlineAt: string | null;
  tutorNotifiedAt: string | null; // PR 2
  action: "open" | "review" | "decide" | "confirm";
}
```

### 4.2 Trend definitions

All dates are Bangkok dates of the class's scheduled end, the date `feedback_autowriter_daily_metrics` already
uses. `tutor = *` reads the all-tutors rows; a tutor key reads that tutor's rows.

- **Daily accuracy** = accurate ÷ reviewed for that date (required reviews with a verdict). No reviews: null.
- **7-day average** (every ratio on the page): pooled, not a mean of daily ratios. Sum the numerators and the
  denominators over the date and the six days before it, then divide. A day with two classes cannot swing it.
- **Rolling lower bound** for date d = `wilsonLowerBound(Σ accurate, Σ reviewed)` over d − 13 … d
  (`quality.ts`). The nightly rows in `feedback_autowriter_gate_evaluations` stay the record of what the gate
  decided; the chart marks a date red when any class that day has a critical verdict.
- **Daily coverage** = posted ÷ eligible from the same rows.
- **Minutes to post** = median of `post_started_at − scheduled_end_at` over classes posted with that class date;
  the 7-day value is the median over the pooled seven days.
- **Cost per class** = Σ `feedback_autowriter_calls.cost_usd` for classes with that class date ÷ classes posted.
- **Evidence** = posted classes by `evidence`; **writer** = posted classes by `arm`; **holds by reason** = held
  classes by `holdReasonCategory` (data quality, judge, validation, billing or form, error, other).

Known limit, stated on the page: the review job recomputes only the last 15 dates each hour, so a verdict recorded
on an older class does not change that old day's row. For 30- and 90-day ranges the loader recomputes accuracy for
the requested dates from `feedback_autowriter_reviews` and verdicts directly instead of trusting frozen rows;
coverage for older dates comes from the stored rows.

### 4.3 Hold reasons in plain words

`holdReasonLabel` maps reason codes to short sentences ("The judge found a claim the record does not support",
"The student's attendance shows 0%", "Recording too short"). Unknown codes show the raw reason. The mapping is a
table with a test that enumerates every hold reason the code can emit (the same list the D-03 coverage test uses).

## 5. Hold tracker (PR 2, migration 0102)

Today a hold sends one digest to the alert recipients and nothing to the tutor; nothing records whether the class
got written.

- Table `feedback_autowriter_hold_notices`: one row per hold episode (`wise_session_id`, `held_at` unique) with
  `tutor_key`, `reason`, `deadline_at`, `tutor_notified_at`, `tutor_notice_status` (`sent` / `failed` /
  `no_address`), `owner_alerted_at`, `resolved_at`, `resolution` (`tutor_wrote` / `posted_after_retry` / `expired` /
  `out_of_scope`).
- **Tutor notice**: in the sweep, right after a class becomes `held` with a person disposition (not while it is
  still retrying), send the tutor one email: class title and time, the reason in plain words, the feedback deadline,
  a Wise link, and "please write this one yourself". It uses the nightly reminder's sender and tutor-address
  lookup (`src/lib/post-class-feedback/nightly-reminders.ts`), with an idempotency key per hold episode. No
  address: `no_address`, and the owner's digest says so. The email body never contains feedback text.
- **Resolution**: the hourly review job already ingests every feedback save on autowriter classes
  (`feedback_autowriter_fix_events`). A tutor save after `held_at` closes the notice as `tutor_wrote`; a retry that
  posts closes it as `posted_after_retry`; the deadline passing closes it as `expired`.
- **Six-hour alert**: a notice still open 6 hours before `deadline_at` raises one owner alert (email, and LINE when
  `FEEDBACK_AUTOWRITER_LINE_TO` is set) and the row turns red in the list.
- **Retry**: `POST /api/feedback-autowriter/control` gains `{ action: "retry", wiseSessionId }` (owner only), which
  calls the existing `retryHeldSession` with its deadline margin and state checks. The post itself still happens
  only in the sweep, through the guarded path.
- The Held group and drawer show "tutor told hh:mm", "not told: no address", and "owner alerted hh:mm".

**PR 2b, the deduction waiver (D-04)**: Class Feedback waives a late deduction on a class the autowriter held when
`tutor_notified_at` is later than `deadline_at − 24 h` (or the tutor was never told). This changes deduction logic
in `src/lib/post-class-feedback/`, so it is its own PR, stays a draft until an independent review and the Postgres
suites pass, and ships only with the owner's approval.

## 6. Forward scan and decisions (PR 3, migration 0103)

- **Schedule**: one cron entry, every two hours on odd UTC hours. The builder picks the minute; the schedule test
  (`src/__tests__/vercel-crons.test.ts`) decides whether it is allowed. The 15:xx UTC run (22:xx Bangkok) scans the full 30 days; the others re-scan only classes whose
  source rows changed. Registered in `cron-registry.ts`; single-flight through a `feedback_autowriter_scan_runs`
  ledger with a partial unique index on `running`.
- **Inputs, our database only**: `future_session_blocks` on the active snapshot (its stored times are corrected by
  one tested helper), `credit_control_sessions`, `credit_control_packages`, and the history of each class series
  in `feedback_autowriter_sessions`. A class series is a Wise class id. Cancelled, deleted and moved-to-onsite
  classes are dropped; a moved class is matched by class id and start time.
- **Checks**: online vs onsite disagreement between type and title; one-to-one vs group; student without a Wise
  account; no usable nickname; scheduled length vs the billing-credit rule; credit balance at or below zero; which
  tutor account the class is on; and per series, the share of Thai summaries, guest joins, tutor double-joins, past
  holds and how often the tutor writes first.
- **Findings** (`feedback_autowriter_scan_findings`): one row per series and check with a stable `finding_key`,
  the next affected class time, counts as evidence (no names, no lesson text), a proposed handling, and a status:
  `info` (the system already handles it), `open`, `decided`, `closed` (the classes are cancelled or over).
  Re-scans update `last_seen_at` and never duplicate.
- **Decisions** (`feedback_autowriter_scan_decisions`, append-only): `proceed` or `leave_to_tutor`, for one class
  or the whole series, with the owner's email and an optional note. `POST /api/feedback-autowriter/scan/decisions`
  (owner only); `GET /api/feedback-autowriter/scan` for the list.
- **Effect**: before writing, `processLeased` looks for a `leave_to_tutor` decision for the class or its series and
  ends the row as `skipped_scope` with reason `owner_rule:leave_to_tutor`. Coverage treats it as out of scope. The
  tutor gets one email when the decision is recorded ("you write this class / these classes yourself").
- **Backtest**: a script replays past `credit_control_snapshots` through the checks and reports, per check, how
  often a flagged class actually held, was skipped or needed a fix. Report only.
- **Page**: the Decisions group and drawer (3.2, 3.3), and in the details section a small table of upcoming
  classes by check.

## 7. Expansion candidates (PR 4, migration 0104)

- **Ranking**: tutors not on the roster, both Wise accounts grouped by identity group, ranked by online one-to-one
  hours in the last 30 days and the next 30 days. Stored in `feedback_autowriter_candidates` and refreshed by the
  nightly scan run.
- **Head start**: when the gate status is `head_start` or better, the top candidates (as many as the next step
  adds) move to `head_start`. Their upcoming online one-to-one classes get **dry-run drafts**: the full pipeline
  runs, the row ends in `would_submit` with `metadata.dryRun = true`, and it is **never** posted.
  - Fail-closed guard, tested: the POST claim refuses any row whose teacher is not on the live roster, and
    `requeueShadowDrafts` skips dry-run rows, so switching modes can never post one.
  - Dry runs appear in the to-do list under a "Dry runs" filter, off by default, and are reviewed with the same
    drawer. Verdicts are stored with `target_kind = 'dry_run'` (already reserved) and never enter the live gate.
  - Cost: about $0.11 per class.
- **Next in line** section: rank, tutor, hours, dry-run accuracy (reviewed count), open forward-scan findings for
  that tutor, and status. When the gate is not passed the section says "Paused by the gate".
- **Gate passed**: the to-do list gets "Confirm the next N tutors". Confirming (`POST
  /api/feedback-autowriter/expansion/confirm`, owner only) records an `expansion_confirm` gate evaluation and the
  chosen tutors. The roster change itself stays a PR to `roster.ts` that the owner approves, and the owner tells
  the tutors.
- **Probation** in the tutor table: a new tutor's first 15 posts are all reviewed; the row shows progress and
  fails probation on a critical error or more than 2 real fixes.

## 8. Components and files

`src/components/feedback-autowriter/`:

| File | Purpose |
|---|---|
| `feedback-autowriter-dashboard.tsx` | Shell only: data loading and polling, range and tutor filter state, layout |
| `system-line.tsx` | Status row and the owner's Controls menu |
| `inbox.tsx` | Grouped to-do list |
| `item-drawer.tsx` | The drawer and its four bodies |
| `review-detail.tsx`, `verdict-form.tsx` | Split out of `feedback-autowriter-review-queue.tsx`, behaviour unchanged |
| `health-rail.tsx` | Gate card, mini charts, Today line |
| `quality-cards.tsx`, `use-fits.ts` | "What goes wrong" and "Review backlog" under the rail (3.4a); the fit check |
| `trend-charts.tsx` | The four charts and their footers |
| `tutor-table.tsx` | Merged tutor table with the filter |
| `classes-log.tsx`, `system-details.tsx` | Collapsed detail sections |
| `expansion-panel.tsx` | PR 4 |

Reused as they are: `ChartCanvas` and `chartColors()`, `LowerBoundBar`, `ARM_LABEL`, the `Badge`, `Button`, `Table`,
`Dialog` and `Popover` primitives, `formatBangkokShortDateTime`, and the pure helpers exported by the review queue
(`matchesFilter`, `verdictLabel`, `buildVerdictRequest`, `downgradeFor`). The duplicated `when()` and field-label
helpers are merged into one module. `feedback-autowriter-quality-panel.tsx` is removed once its pieces have moved.

Conventions: named exports, `"use client"` only on interactive files, no Server Actions, Bangkok time, semantic
colour tokens (`available`, `blocked`, `conflict`) plus the amber/sky utilities Data Health already uses.

## 9. Build order

| PR | Contents | Migration | Gate before merge |
|---|---|---|---|
| 1 | Sections 3, 4, 8 | none | Review, CI, a rendered screenshot compared with the mockup |
| 2 | Section 5 (tracker, notice, alert, Retry) | 0102 | Review, CI; owner approves the migration and the email text |
| 2b | Deduction waiver (D-04) | none | Draft until reviewed; Postgres suites; owner approval |
| 3 | Section 6 | 0103 | Review, CI; owner approves the migration and the new cron |
| 4 | Section 7 | 0104 | Review, CI; owner approves the migration; dry runs start only after that |

Each PR leaves the page working: groups and sections for later PRs are simply absent until their data exists.
Every migration is hand-written with a journal entry whose `when` is later than every applied one, and is applied
to production only on the owner's word.

Rollback: PR 1 is a revert. PRs 2–4 each have a switch that defaults off until the owner turns it on
(`FEEDBACK_AUTOWRITER_HOLD_NOTICES_ENABLED`, `FEEDBACK_AUTOWRITER_SCAN_ENABLED`,
`FEEDBACK_AUTOWRITER_DRY_RUNS_ENABLED`); with a switch off its cron work and emails stop and the page leaves out
what depends on it (the "tutor told" times, the Decisions group, the dry runs and "Next in line"). Held classes
themselves are always listed.

## 10. Testing

- **Pure libraries** (unit): pooled 7-day average (gaps, fewer than 7 days, zero denominators); rolling lower
  bound against `wilsonLowerBound`; every trend series from fixture rows; `buildInbox` ordering, urgency and
  filtering; `holdReasonLabel` / `holdReasonCategory` over every reason the code emits; scan checks one by one;
  candidate ranking.
- **Components** (static render, as the existing suites): the to-do list groups and empty state; owner-only
  controls; each drawer body; the gate sentence for every gate status; the tutor filter; no "Posted to Wise" card
  row. The existing dashboard and review tests are rewritten against the new structure, keeping every behaviour
  they pin (verdict rules, 409 handling, unavailable review data, halt banner, polling).
- **Postgres** (Testcontainers): the trends loader against seeded metrics, sessions and calls; hold notices
  (one email per episode, resolution by a tutor save, the six-hour alert once); scan findings stable across
  re-scans and closed when a class is cancelled; a `leave_to_tutor` decision skipping the class; the dry-run guard
  (a dry-run row is never claimed for a POST and never requeued).
- **Visual**: each UI PR renders the page with made-up data to a PNG (headless Chrome) for the owner, next to the
  mockup.
- `npm run typecheck`, `npm run lint`, the full unit project, the autowriter integration project, `git diff --check`.

Public repository: tests, fixtures, docs and screenshots use made-up names only.

## 11. Risks and open points

- **Short history**: live data starts 29 Sep, so 30- and 90-day charts are mostly empty for weeks. The charts say
  so instead of drawing a misleading line.
- **Frozen daily rows** beyond 15 days (4.2): accuracy is recomputed on read; coverage is not. If that matters, the
  review job's recompute window can be widened later.
- **Posts reach the review data up to an hour late** (they are snapshotted by the hourly job). The to-do list can
  therefore show a new post as "posted" before it shows it as "to review". Accepted for now.
- **Writer rate limits**: on 30 Sep the writer's first call on a live class was rate-limited upstream and posted on
  the retry 14 minutes later. The speed chart will show this; whether to fall back to the second writer on a rate
  limit is a separate decision.
- **Dry-run review load**: head start adds drafts for the owner to review. The "Dry runs" filter keeps them out of
  the default list.
- **Email volume**: one tutor email per hold episode and one per `leave_to_tutor` decision; both idempotent.
