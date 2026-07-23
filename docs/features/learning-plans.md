# Learning Plans

**Status: stable**

## Purpose

Learning Plans turns the committed BeGifted syllabus into a printable, student-specific
curriculum plan. An authorized user chooses a year and the topics to include, adds the
student name and optional tutor/notes context, previews the selected scope, and opens a
dedicated report for printing or saving as PDF.

This is intentionally a **stateless document generator**. It does not create a student
record, save a plan, or synchronize anything. Its user-entered content and syllabus scope
are described by the URL; the displayed generation date is calculated in Bangkok time when
the report renders.

## Routes and access

- **`/learning-plans`** — the interactive plan builder. It uses the lightweight committed
  topic index to select a year and topics and to summarize the resulting skill count.
- **`/learning-plans/report`** — the server-rendered, print-ready report. It validates the
  URL parameters, loads only the selected year's full syllabus, and renders the chosen
  topics and skills.

Both routes require an authenticated session plus the feature's server-authoritative access
check:

- Full-access admins remain eligible without a feature-grant row.
- A restricted admin with the exact `/learning-plans` entry remains eligible.
- A restricted admin or active teacher may instead receive a normalized-email grant in
  `learning_plan_access_grants`.
- A teacher grant does not change the user's `teacher` role or
  `allowedPages: ["/progress-tests"]`; Progress Tests therefore stays read-only and scoped
  to that teacher's students.
- Counselor, student, parent, unknown, inactive-tutor, and ungranted identities are denied.
  A grant row by itself never makes an identity eligible to sign in.

Middleware performs only the optimistic session check for `/learning-plans` and its page
subtree. The builder and report independently query the fresh grant in the Node runtime
before loading feature content, so grant and revocation changes apply on the next request
without waiting for the JWT session to refresh. The exception does not cover
`/learning-plans-extra` or a future `/api/learning-plans` namespace.

The pure role/page policy lives in `src/lib/learning-plans/access-policy.ts`; the fresh,
server-only data-access check lives alongside it in `src/lib/learning-plans/access.ts`.

## Stateless URL contract

The report accepts these query parameters:

| Parameter | Required | Contract |
|---|---|---|
| `student` | yes | Trimmed, non-empty student name; maximum 80 characters. |
| `year` | yes | Integer from 1 through 13. |
| `tutor` | no | Trimmed tutor name; maximum 80 characters. |
| `notes` | no | Trimmed free text; maximum **1,000 characters**. |
| `topics` | no | Comma-separated uppercase topic codes, such as `A,B,AA`; omission means every topic in the year. |

Repeated query keys use their first value and empty optional values are treated as omitted.
Duplicate topic codes are de-duplicated, while the report always follows the selected
syllabus year's canonical topic order rather than URL order. Unknown codes are ignored when
at least one selected code exists in that year.

The 1,000-character notes cap is a transport limit as well as a UI rule. Thai text expands
substantially when percent-encoded, so increasing the cap risks exceeding common request-URI
and header budgets. Keep the report stateless or move notes out of the query string before
raising it.

The protected report URL itself remains within the accepted request budget at that cap for
an authenticated user. If a session has expired, however, middleware must embed that
already encoded URL inside the login callback; an extreme all-Thai, maximum-length link can
then exceed the redirect-header budget. Sign in at `/login` first and reopen the original
report link. Avoid forwarding the expanded login URL.

The URL is deliberately the document state and can be copied, bookmarked, reopened, or sent
to the print route without a database lookup. That also means `student`, `tutor`, and
`notes` are intentionally visible in the browser address bar and may be retained in browser
history, copied links, proxy/request logs, and other URL telemetry. Authorized users should
treat the link as student information and must not put secrets or unnecessarily sensitive
material in the notes field. The application itself does not persist these values.

## Committed syllabus data

The repository contains the complete approved corpus under `src/lib/syllabus/data/`:

- **13 years** (`year-01.json` through `year-13.json`)
- **549 topics**
- **4,981 skills**

`topics-index.json` contains the year/topic names and counts needed by the builder.
`src/lib/syllabus/get-year-syllabus.ts` is marked `server-only` and uses an explicit dynamic
import for each year. The report therefore loads one selected year's detailed JSON on the
server; the full 4,981-skill corpus is not bundled into the client.

The committed JSON is the feature's source data. It is not fetched from Wise or Google
Sheets at runtime.

## Print and PDF behavior

The report is an A4-oriented HTML document. The report action uses the browser's print
dialogue, so authorized users can print to paper or choose the browser's **Save as PDF**
destination.
Print styles:

- remove interactive controls and the application shell;
- reset the app's fixed-height/overflow layout so a long plan can span pages;
- put the cover and overview on their own page sections;
- repeat table headers, avoid splitting rows and headings where possible, and preserve
  report colors;
- remove screen-only margins, rounded corners, and shadows from the printed sheet.

The print toolbar waits for `document.fonts.ready` before calling `window.print()`, avoiding
a print capture before the report fonts settle. PDF generation is browser-native: there is
no server PDF service, file upload, or stored artifact.

## Boundaries and failure behavior

Learning Plans has **no API endpoints, plan-content persistence, cron jobs, environment
variables, or background sync**. The only database state it owns is the
`learning_plan_access_grants` authorization table; student names, notes, topic selections,
and generated reports remain URL-backed and unstored. It does not read from or write to
Wise or Google Sheets, and it does not mutate any other BGScheduler feature.

The report fails closed on malformed URL state: a missing/blank student, an out-of-range or
non-integer year, an over-length field, or malformed topic-code CSV is rejected rather than
rendered as a valid plan. A missing syllabus and a selection with no topic code found in
that year fail the same way. These cases render a friendly error card instead of throwing a
server error or printing an empty plan; its **Back to the form** link returns to
`/learning-plans`. A mixed valid/unknown selection renders only the valid topics. Topic
selection is bounded to the selected year's committed data; a URL cannot inject arbitrary
report rows. Data integrity tests fail if any per-year file and the committed topic index
diverge.

## Verification

- `src/lib/syllabus/__tests__/data-integrity.test.ts` — locks the 13-year / 549-topic /
  4,981-skill totals and derives the complete topic index from every year file.
- `src/lib/syllabus/__tests__/report-params.test.ts` — validates required fields, year
  bounds, length caps, uppercase topic CSV, array normalization, and all-topics omission.
- `src/lib/learning-plans/__tests__/access-policy.test.ts` and `access.test.ts` — cover
  full-access admins, matching restricted admins, freshly granted active teachers,
  inactive/ungranted identities, database failure, and explicit non-admin denial.
- `src/lib/learning-plans/__tests__/migration.test.ts` — locks the normalized-email table
  contract and the three approved idempotent bootstrap grants.
- `src/__tests__/middleware.test.ts` and `src/lib/navigation/__tests__/tools.test.ts` —
  cover the exact authenticated page pass-through and navigation visibility without
  changing Home or brand-link eligibility.
- `src/components/learning-plan/__tests__/digit-safe.test.tsx` — verifies that dynamic
  report headings protect numeric runs without changing their text.
- Browser verification covers form-to-report URL generation, the friendly invalid-link
  state, mixed/empty topic selection, multipage layout, and the print/PDF dialogue; there
  are no page-render or browser-automation tests for those flows yet.

Run `npm test` for the unit suite and `npm run verify:release` for the production release
gate.

_Verified against production `main` on 2026-07-23._
