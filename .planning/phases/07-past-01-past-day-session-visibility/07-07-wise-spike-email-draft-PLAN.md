---
phase: 07-past-01-past-day-session-visibility
plan: 07
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md
autonomous: false
requirements:
  - PAST-06

must_haves:
  truths:
    - "A new artifact at `.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` exists with an email draft at or below 150 words, addressed to the Wise devs mailbox"
    - "Email draft references tenant namespace `begifted-education` plus institute `696e1f4d90102225641cc413` for disambiguation (AGENTS.md §Source of Truth Rules)"
    - "Email asks the four D-13 topics: endpoint existence, auth contract, pagination shape, quota / rate-limit implications"
    - "Artifact records the sent date plus a placeholder for the response — either received text or `Unreachable (D-16)` at phase close"
    - "User sends the email manually from `kevhsh7@gmail.com`. autonomous is false; this plan does not trigger the send"
  artifacts:
    - path: ".planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md"
      provides: "Email draft plus sent-on metadata plus response capture section"
      contains: "devs@wiseapp.live"
  key_links:
    - from: "07-WISE-SPIKE.md"
      to: "User email client (kevhsh7@gmail.com)"
      via: "manual copy then user clicks send"
      pattern: "devs@wiseapp\\.live"
    - from: "07-WISE-SPIKE.md response section"
      to: ".planning/STATE.md (updated if Wise responds)"
      via: "D-15 defers wiring to v1.2; D-16 ships Phase 7 unconditionally regardless of outcome"
      pattern: "v1\\.2"
---

<objective>
Draft the PAST-06 Wise historical-sessions endpoint spike email and record it as a Phase 7 artifact. User sends from `kevhsh7@gmail.com` (D-13: "Claude drafts, user sends"). Spike runs in parallel to Phase 7 execution (D-14: non-blocking) — DB fallback from Plans 01-05 ships unconditionally regardless of Wise response (D-16). If Wise responds "yes, we have an endpoint," document and DEFER endpoint wiring to v1.2 (D-15).

Purpose: Close PAST-06 (Wise endpoint spike initiated). The artifact has three sections:
1. Email draft — short (at or below 150 words), factual, includes institute ID for disambiguation.
2. Sent-on metadata — user fills in when they actually send.
3. Response capture — placeholder for Wise's reply (captured text, triage note, and "defer to v1.2" flag per D-15).

Output: A single new markdown file at `.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` containing the three sections above.
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Email draft → Wise devs | Outbound text; no secrets, no authentication credentials |
| Response capture → planning artifact | Captured textual response; no integration pipe; v1.2 is the earliest wiring point |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-07-01 | Information Disclosure | Email accidentally reveals API keys, DB URLs, or CRON_SECRET | mitigate | Draft explicitly constrains content to: tenant namespace (`begifted-education` — public), institute ID (`696e1f4d90102225641cc413` — documented in AGENTS.md, not sensitive), question text. Acceptance criterion below grep-asserts absence of secret-name tokens. |
| T-07-07-02 | Spoofing | Email phishing — Wise requests credentials in response | mitigate | User reviews response before acting on it; D-15 defers actual wiring to v1.2 (a separate phase where credential exchange, if needed, would be formally planned). No auto-execution path from spike response to code. |
| T-07-07-03 | Repudiation | User sends email, no record of what was sent | mitigate | Artifact captures the exact draft text plus sent-on timestamp (manually filled by user after send). Provides audit trail. |

All LOW. No HIGH severity threats.
</threat_model>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md
@AGENTS.md
@CLAUDE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create 07-WISE-SPIKE.md with email draft plus metadata plus response placeholder</name>
  <files>.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md</files>
  <read_first>
    - AGENTS.md §"Source of Truth Rules" (tenant plus institute identifiers)
    - .planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md §D-13..D-16 (spike scope, defer rules)
    - .planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md §"Wise Historical-Endpoint Spike — Email Draft" (if present)
  </read_first>
  <action>
Create the artifact file at `.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` with the following exact structure. Do not modify any other file. The email body MUST be at or below 150 words (hard cap). Question list keeps the four D-13 topics: (a) endpoint existence, (b) auth contract, (c) pagination shape, (d) quota implications.

Important: inside the artifact, DO NOT use markdown horizontal rules (`---`) as section separators — use blank lines plus headings instead. (The gsd-tools YAML frontmatter parser uses the last `---`-bounded block in a file as the frontmatter source, so stray `---` rules in the body can break downstream tooling.)

The file contents to write:

```
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
> 2. Auth headers (same Basic plus `x-api-key` plus `x-wise-namespace` as current, or different?).
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
```

Do NOT include the actual Wise API key, Wise USER_ID, CRON_SECRET, DATABASE_URL, or any Google OAuth secrets in the draft. Do NOT paste `.env.local` contents anywhere. The only identifiers allowed are the namespace string (`begifted-education`) and the institute UUID (`696e1f4d90102225641cc413`), both already public in AGENTS.md.

Do NOT auto-send the email. The plan is `autonomous: false` because sending is a user-initiated action — user opens their email client, copies the draft body, reviews, and sends. This plan's Task 1 ends when the artifact file is committed.
  </action>
  <verify>
    <automated>test -f .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md && grep -c "devs@wiseapp.live" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md</automated>
  </verify>
  <acceptance_criteria>
    - File `.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` exists
    - `grep -c "devs@wiseapp.live" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns at least `1`
    - `grep -c "begifted-education" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns at least `1`
    - `grep -c "696e1f4d90102225641cc413" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns at least `1`
    - `grep -c "## 1. Email Draft" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns `1`
    - `grep -c "## 2. Sent-On Metadata" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns `1`
    - `grep -c "## 3. Response Capture" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns `1`
    - Email body text between `> Hi Wise team,` and `> Kevin` is under 150 words. Verify with `awk '/> Hi Wise team/,/> Kevin/' .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md | wc -w` returning a number at or below 170 (allowing slight slack for blockquote markers counted as words)
    - REGRESSION GUARD for T-07-07-01: `grep -iEc "api[_-]?key|database_url|cron_secret|wise_api_key|auth_secret" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns `0` (no secret-name tokens in the draft)
    - `grep -c "v1\\.2" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns at least `1` (explicit defer-to-v1.2 note per D-15)
    - REGRESSION GUARD against frontmatter-parser trap: `grep -c "^---$" .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` returns `0` (no horizontal-rule separators; keeps gsd-tools frontmatter parser from mis-slicing any downstream tool that reads this artifact)
  </acceptance_criteria>
  <done>Artifact file exists at the correct path with all three sections, a draft at or below 150 words, zero secrets, references to D-15 defer rule, and zero horizontal-rule separators.</done>
</task>

<task type="checkpoint:human-action" gate="non-blocking">
  <name>Task 2: User sends email from kevhsh7@gmail.com</name>
  <files>
    .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md
  </files>
  <read_first>
    - .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md (to copy the email body from Section 1)
  </read_first>
  <action>
User performs this task manually — Claude cannot send email on behalf of the user (no outbound-email MCP or CLI is configured for this project; also, per D-13, the user explicitly retains the Wise relationship).

Steps for the user:

1. Open their preferred email client logged in as `kevhsh7@gmail.com`.
2. Compose a new message:
   - To: `devs@wiseapp.live`
   - Subject: (copy from Section 1 of 07-WISE-SPIKE.md)
   - Body: (copy the blockquoted body from Section 1; remove the `> ` prefixes from each line)
3. Review the body. Edit wording if desired.
4. Send.
5. Update Section 2 of 07-WISE-SPIKE.md with the actual sent timestamp in Asia/Bangkok.
6. Commit the update: `git add .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md && git commit -m "docs(07): record PAST-06 Wise spike sent on $(date -u +%Y-%m-%dT%H:%M)"`.

This task is non-blocking — Phase 7 execution proceeds independently (D-14, D-16). If the user defers sending, the phase still closes; PAST-06 is marked "Unreachable" in 07-VERIFICATION.md per D-16 and Section 3c of the artifact.
  </action>
  <verify>
    <automated>test -f .planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md</automated>
  </verify>
  <what-built>Draft email ready in Section 1 of 07-WISE-SPIKE.md.</what-built>
  <how-to-verify>
1. Open 07-WISE-SPIKE.md, confirm Section 1 body is at or below 150 words.
2. After sending, confirm Section 2 has the real sent-on timestamp (not the `YYYY-MM-DD HH:MM` placeholder).
3. Git log shows a commit touching only this artifact (no code regressions).
  </how-to-verify>
  <resume-signal>Type `sent - <timestamp>` to indicate email dispatched, OR `deferred - closing as Unreachable (D-16)` if the user chooses not to send during Phase 7.</resume-signal>
  <done>User either sends the email and records the timestamp, or defers and documents "Unreachable" per D-16.</done>
</task>

</tasks>

<verification>
- Artifact file `.planning/phases/07-past-01-past-day-session-visibility/07-WISE-SPIKE.md` exists
- Email body word count is at or below 150
- No secret-name tokens in the file (grep check passes)
- Section 2 plus Section 3 exist as placeholders (populated later by user or phase close)
- Zero markdown horizontal rules (`---`) inside the artifact
</verification>

<success_criteria>
- PAST-06 spike artifact exists with a reviewable draft
- Draft is concise (at or below 150 words), factual, includes tenant plus institute IDs
- Draft asks the four D-13 topics (endpoint existence, auth, pagination, quota)
- No secret-name tokens leaked in the draft
- Artifact has a clear D-15 "defer to v1.2" clause plus D-16 "Unreachable" fallback
</success_criteria>

<output>
After completion, create `.planning/phases/07-past-01-past-day-session-visibility/07-07-SUMMARY.md` documenting:
- Draft word count
- Confirmation that the four D-13 topics are all addressed
- If user has already sent: the sent-on timestamp from Section 2
- If user has not sent: note to revisit in 07-VERIFICATION.md at phase close (Unreachable per D-16)
</output>
