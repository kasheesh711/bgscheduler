# Leave Requests

**Status: stable; daily work queue implementation in migration 0080.**

The admin screen answers who owns a cancellation, when to process it, which classes are affected, and which families have been informed. Teachers submit the existing Google Form; its `Form Responses 1` tab remains the source of leave submissions. The application never cancels classes in Wise or sends messages to parents. Admins do those actions manually, then check them off.

## Daily workflow

`/leave-requests` opens on the current Bangkok processing date. Roster staff default to My work; other authorized admins default to Everyone. The date controls, Everyone, individual roster buttons, and Unassigned filter expose shared work. The compact roster shows the shift, unfinished assignments, and work needing cover. Existing owners never change automatically: use Take over or the assignment's owner selector.

One expandable assignment represents a stable teacher identity and one class date. Its collapsed header shows teacher, class date, processing due date, owner, families informed, and classes cancelled. Daily work is ordered overdue, due today, then completed. Upcoming and searchable History are separate views. Past source submissions retain their original statuses in History.

Both actions are due **seven Bangkok calendar days before the class**: a 15 September class is due on 8 September. A late submission is immediately overdue. The queue begins operational work with upcoming classes; historical submissions are retained without creating a retrospective backlog of already-past classes.

Within an assignment:

- Families to inform groups established siblings/parent relationships, shows student names, affected times and verified LINE chat links, and saves each Parent informed checkbox immediately. This means the notification was sent, without waiting for a reply.
- Classes to cancel has one Cancelled in Wise checkbox per Wise session, including group classes shared by several families.
- Manual checkoffs show the actual completing admin and time and can be undone. Explicit Wise cancellation evidence is displayed independently and cannot be undone through a tracking checkbox.
- The optional source drawer contains original form fields, sheet notes, make-up suggestions, the interpretation, and activity history.

The client refreshes every 30 seconds while visible and on window focus. One main vertical scrolling surface serves phone and desktop. Dates and times are formatted in Asia/Bangkok. Home and navigation badges count due/overdue unfinished assignments, including unassigned work, excluding past classes and retired empty bundles.

## Identity, normalization, and source evidence

The source sheet defaults to `109o2vbmxlJ-l2U18Rs_WrjD7TMF5b6h__GiNkkQIfS8`, tab `Form Responses 1`; the roster defaults to `1dacHgICN6YgH-guVV1maN5H3KtMSheKyCsmy708jwOs`.

New and meaningfully changed submissions enter persistent normalization revisions. The Responses API uses **`gpt-6-astra`**, `reasoning.effort: "medium"`, strict structured output, and `store: false`. Leave Requests owns its model configuration; the scheduler's configuration is unaffected. Input includes relevant form fields, canonical sheet dates, and human-written Status notes. Interpretation supports Thai/English, multiple daily time intervals, full-day corrections, duplicate/withdrawn submissions, and date-specific completion evidence. Valid results apply automatically. There is no approval or review stage. Invalid output becomes a visible processing error with automatic exponential retries; it cannot supply guessed teacher identities or invalid dates.

The cache key includes meaningful input, model, effort, and prompt version. Only this application's bracketed `[BGScheduler: ...]` summaries are excluded from the human Status text. Human corrections continue to invalidate the cache. Original source fields, normalization inputs/results, and the explanation are preserved. Teacher matching uses verified email and unique normalized identity aliases; colliding names fail closed.

On reconciliation, explicit source completion notes may initialize checklist evidence only for the stated dates and current known classes. Imported evidence records its source and any written admin label but has **no invented completion timestamp**. Normalization IDs consumed by tasks survive undo and interrupted reconciliation. An immutable initial session/revision scope prevents a resumed catch-up from applying old completion notes to later classes. Later added or changed classes do not inherit an old blanket Done note.

## Roster and allocation

The roster reader loads current/next monthly tabs, including cell text, notes, effective colours, and theme colours. Month names support the spreadsheet's variants (e.g. `Jan 26`, `July_26`, `Sep_26`). Each tab's own shift legend determines working hours; coloured blank cells count as shifts. Off, annual leave, holiday, sick leave, and unknown cells cannot receive automatic work. Swap references apply to their cell's date, never the date mentioned inside the note.

Persistent mappings associate Petch/Petchy, Care, Palm, Aya, and Muk with their existing admin accounts. These mappings grant no access. Allocation requires a fresh successful roster read for the processing day and an enabled admin with Leave Requests access. Missing data leaves work Unassigned. New due assignments are allocated by unfinished family workload, with each teacher/date kept together. Subsequent syncs assign newly arriving work without reshuffling existing owners. Manual unassignment is also preserved.

## Durable reconciliation

The source records and eight work tables are independent of rotating Wise/Credit Control snapshots. Assignments are unique by teacher canonical key plus Bangkok class date. Class tasks are globally unique by Wise session ID. Overlapping submissions link to shared tasks rather than duplicating cancellations. Family tasks are unique within each assignment by an established parent/contact relationship; unlinked students remain distinct.

Class dates and times come from original `credit_control_sessions.scheduled_start_time` and `scheduled_end_time` instants, joined to Wise teacher/session identities. **Do not use the shifted `future_session_blocks.start_time` representation as a real UTC timestamp.** The latter is used only for identity fallback by Wise session ID. Unknown identities or inconsistent class records cannot silently create a cancellation.

Family notification coverage records session IDs and revisions of the class information relevant to that family. A newly added unrelated student does not reopen an already-informed family. Time/content changes reopen affected notification coverage; material class changes invalidate the previous cancellation checkoff. A missing session retains unfinished work with a visible issue. Explicit `CANCELLED`/`CANCELED` status proves cancellation only, never parent notification.

Writes use narrow transactions, assignment locks, expected entity versions, idempotency keys, and audit events. Concurrent takeovers or stale checkbox edits return HTTP 409. Checkoffs survive reconciliation, snapshot rotation and outages. A per-bundle source fingerprint skips unchanged reconciliation work.

## Sync, recovery, and writeback

The existing `15,45 * * * *` cron and 800-second routes are retained. Before claiming a run, sync marks abandoned running rows older than 20 minutes failed. The Postgres partial unique running-row index remains the single-flight guard. This recovers the run stranded since 27 July rather than bypassing the guard.

Source rows and snapshot data are read in batches. Source upserts and normalization revisions are checkpointed separately; a killed run repairs a missing revision on restart. Model calls run in bounded batches of three with a five-minute processing budget and a 75-second request timeout. Each result commits independently. Reconciliation also has a bounded budget and persistent bundle checkpoints. Remaining work resumes on the next cron/manual sync. Failures leave the prior usable queue intact.

The source banner reports actual last source read, class snapshot freshness, processing failures, and pending interpretation/writeback work. A failed roster read never reallocates existing owners. Failed source or class reads preserve checkoffs.

Checklist changes mark source summaries pending. The independent writeback pass re-reads source rows, verifies meaningful source identity, preserves human notes, and replaces only the app's bracketed summary in Status column S. It derives family/cancellation counts per class date. A conditional update prevents an in-flight writeback from clearing a newer pending checklist change. Failures retry on subsequent syncs. Initial catch-up imports suppress submission emails; no parent messages are sent.

## Configuration

Existing `LEAVE_REQUESTS_SPREADSHEET_ID`, `LEAVE_REQUESTS_SHEET_NAME`, and `LEAVE_REQUESTS_CONNECTED_EMAIL` remain supported. Sheets uses the application's existing scoped OAuth account selection. New optional settings:

| Variable | Default / purpose |
|---|---|
| `LEAVE_ROSTER_SPREADSHEET_ID` | Supplied admin roster spreadsheet |
| `LEAVE_NORMALIZATION_MODEL` | `gpt-6-astra` |
| `LEAVE_NORMALIZATION_API_KEY` | Optional separate key; falls back to `OPENAI_API_KEY` |

Reasoning effort is fixed to medium and the prompt version is in `config.ts`. Google Sheets and OpenAI are called only from the server.

## Validation and rollout

Apply `0080_leave_daily_work_queue` before deploying routes that read the new tables. Deploy the new cron code **before recovering the abandoned run**; otherwise the old cron can resume and send catch-up digests. `scripts/recover-leave-work.ts --migrate-only` prepares the schema; after deployment, `--apply --deployed --passes=1` resumes the backlog. Run the catch-up sync with notifications suppressed until the source backlog and upcoming class bundles have been processed. Re-running it resumes progress without clearing owners or evidence. Verify row counts, source freshness, unresolved errors and the September roster before treating the new queue as complete.

`daily-work.test.ts` covers due dates/month boundaries, real September colours/off/sick/swap cells, normalization caching/API configuration, full-day/partial/duplicate interpretations, families, and accessible inline checkboxes. `daily-work.integration.test.ts` uses ephemeral Postgres to cover shared cancellations, allocation/takeover, version conflicts, idempotency, undo, resync/snapshot preservation, changed/missing/explicitly cancelled sessions, imported evidence, the July abandoned run, and resumable batches of 78 submissions. Existing parser/contact/legacy detail tests remain in place.

See [API reference](../reference/api/leave-requests.md) and [database reference](../reference/database/erd-leave-requests.md).

Live normalization also requires funded OpenAI API credits. Exhausted credits stop the model batch after its current three requests, retain the remaining submissions as pending, and expose the billing error; manual sync retries failed interpretations immediately after credits are restored.
