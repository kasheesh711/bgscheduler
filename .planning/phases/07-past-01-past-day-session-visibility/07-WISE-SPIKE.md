# Phase 7: PAST-06 Wise Historical-Sessions Endpoint Spike

**Status:** Draft ready — awaiting send from kevhsh7@gmail.com.

**Scope:** Parallel, non-blocking (D-14). DB-snapshot fallback (Plans 01-05) ships unconditionally regardless of response (D-16). If Wise responds positively, wiring defers to v1.2 (D-15).

## 1. Email Draft

**To:** devs@wiseapp.live
**From:** kevhsh7@gmail.com
**Subject:** BG Education (namespace: begifted-education) — historical sessions endpoint availability?

**Body:**

> Hi Wise team,
>
> We are the BG Education tenant (namespace `begifted-education`, institute `696e1f4d90102225641cc413`) running a scheduling tool against your `/api/teachers` and `/api/sessions?status=FUTURE` endpoints.
>
> Do you offer a historical-sessions endpoint — something returning sessions whose `startTime` is in the past? The FUTURE endpoint stops returning a session once it completes, so we are losing visibility into what happened last week.
>
> If available, could you share:
>
> 1. The endpoint path plus HTTP method.
> 2. Auth header contract (same Basic plus namespace headers as our current FUTURE-sessions calls, or different?).
> 3. Pagination shape (does it reuse `paginateBy: "COUNT"` plus `page_number`/`page_size`?).
> 4. Rate-limit expectations for a daily cron over ~131 teachers.
>
> No rush — we have shipped a snapshot-diff fallback, but native support would be cleaner long-term.
>
> Thanks!
> Kevin

**Word count check:** approximately 140 words (within the 150-word cap per D-13).

## 2. Sent-On Metadata

`User fills this in after sending.`

- **Sent:** `YYYY-MM-DD HH:MM +07:00` (Asia/Bangkok)
- **Thread / message ID:** (optional — copy from sent mail client)
- **Any edits from the draft above:** (note any wording changes before send)

## 3. Response Capture

`User populates this when Wise replies. If no response within the Phase 7 window, mark "Unreachable (D-16)" and close out during phase verification.`

### 3a. Response received on `YYYY-MM-DD`

(paste Wise reply text here — exact quote preferred)

### 3b. Triage

- **Endpoint exists?** (yes / no / unclear)
- **Auth / pagination / quota specifics** (short summary)
- **Impact on Phase 7?** (per D-15: no wiring in Phase 7; defer to v1.2)
- **Proposed v1.2 action:** (e.g., "New phase PAST-09: layer Wise historical-endpoint capture alongside DB-snapshot diff, dual-source reconciliation")

### 3c. If No Response by Phase Close

Mark here: "Unreachable — DB fallback is sole source (D-16). Close PAST-06 in 07-VERIFICATION.md."

## Cross-References

- Decisions: 07-CONTEXT.md §D-13..D-16
- Requirement: REQUIREMENTS.md PAST-06
- Deferred wiring: future v1.2 phase (candidate PAST-09 or repurposed PAST-07) per D-15
- Tenant identifiers source: AGENTS.md §Source of Truth Rules
