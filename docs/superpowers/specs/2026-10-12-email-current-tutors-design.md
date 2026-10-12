# Email current tutors: team skill design

Date: 2026-10-12 · Owner: Kevin · Status: approved in conversation, awaiting written-spec review

## Purpose

Staff need to send BeGifted-branded announcements to every tutor who still teaches at BeGifted, without emailing
tutors who have left. Tutor Offboarding (`/tutor-offboarding`) already knows who is teaching and who has been
confirmed as departed. This work adds a Claude Code skill that team members run from their clone of the repo. It
builds the email and leaves a **Gmail draft** in the sender's own mailbox. A person always reviews the draft and
presses Send in Gmail.

## Decisions (owner, 2026-10-12)

| Topic | Decision |
|---|---|
| What the skill does | Email current tutors (not "send the roster to someone") |
| Look | BeGifted design system, v3 company email collection |
| Delivery | Gmail draft in the sender's own Gmail via the claude.ai Gmail connector; never sent by Claude |
| Who is "current" | Actively teaching: an upcoming class, **or** a taught class in the last 30 days |
| Approach | A: small read-only BGScheduler endpoint for the list + a committed repo skill with a bundled renderer |

Assumptions accepted with section 1:

- A sheet-confirmed departure (a matched strike-through row) is excluded even while still teaching a notice period.
- Teaching admins (Wise ADMIN accounts) are included when they teach; the rule is about teaching, not role.
- Stale data produces a warning, not a refusal.

Team members hold no production database credentials or secrets (see
[aoeng-windows-setup](../../operations/aoeng-windows-setup.md)), so the skill reads the list through the signed-in
BGScheduler website, never Postgres.

## Part 1: recipient endpoint

`GET /api/tutor-offboarding/current-tutors` · optional `?format=csv`

**Gate.** `requireTutorOffboardingAdmin()` in the handler; the proxy already scopes `/api/tutor-offboarding` to
users whose `allowedPages` include the page. No removal grant is needed. Errors use the Shape B mapper
`tutorOffboardingErrorResponse`. Every response sends `Cache-Control: private, no-store`. Any parameter other than
`format=csv` returns 400.

**Source.** `loadTutorOffboardingDashboard(viewer)` (the people in `inbox`, `excluded` and `staff`) plus one read of
`tutor_contacts` (`canonicalKey`, `primaryEmail`, `onsiteEmail`, `onlineEmail`). No Wise or Google Sheets call.
When the dashboard is unavailable, the endpoint returns `{ available: false, reason }` with HTTP 200, as the
dashboard route does.

**Rule.** The pure function `buildCurrentTutorList({ rows, contacts, now })` lives in
`src/lib/tutor-offboarding/current-tutors.ts`:

1. Each person (by `canonicalKey`) is considered once.
2. A person with `termination` evidence (a matched strike-through sheet row) goes to `excludedConfirmed`.
3. Otherwise, the person is current when `signals.upcomingSessions > 0` (reason `upcoming`) or when
   `signals.lastTaughtAt` is at or after `now − 30 × 24 h` (reason `recent`). `upcoming` takes precedence.
   Everyone else is left out silently; they are not teaching.
4. The email comes from the existing `resolvePostClassTutorRecipient`: first the `primaryEmail` override, then a
   single distinct Wise email. Where the contact row is absent or its `onsiteEmail`/`onlineEmail` is empty, the
   first onsite or online Wise account email from the dashboard stands in. A `conflict` (two different Wise emails) or `missing`
   result is never guessed. The person goes to `needsEmail` together with every valid candidate address.
5. Recipients are deduplicated by lowercased email (the first person wins) and sorted by name.

**JSON response**

```ts
{
  available: true,
  generatedAt: string,          // when this list was built
  snapshotCreatedAt: string,    // tutor snapshot the list reflects
  stale: boolean,               // !dashboard.freshness.ok
  recipients: { name: string; email: string; reason: "upcoming" | "recent" }[],
  needsEmail: { name: string; candidates: string[] }[],
  excludedConfirmed: { name: string }[],
  unmatchedSheetRows: number,   // terminationSource.unmatched.length, 0 when absent
}
```

**CSV** (`?format=csv`): an attachment named `current-tutors-YYYY-MM-DD.csv` (Bangkok date). It holds the
`name,email,reason` columns and recipients only. Cells go through the workforce export's quote-and-neutralize
`cell()` (`src/lib/tutor-offboarding/workforce/csv.ts`, now exported rather than copied), so formula-leading text
is defused.

**Tests**

- Unit tests for `buildCurrentTutorList`: the 30-day boundary (exactly 30 days is in, 30 days + 1 ms is out); upcoming
  with no past class; a confirmed departure who is still teaching (excluded); the primary override; one shared Wise
  email on both accounts; a conflict; a missing email; no contact row (falls back to account emails); a duplicate
  email; a staff row that teaches.
- A route test: 401, 403, unavailable payload, a 200 JSON shape, CSV headers and escaping, 400 on an unknown
  parameter.

## Part 2: the skill

`.claude/skills/email-current-tutors/` is committed. Team members receive it with `git pull` and invoke it as
`/email-current-tutors` or by asking to "email all current tutors".

| File | Role |
|---|---|
| `SKILL.md` | Steps and hard rules below |
| `renderer/company.mjs`, `renderer/company-render.mjs`, `renderer/render.mjs` | Verbatim copies of the `begifted-design` 3.2.0 runtime (zero dependencies) |
| `renderer/NOTICE.md` | Source skill and version, the Colorlib MIT licence text, and "do not edit; re-copy to upgrade" |
| `build-email.mjs` | `node build-email.mjs <spec.json> --out <dir>` writes `email.html`, `email.txt` and `subject.txt` |
| `build-email.test.mjs` | A `node --test` self-check |

`build-email.mjs` accepts `template` (`newsletter`, `programme` or `event`), `subject`, `preheader`, `title`,
`paragraphs`, and the optional `subtitle`, `greeting`, `sections`, `action`, `eventDetails` and `programmeDetails`. It fixes the logo
(`https://bgscheduler.vercel.app/brand/email/v3/logo-horizontal.png`) and a standard BeGifted footer note, and
passes everything else to `buildCompanyEmail`. It rejects unknown keys and a missing `subject`/`title`/`paragraphs`.
The renderer already escapes HTML and rejects unsafe URLs. It runs on Node 24 on macOS and Windows.

**Flow**

1. **Get the list.** If a browser tool is available (the desktop app's built-in browser or Claude in Chrome) and
   the user is signed in to BGScheduler, open `https://bgscheduler.vercel.app/api/tutor-offboarding/current-tutors`
   and read the JSON. Otherwise ask the user to open the same URL with `?format=csv` and supply the path of the
   downloaded file. Save working files in an OS temp folder, never inside the repo.
2. **Confirm recipients.** Show the recipient count and the `needsEmail` people (the sender picks a candidate or
   skips each). List the confirmed departures that were left out, and warn about `stale` data or unmatched sheet
   rows. The sender may add or remove addresses. Wait for an explicit yes.
3. **Write the copy** with the sender, in English. Never invent dates, times, links or policy facts; ask for them.
   Pick the template: `event` for a dated event, `programme` for an announcement with details and an action,
   `newsletter` otherwise.
4. **Render and preview.** Run `build-email.mjs` and show the plain text in chat. Open `email.html` in a browser
   when one is available.
5. **Create the Gmail draft.** Use the Gmail connector's `create_draft`: `to` is the sender's own address (confirm
   it), `bcc` is every recipient, and the draft gets the subject, `htmlBody` (the HTML) and `body` (the text). If no
   Gmail connector is available, tell the user to connect Gmail in claude.ai's connector settings, and as a fallback
   give them the HTML file plus the BCC list as one comma-separated line.
6. **Hand back** the draft's `viewUrl` and remind the sender to review it and press Send in Gmail.

**Hard rules (in SKILL.md)**

- Never call any tool that sends email (`send_message`, `reply`, `forward` or similar). The skill only drafts.
- Tutors are only ever in BCC, never in To or CC.
- Stop when there are more than 450 recipients (Gmail's per-message cap is 500).
- Never commit, upload or paste the recipient list anywhere other than the Gmail draft and the user's chat.
- Content stays within supplied facts. A missing fact is asked for, never filled in.

## Rollout

- One PR containing the endpoint, its tests, the skill, the API reference row in
  `docs/reference/api/tutor-offboarding.md` and a short section in `docs/features/tutor-offboarding.md`. There is
  no migration, environment variable or cron.
- The PR stays a draft until review is clear, then merges through the normal checks and deploys with Vercel.
- After the merge, each sender connects Gmail in claude.ai once. Aoeng's `codex/aoeng-preview` branch receives the
  skill when `main` is merged into it.

## Out of scope

Thai copy, attachments, campaign photography, batching across several drafts, scheduled sending, sending from
`admin@begiftededucation.com`, a page button for the list, and the workforce-only owner-confirmed departures list
(the 30-day rule already drops those people).
