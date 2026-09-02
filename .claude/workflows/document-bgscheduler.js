export const meta = {
  name: 'document-bgscheduler',
  description: 'Rigorously re-document the entire BGScheduler repo: handbook + full API/DB reference + ops runbook, refresh the stale GSD/prose docs, with a deterministic code-vs-doc verification pass and an OPEN-QUESTIONS report.',
  whenToUse: 'When the repository documentation has drifted and needs a comprehensive, code-verified refresh.',
  phases: [
    { title: 'Inventory', detail: 'Deterministic rg/find enumeration into an authoritative spine' },
    { title: 'Foundation', detail: 'Architecture, data-flow, glossary, env, crons, ops runbook' },
    { title: 'Features', detail: 'Per-feature deep-dive: write -> verify -> correct' },
    { title: 'Reference', detail: 'Full API reference + per-domain DB/ERD reference (list-diffed vs spine)' },
    { title: 'Reconcile', detail: 'Rewrite AGENTS.md, README.md, and .planning/codebase/* against reality' },
    { title: 'Synthesize', detail: 'docs index, overview, OPEN-QUESTIONS, completeness critic' },
  ],
}

// ----------------------------------------------------------------------------
// Inputs (passed via Workflow args; safe defaults if absent)
// ----------------------------------------------------------------------------
const A = args || {}
const COMMIT = A.commitSha || 'HEAD'
const PROVENANCE = A.provenance || ('main@' + COMMIT + ' (clean tree)')
const DATE = A.date || '2026-09-02'
const MATURITY = A.maturityMap || {}
const DENYLIST = (A.denylist || [
  'docs/ai-scheduler-*.md', 'docs/ai-scheduler-eval-cases.json', 'docs/superpowers/**',
  'docs/Casemanagementsystem_prd.md', 'docs/casemanagementsystem_design.md',
  'docs/operations/release-checkpoints/**', 'docs/reference/production-route-surface.json',
  'PRD.md', 'CLAUDE.md', 'src/**', 'scripts/**', 'drizzle/**', 'vercel.json', 'package.json',
  '.claude/**', '.github/**', '**/.DS_Store', 'node_modules/**', '.next/**', '.vercel/**',
]).join(', ')
const MATURITY_STR = JSON.stringify(MATURITY)
const EXTRA_OQ = A.extraOpenQuestions || []

const WISE_WEBHOOK_FACTS = [
  'VERIFIED FACTS (Wise docs https://wise-app.gitbook.io/wise-app/wise-api-integration/webhooks-integration and subpages webhook-retry-mechanism, webhook-event-samples/*, fetched 2026-09-02):',
  'Subscription is UI-only: Wise Institute Settings > Developer options > Webhooks; select events and one POST URL. No registration API.',
  'Auth: Wise sends "an authorisation key in the header"; the header NAME is not documented and is revealed by test-firing after enabling. No HMAC signature.',
  'Delivery: success = HTTP 200 within 5 s; otherwise failed. Failed deliveries retry 8 times at 60, 180, 420, 900, 1860, 3780, 7620, 15300 seconds after the event (~4h15m). No event id, no delivery id, no ordering guarantee documented. IP allowlist section is truncated upstream (ends mid-sentence).',
  'Events (19). Session Scheduling: SessionsCreatedEvent (payload.sessions[]: _id, classId, userId, createdAt, meetingStatus e.g. UPCOMING, type SCHEDULED, title, scheduledStartTime, scheduledEndTime); SessionsUpdatedEvent (sparse delta: only changed fields, e.g. _id, classId, createdAt, meetingStatus CANCELLED, or title); SessionsDeletedEvent (full session with meetingStatus CANCELLED, title "(Cancelled)").',
  'In-Meeting (Zoom-shaped, payload.payload.object + payload.sessionId + payload.event_ts): MeetingStartedEvent (meeting.started), MeetingEndedEvent (meeting.ended, adds end_time), ParticipantJoinedMeetingEvent, ParticipantLeftMeetingEvent, SharingStaredInMeetingEvent [sic], SharingEndedInMeetingEvent, RecordingCompletedEvent (payload: userId, sessionId, recordings[]{type,url,duration,partIndex}), AttendanceComputedEvent (payload.session: _id, classId, userId only).',
  'User Classroom Access: StudentAddedToClassroomEvent (classroom{_id,name}, student{_id,name,email}), TeacherAddedToClassroomEvent (classroom{_id,name,subject,classNumber}, teacher{_id,name,email}), StudentRemovedFromClassroomEvent (+remove:true), TeacherRemovedFromClassroomEvent (+remove:true), StudentSuspensionUpdatedEvent (reason FEE_DELAY|SUSPEND, suspended bool, optional overDue{value,currency}, classroom, student, optional teacher).',
  'Fees: FeePaymentCompletedEvent (type OFFLINE, classroom, student, transaction{_id, amount{value,currency}}), FeeInvoiceChargedEvent (classroom, student, transaction{status CHARGED, type INVOICE, senderId, receiverId, chargedAt, amount, note, metadata{classId,dueOn,dueAfterDays,paid,index,paymentOptionId,installmentId,feeType,feeAssignedManually}}; docs note all instalments re-emit when one is added). Certificate: CertificateIssuedEvent (classroom, student, certificate{_id,certificateNumber,url,issuedOn}).',
  'No webhook exists for: teacher working hours/availability, leaves, teacher tags, session credits, teacher feedback submissions (SessionFeedbackSubmittedEvent), tutor payout invoices, institute locations.',
].join(' ')

// ----------------------------------------------------------------------------
// Static documentation plan
// ----------------------------------------------------------------------------
const FEATURES = [
  { key: 'tutor-search', title: 'Tutor Search', maturity: 'stable',
    file: 'docs/features/tutor-search.md',
    paths: ['src/lib/search (engine.ts, parser.ts, range-search.ts, recommend.ts, types.ts, index.ts)', 'src/app/api/search', 'src/app/api/filters', 'src/app/api/tutors', 'src/app/(app)/search', 'src/components/search'],
    notes: 'Folds in the filters and tutors supporting endpoints. The in-memory SearchIndex singleton is central — read src/lib/search/index.ts.' },
  { key: 'tutor-compare', title: 'Tutor Compare', maturity: 'legacy-redirect',
    file: 'docs/features/tutor-compare.md',
    paths: ['src/lib/search/compare.ts', 'src/app/api/compare', 'src/app/(app)/compare', 'src/components/compare'],
    notes: 'VERIFY whether the /compare page redirects to /search in current code and document accordingly.' },
  { key: 'sales-dashboard', title: 'Sales Dashboard', maturity: 'stable',
    file: 'docs/features/sales-dashboard.md',
    paths: ['src/lib/sales-dashboard', 'src/app/api/sales-dashboard', 'src/app/(app)/sales-dashboard', 'src/components/sales-dashboard'],
    notes: 'Google Sheets import + projection model. Note the sales-dashboard scope guard (.github + .claude/hooks).' },
  { key: 'credit-control', title: 'Credit Control', maturity: 'stable',
    file: 'docs/features/credit-control.md',
    paths: ['src/lib/credit-control', 'src/app/api/credit-control', 'src/app/(app)/credit-control', 'src/components/credit-control'],
    notes: 'Student credit packages, follow-up state machine, admin ownership.' },
  { key: 'payroll', title: 'Payroll', maturity: 'stable',
    file: 'docs/features/payroll.md',
    paths: ['src/lib/payroll', 'src/app/api/payroll', 'src/app/(app)/payroll', 'src/components/payroll'],
    notes: 'Teacher tiers, payout invoices, session observations, adjustments, review status.' },
  { key: 'wise-activity-audit', title: 'Wise Activity Audit', maturity: 'stable',
    file: 'docs/features/wise-activity-audit.md',
    paths: ['src/lib/wise-activity', 'src/app/api/wise-activity', 'src/app/(app)/wise-activity', 'src/components/wise-activity'],
    notes: 'Read-only audit of Wise events + reconciliation; separate from the snapshot sync.' },
  { key: 'classroom-assignments', title: 'Classroom Assignments', maturity: 'stable',
    file: 'docs/features/classroom-assignments.md',
    paths: ['src/lib/classrooms', 'src/app/api/class-assignments', 'src/app/api/classrooms', 'src/app/api/internal/class-assignments', 'src/app/(app)/class-assignments', 'src/components/class-assignments'],
    notes: 'Spans class-assignments + classrooms + internal crons (morning automation, admin email). Opt-in Wise writeback of OFFLINE locations on publish.' },
  { key: 'line-integration', title: 'LINE Integration', maturity: 'stable (scheduler write-path flag-gated)',
    file: 'docs/features/line-integration.md',
    paths: ['src/lib/line', 'src/app/api/line', 'src/app/(app)/line-review', 'src/components/line-review', 'src/lib/line/credit-bot.ts', 'src/lib/line/report-bot.ts', 'src/lib/line/credit-digest.ts', 'src/app/api/internal/line-credit-digest', 'src/app/api/internal/line-backlog-recovery'],
    notes: 'LARGE subsystem. Sections: webhook/ingest + contacts, classifier + scheduler reviews (write-path gated by ENABLE_LINE_SCHEDULER), link validation + OA resolver, wise-action logs. NARRATIVE ONLY — link to reference/api/line.md for the endpoint list; do not enumerate all routes here. Credit/report bots have their own pages (docs/features/line-credit-bot.md, docs/features/student-report.md) — link them.' },
  { key: 'room-capacity', title: 'Room Capacity', maturity: 'stable',
    file: 'docs/features/room-capacity.md',
    paths: ['src/lib/room-capacity', 'src/app/api/room-capacity', 'src/app/api/internal/sync-room-utilization', 'src/app/(app)/room-capacity', 'src/components/room-capacity'],
    notes: 'Utilization + forecast model. sync-room-utilization is manualOnly:true in src/lib/data-health/cron-registry.ts with no vercel.json entry and is POST-only — state as fact; forecast/month endpoints have no UI caller — flag in openQuestions.' },
  { key: 'data-health', title: 'Data Health', maturity: 'stable',
    file: 'docs/features/data-health.md',
    paths: ['src/lib/data-health (cron-registry.ts, run-job.ts, cron-audit.ts, dashboard.ts, status.ts)', 'src/app/api/data-health', 'src/app/api/data-health/jobs/[jobKey]/run', 'src/app/api/internal/cron-watchdog', 'src/lib/internal/cron-watchdog.ts', 'src/app/(app)/data-health', 'src/components/data-health'],
    notes: 'REFRESH. Now also owns the cron registry (22 entries, 5 manualOnly with schedule null), the cron-watchdog cron (7,37 * * * *), and the authenticated manual job runner POST /api/data-health/jobs/[jobKey]/run (404 unknown key; dangerous jobs require body {confirmed:true} else 409). Note runDataHealthJob implements 15 of 22 keys — list the 7 that 404. Note the registry maxDurationSeconds vs route maxDuration mismatch for credit_control (300 vs 800) if still present.' },
  { key: 'tutor-profiles', title: 'Tutor Profiles', maturity: 'stable',
    file: 'docs/features/tutor-profiles.md',
    paths: ['src/lib/tutor-profile-import.ts', 'src/lib/tutor-profile-vocabulary.ts', 'src/lib/tutor-business-profiles.ts', 'src/app/api/tutor-profiles', 'src/app/(app)/tutor-profiles', 'src/components/tutor-profiles'],
    notes: 'Canonical tutor business profiles, import preview/commit, vocabulary.' },
  { key: 'ai-scheduler', title: 'AI Scheduler', maturity: 'experimental',
    file: 'docs/features/ai-scheduler.md',
    paths: ['src/lib/ai', 'src/app/api/ai-scheduler', 'src/app/(app)/scheduler', 'src/components/scheduler'],
    notes: 'EXPERIMENTAL. LLM-backed scheduling assistant + the /scheduler and /scheduler/metrics UI. LINK to the existing docs/ai-scheduler-*.md eval reports (do NOT modify those files).' },
  { key: 'proposals', title: 'Proposals', maturity: 'experimental',
    file: 'docs/features/proposals.md',
    paths: ['src/lib/proposals', 'src/app/api/proposals'],
    notes: 'EXPERIMENTAL. Tutor proposal bundles + overlap detection.' },
  { key: 'leave-requests', title: 'Leave Requests', maturity: 'stable',
    file: 'docs/features/leave-requests.md',
    paths: ['src/lib/leave-requests', 'src/app/api/leave-requests', 'src/app/api/internal/sync-leave-requests', 'src/app/(app)/leave-requests', 'src/components/leave-requests', 'the leave_request* tables in src/lib/db/schema.ts'],
    notes: 'Committed and live: Google Sheets ingest (LEAVE_REQUESTS_* are read from process.env in src/lib/leave-requests/config.ts, NOT declared in env.ts), cron 15,45 * * * * (vercel.json), nav-registered (src/lib/navigation/tools.ts). Only Wise-facing capability is a dry-run cancellation preview. A doc exists — REFRESH it and delete every "uncommitted/in progress" statement.' },

  // ── Added 2026-08-05 ────────────────────────────────────────────────
  // The eight entries below were missing. That mattered beyond a coverage
  // gap: the Reconcile phase rewrites AGENTS.md, docs/README.md and
  // .planning/codebase/* FROM this list, so the four that already had docs
  // (learning-plans, post-class-feedback, student-promotions,
  // university-admissions) would have been silently dropped from every index.
  { key: 'student-schedule', title: 'Student Schedule', maturity: 'stable',
    file: 'docs/features/student-schedule.md',
    paths: ['src/lib/student-schedule (types.ts, data.ts, links.ts)', 'src/lib/calendar/month-grid.ts', 'src/lib/line/schedule-bot.ts', 'src/lib/line/schedule-bot-group.ts', 'src/lib/line/schedule-bot-command.ts', 'src/lib/line/schedule-bot-copy.ts', 'src/lib/line/mentions.ts', 'src/app/api/student-schedule', 'src/app/(app)/student-schedule', 'src/app/(print)/student-schedule', 'src/app/schedule/[token]', 'src/components/student-schedule', 'src/app/student-schedule.css'],
    notes: [
      'Shipped 2026-08-05. Reads the ACTIVE credit-control snapshot — it owns no sync of its own.',
      'Load-bearing facts to state explicitly, all verifiable in source:',
      '(1) /schedule/[token] is the app FIRST public unauthenticated PAGE. Every other middleware bypass is an API. The allowlist entry is a prefix with a deliberate trailing slash so /student-schedule stays authenticated (src/middleware.ts).',
      '(2) The capability token is 32 random bytes; ONLY its SHA-256 hash is stored. Every resolution failure — malformed, unknown, expired, revoked — renders one identical page so it cannot be used as an oracle (src/lib/student-schedule/links.ts).',
      '(3) credit_control_sessions gained wise_teacher_user_id / wise_teacher_id / teacher_name; Wise already returned these and the Zod schema was dropping them. A null teacher renders "Teacher TBC", never a guess.',
      '(4) The LINE bot is fail-closed behind LINE_SCHEDULE_BOT_ADMIN_IDS: unset/empty disables it entirely and a non-allowlisted sender gets NO reply at all.',
      '(5) Trigger is the /schedule text prefix OR an isSelf mention; the mention only exists in the LINE MOBILE app, which is why the prefix is primary.',
      '(6) LINE emits NO webhook for messages an Official Account itself sends, so /schedule can never work when typed in OA Manager — that text goes straight to the parent. Staff use /student-schedule -> Copy parent link.',
      '(7) Groups declare a family/staff audience once (line_group_settings) and confirm each new student (line_group_schedule_sends). Audience picks the message template only; it grants nothing.',
      'Cross-link to docs/features/line-integration.md, which already carries the bot rules.',
    ].join(' ') + ' (8) Live refresh: ENABLE_STUDENT_SCHEDULE_LIVE (defaults on unless "false") overlays live Wise day-requests on the parent page via src/lib/student-schedule/live.ts with an 8s deadline and a 60s per-instance memo; "rescue" mode exists in data.ts — document both.' },
  { key: 'post-class-feedback', title: 'Post-Class Feedback', maturity: 'stable',
    file: 'docs/features/post-class-feedback.md',
    paths: ['src/lib/post-class-feedback', 'src/app/api/post-class-feedback', 'src/app/(app)/post-class-feedback', 'src/components/post-class-feedback'],
    notes: 'Largest subsystem (32 postClass* tables). REFRESH, keep structure. Payout runs/accrual/unattended charging are documented in docs/features/post-class-payout.md — link, do not duplicate.' },
  { key: 'learning-plans', title: 'Learning Plans', maturity: 'stable',
    file: 'docs/features/learning-plans.md',
    paths: ['src/lib/learning-plans', 'src/lib/syllabus', 'src/app/(app)/learning-plans', 'src/app/(print)/learning-plans/report', 'src/components/learning-plan', 'src/app/learning-plans.css', 'learning_plan_access_grants table in src/lib/db/schema.ts'],
    notes: 'No API routes — page + print route only, capability-gated by learning_plan_access_grants. A doc exists but has NO status line — REFRESH and add one.' },
  { key: 'student-promotions', title: 'Student Promotions', maturity: 'stable',
    file: 'docs/features/student-promotions.md',
    paths: ['src/lib/student-promotions', 'src/app/api/student-promotions', 'src/app/(app)/student-promotions', 'src/components/student-promotions'],
    notes: 'Year-rollover automation. A doc already exists — REFRESH it.' },
  { key: 'university-admissions', title: 'University Admissions', maturity: 'stable',
    file: 'docs/features/university-admissions.md',
    paths: ['src/lib/admissions', 'src/app/api/admissions', 'src/app/(app)/admissions', 'src/components/admissions'],
    notes: '~36 tables; four roles (admin/counselor/student/parent) with per-case membership re-checked on every request. A doc already exists — REFRESH it. CAVEAT to state plainly: main holds admissions_* tables whose handling code lives only on the unmerged origin branch codex/admissions-parity-hardening; document THIS commit only and record the gap in openQuestions.' },
  { key: 'progress-tests', title: 'Progress Tests', maturity: 'stable',
    file: 'docs/features/progress-tests.md',
    paths: ['src/lib/progress-tests', 'src/app/api/progress-tests', 'src/app/(app)/progress-tests', 'src/components/progress-tests'],
    notes: 'A doc exists — REFRESH it. Every-8-classes cycle tracker built on a durable attendance ledger that survives snapshot rotation.' },
  { key: 'competitor-intelligence', title: 'Competitor Intelligence', maturity: 'stable',
    file: 'docs/features/competitor-intelligence.md',
    paths: ['src/lib/competitor-intelligence', 'src/app/api/competitor-intelligence', 'src/app/(app)/competitor-intelligence', 'src/components/competitor-intelligence'],
    notes: 'A doc exists — REFRESH it. Cron is registered weekly (25 18 * * 0 in vercel.json = Mon 01:25 Bangkok) — state it.' },
  { key: 'us-universities', title: 'US Universities (IPEDS)', maturity: 'stable',
    file: 'docs/features/us-universities.md',
    paths: ['src/lib/us-universities', 'src/app/api/us-universities', 'src/app/(app)/us-universities', 'src/components/us-universities'],
    notes: 'A doc exists — REFRESH it. IPEDS-derived reference DB feeding the admissions college list; 6-digit CIP codes and fail-closed data rules.' },
  { key: 'student-report', title: 'Student Report (Parent Class Report)', maturity: 'stable', file: 'docs/features/student-report.md',
    paths: ['src/lib/student-report (build.ts, csv.ts, db.ts, params.ts, types.ts, window.ts)', 'src/app/api/student-report', 'src/app/(app)/student-report', 'src/app/(print)/student-report/report', 'src/components/student-report', 'src/app/student-report.css', 'src/lib/line/report-bot.ts', 'src/lib/navigation/tools.ts (label "Parent Report")'],
    notes: 'NO doc exists — write from scratch. Per-family class report over a Bangkok date window from the ACTIVE credit-control snapshot (credit_control_sessions) with tutor-feedback sub-rows from post_class_feedback_versions, an A4 (print) route and CSV; also reachable via the LINE /report <code> [days | from to] command (staff-only, fail-closed and silent — REP-BOT-G1, inherits the schedule-bot admin gate). Cross-link student-schedule.md and line-credit-bot.md.' },
  { key: 'line-credit-bot', title: 'LINE Credit Bot & Daily Credit Digest', maturity: 'stable', file: 'docs/features/line-credit-bot.md',
    paths: ['src/lib/line/credit-bot.ts', 'src/lib/line/credit-digest.ts', 'src/lib/line/schedule-bot.ts and schedule-bot-group.ts (verb dispatch)', 'src/app/api/internal/line-credit-digest', 'line_credit_digest_runs and line_group_settings tables in src/lib/db/schema.ts'],
    notes: 'NO doc exists — write from scratch. /credit <code> replies with the family balances (raw Wise remainingCredits) + Parent Report link; /credit setup opts a staff group into the daily 3 2 * * * (09:03 Bangkok) digest cron. CRED-BOT-G1 staff-only, fail-closed, silent. Cross-link line-integration.md and credit-control.md.' },
  { key: 'post-class-payout', title: 'Post-Class Payout Runs & Accrual', maturity: 'stable', file: 'docs/features/post-class-payout.md',
    paths: ['src/lib/post-class-feedback/payout-*.ts', 'src/lib/post-class-feedback/auto-approval.ts', 'src/lib/post-class-feedback/payout-config.ts', 'src/app/api/post-class-feedback/payout-runs', 'src/app/api/post-class-feedback/finance', 'src/app/api/internal/post-class-feedback/payout-accrual', 'src/components/post-class-feedback (payouts/deductions tabs)', 'postClassPayout*, postClassDeduction*, postClassFinancePeriods tables', 'scripts/*payout*.ts (npm payout:* scripts in package.json)'],
    notes: 'NO doc exists — write from scratch. Hourly payout-accrual cron (33 * * * *), unattended charging/auto-approval at the feedback deadline, rolling ledger writes to the Google Sheets master payout workbook, auto-un-charge by row deletion, finalize after the settlement lag. Flags POST_CLASS_AUTO_APPROVE_ENABLED and POST_CLASS_PAYOUT_WRITES_ENABLED are read from process.env (NOT env.ts) — state the exact fail-closed default of each. Read-only toward Wise; never writes Payroll.' },
]

const FOUNDATION = [
  { key: 'architecture', file: 'docs/handbook/architecture.md', title: 'System Architecture',
    reads: ['src/lib/search/index.ts (in-memory index singleton)', 'src/lib/sync/orchestrator.ts', 'src/lib/db/index.ts', 'src/middleware.ts', 'src/lib/env.ts'],
    ask: 'Document the layered architecture (Wise client -> normalization -> sync orchestrator -> snapshot tables -> in-memory SearchIndex -> API routes -> UI). Explain the snapshot-versioned data model and atomic promotion, the in-memory index singleton with stale detection, and the fail-closed rule. Include a Mermaid container/flow diagram (fenced mermaid block) and a request-lifecycle description.' },
  { key: 'data-flow', file: 'docs/handbook/data-flow.md', title: 'Data Flow (ETL)',
    reads: ['src/lib/sync/orchestrator.ts', 'src/lib/wise/fetchers.ts', 'src/lib/wise/client.ts', 'src/lib/normalization/* (identity, availability, leaves, modality, qualifications, sessions, timezone)'],
    ask: 'Document the end-to-end ETL: Wise API fetch -> identity resolution -> availability/leaves -> future sessions -> normalization -> write snapshot tables -> validate -> atomic promote -> index rebuild. Include a Mermaid sequence diagram (fenced mermaid block).' },
  { key: 'conventions', file: 'docs/handbook/conventions.md', title: 'Conventions',
    reads: ['.planning/codebase/CONVENTIONS.md (FORMAT/STRUCTURE template only — its facts are stale)'],
    ask: 'Write a CONCISE conventions page that POINTS to .planning/codebase/CONVENTIONS.md as the detailed source (do not fork it). Capture only handbook-level highlights verified against code: kebab-case files, named exports, Zod at route boundaries, fail-closed defaults, Asia/Bangkok time, lazy DB/index singletons. Link to the GSD source.' },
  { key: 'glossary', file: 'docs/handbook/glossary.md', title: 'Glossary',
    reads: ['src/lib/normalization/identity.ts', 'src/lib/search/types.ts', 'src/lib/normalization/timezone.ts'],
    ask: 'Define the domain vocabulary with one-line, code-grounded definitions: snapshot, active snapshot, identity group, alias, modality (online/onsite), qualification (subject/curriculum/level/examPrep), recurring vs one-time mode, slot, leave, blocking session, tutor tier, OA (LINE official account), namespace, institute, Needs Review.' },
  { key: 'not-the-nextjs', file: 'docs/handbook/not-the-nextjs-you-know.md', title: 'Not the Next.js You Know',
    reads: ['AGENTS.md (the opening warning — identify WHICH surprises are real, then verify each against code)', 'src/lib/search/index.ts', 'src/lib/sync/orchestrator.ts'],
    ask: 'Elevate the AGENTS.md opening warning into a first-read gotchas page: the in-memory SearchIndex singleton (reads never hit Wise live), snapshot-versioned reads, sync-before-serve, fail-closed Needs Review routing, Next.js 16 specifics. Verify each claim against code and cite file:line. Keep it punchy.' },
  { key: 'ops-runbook', file: 'docs/operations/runbook.md', title: 'Operations Runbook',
    reads: ['package.json (scripts)', 'README.md', 'src/lib/internal/cron-auth.ts', 'vercel.json', 'src/app/api/internal/sync-wise/route.ts', 'scripts/assert-production-deploy-ready.mjs', 'src/lib/data-health/cron-registry.ts', 'src/app/api/data-health/jobs/[jobKey]/run/route.ts'],
    ask: 'Write an operational runbook: deploy = push to main (git push origin <branch>:main; Vercel Git integration auto-deploys); guarded manual path npm run deploy:prod ONLY from the Vercel-linked worktree on main (verify:release -> scripts/assert-production-deploy-ready.mjs refuses non-main, dirty or untracked files, or HEAD != origin/main -> vercel --prod); NEVER a bare npx vercel --prod from an unlinked worktree (it creates a stray Vercel project); manual job runs via the /data-health UI or POST /api/data-health/jobs/[jobKey]/run, the npm scripts (db:generate, db:migrate, db:seed, test*), manually triggering each sync via curl with CRON_SECRET, the single-flight guard + abandoned-run recovery, snapshot rollback (failed sync preserves previous active snapshot), and where to look when a sync fails.' },
  { key: 'ops-auth', file: 'docs/operations/auth-and-access.md', title: 'Auth & Access',
    reads: ['src/lib/auth.ts (READ only — do not edit)', 'src/lib/auth-edge.ts', 'src/middleware.ts', 'src/app/api/auth'],
    ask: 'Document the auth model: Auth.js (NextAuth) Google provider, the admin_users allowlist, the middleware gate (which paths bypass auth: /login, /api/auth/*, /api/internal/*), and the auth vs auth-edge split. List the allowlisted admin emails count (verify against seed/schema, not memory). Mention the maintenance gate that runs above the auth check (src/lib/maintenance.ts, middleware), the /schedule/ public prefix with its trailing slash, the /api/line/webhook and oa-resolver public routes, and page-restricted users (allowedPages) — verify every middleware line number you cite.' },
  { key: 'ops-observability', file: 'docs/operations/observability.md', title: 'Observability',
    reads: ['src/lib/db/schema.ts (sync_runs, *_sync_runs, snapshot_stats, data_issues — read those table slices)', 'src/app/api/data-health/route.ts'],
    ask: 'Document how to observe system health: the sync_runs / credit_control_sync_runs / wise_activity_sync_runs / payroll_sync_runs tables, snapshot_stats, data_issues by type/severity, and the /data-health surface. Describe failure modes and how stale snapshots are flagged.' },
  { key: 'ref-env', file: 'docs/reference/env.md', title: 'Environment Variables',
    reads: ['src/lib/env.ts (the Zod schema is the source of truth)', '.env.example'],
    ask: 'Produce the canonical env reference from src/lib/env.ts (18 declared: count required .min(1)/.url(), defaulted, optional exactly). State plainly that src/lib/env.ts is imported by nothing (verify with rg "lib/env" src) so it does not throw at startup. Reconcile against the AGENTS.md table (claims "9 required", lists 12 rows incl. 3 LEAVE_REQUESTS_* vars that env.ts does NOT declare). Add a second section for variables read directly via process.env (rg "process\\.env\\." src scripts): LEAVE_REQUESTS_*, POST_CLASS_PAYOUT_*, POST_CLASS_AUTO_APPROVE_*, SCHEDULE_EMAIL_*, OPENAI_*, ENABLE_AI_SCHEDULER, RESEND_API_KEY, WISE_SESSION_*_VERIFIED, and any others found.' },
  { key: 'ref-crons', file: 'docs/reference/crons.md', title: 'Cron Schedule',
    reads: ['vercel.json (authoritative for scheduled crons)', 'the spine cron data provided below', 'src/lib/data-health/cron-registry.ts', 'src/__tests__/vercel-crons.test.ts', 'src/lib/data-health/__tests__/cron-registry.test.ts'],
    ask: 'Document all 17 vercel.json crons (schedule UTC + Bangkok, endpoint, registry key, maxDuration, what it does, invocations/day) and cross-check against the 22-entry registry: every vercel.json path must appear with the same schedule (mismatch -> openQuestions). Compare registry maxDurationSeconds with each route file export const maxDuration and list mismatches. Add "Manual-only jobs" for the 5 manualOnly registry entries (schedule null; runnable via POST /api/data-health/jobs/[jobKey]/run; sync-room-utilization is POST-only) and "Internal handlers in neither" if any exist. Add a same-minute collision table computed from the schedules.' },
  { key: 'ref-wise-api', file: 'docs/reference/wise-api.md', title: 'Wise API Surface',
    reads: ['src/lib/wise/client.ts', 'src/lib/wise/fetchers.ts', 'src/lib/wise/types.ts', 'src/lib/credit-control/wise.ts', 'every module calling the Wise client (rg -l "lib/wise/client" src/lib)'],
    ask: 'Refresh the existing page in place (keep its structure): every Wise endpoint the app calls (method, path, purpose, calling module and cron), read vs write, and the flag gating each write path; retry/backoff and the per-invocation concurrency limiter; the 26-window 180-day availability stitching. Add a short "Webhooks" pointer to docs/reference/wise-webhooks.md.' },
  { key: 'ref-wise-webhooks', file: 'docs/reference/wise-webhooks.md', title: 'Wise Webhooks (catalogue; not yet consumed by the app)',
    reads: ['src/app/api/line/webhook/route.ts (the fast-ack + after() pattern a receiver would copy)', 'src/lib/wise-activity/format.ts (polled audit-feed event names for the name-mismatch table)'],
    ask: WISE_WEBHOOK_FACTS + ' Write the mechanical reference from these verified facts (do NOT invent fields). Sections: how subscription works; auth and delivery semantics; the 19-event catalogue grouped as listed with the payload fields given; a table mapping each webhook event to the repo polling path it could trigger and what still needs periodic reconciliation; the gaps (no availability/leave/tag/credit/feedback/payout events); the name mismatch versus the polled /institutes/{id}/events feed names in src/lib/wise-activity/format.ts. State plainly that the app has NO webhook receiver today (grep src for "wise/webhook" -> none) and link the proposal docs/proposals/2026-09-02-cron-efficiency-and-wise-webhooks.md if it exists.' },
  { key: 'ops-maintenance', file: 'docs/operations/maintenance-mode.md', title: 'Maintenance Mode',
    reads: ['src/lib/maintenance.ts', 'src/middleware.ts', 'src/lib/env.ts (MAINTENANCE_MODE, MAINTENANCE_BYPASS_EMAILS)', 'src/lib/__tests__/maintenance.test.ts', 'src/__tests__/middleware.test.ts'],
    ask: 'Document the MAINT-0x rules from code: exact-string "true" engages; the gate runs BEFORE the auth allowlist in middleware; exempt prefixes keep /api/internal/* crons and /schedule/ alive; bypass emails are fail-closed; what users see; how to flip it on/off in Vercel env (value change + redeploy). Link from operations/runbook.md and operations/auth-and-access.md.' },
]

// API reference groups. key is used for spine grouping; index gets all routes.
const API_GROUPS = [
  { key: 'index', file: 'index', title: 'API Reference — All Endpoints' },
  { key: 'line', file: 'line', title: 'LINE API' },
  { key: 'credit-control', file: 'credit-control', title: 'Credit Control API' },
  { key: 'classrooms-and-assignments', file: 'classrooms-and-assignments', title: 'Classrooms & Assignments API' },
  { key: 'sales-dashboard', file: 'sales-dashboard', title: 'Sales Dashboard API' },
  { key: 'payroll', file: 'payroll', title: 'Payroll API' },
  { key: 'wise-activity', file: 'wise-activity', title: 'Wise Activity API' },
  { key: 'room-capacity', file: 'room-capacity', title: 'Room Capacity API' },
  { key: 'ai-scheduler', file: 'ai-scheduler', title: 'AI Scheduler API' },
  { key: 'proposals', file: 'proposals', title: 'Proposals API' },
  { key: 'university-admissions', file: 'university-admissions', title: 'University Admissions API' },
  { key: 'us-universities', file: 'us-universities', title: 'US Universities (IPEDS) API' },
  { key: 'post-class-feedback', file: 'post-class-feedback', title: 'Post-Class Feedback & Payout API' },
  { key: 'student-promotions', file: 'student-promotions', title: 'Student Promotions API' },
  { key: 'competitor-intelligence', file: 'competitor-intelligence', title: 'Competitor Intelligence API' },
  { key: 'progress-tests', file: 'progress-tests', title: 'Progress Tests API' },
  { key: 'leave-requests', file: 'leave-requests', title: 'Leave Requests API' },
  { key: 'student-schedule-and-report', file: 'student-schedule-and-report', title: 'Student Schedule & Student Report API' },
  { key: 'tutor-profiles', file: 'tutor-profiles', title: 'Tutor Profiles API' },
  { key: 'data-health', file: 'data-health', title: 'Data Health & Cron Watchdog API' },
  { key: 'internal-crons', file: 'internal-crons', title: 'Internal / Cron API (all /api/internal/* handlers)' },
  { key: 'misc', file: 'misc', title: 'Search, Tutors, Filters, Compare, Home, Auth, Admin' },
]

const DB_DOMAINS = [
  { domain: 'core', file: 'erd-core', title: 'Core: Snapshots, Sync Runs, Cron Invocations, Tutors, Normalization, Admin Users, OAuth Tokens' },
  { domain: 'credit-control', file: 'erd-credit-control', title: 'Credit Control' },
  { domain: 'classrooms', file: 'erd-classrooms', title: 'Classrooms & Assignments' },
  { domain: 'line', file: 'erd-line', title: 'LINE' },
  { domain: 'sales-dashboard', file: 'erd-sales-dashboard', title: 'Sales Dashboard' },
  { domain: 'payroll', file: 'erd-payroll', title: 'Payroll' },
  { domain: 'tutor-profiles', file: 'erd-tutor-profiles', title: 'Tutor Profiles' },
  { domain: 'leave-requests', file: 'erd-leave-requests', title: 'Leave Requests' },
  { domain: 'room-capacity', file: 'erd-room-capacity', title: 'Room Capacity' },
  { domain: 'ai-and-proposals', file: 'erd-ai-and-proposals', title: 'AI Scheduler & Proposals' },
  { domain: 'university-admissions', file: 'erd-university-admissions', title: 'University Admissions & IPEDS (US Universities)' },
  { domain: 'post-class-feedback', file: 'erd-post-class-feedback', title: 'Post-Class Feedback & Payout' },
  { domain: 'competitor-intelligence', file: 'erd-competitor-intelligence', title: 'Competitor Intelligence' },
  { domain: 'progress-tests', file: 'erd-progress-tests', title: 'Progress Tests' },
  { domain: 'student-promotions', file: 'erd-student-promotions', title: 'Student Promotions' },
  { domain: 'wise-activity', file: 'erd-wise-activity', title: 'Wise Activity Audit' },
  { domain: 'student-schedule', file: 'erd-student-schedule', title: 'Student Schedule Links' },
  { domain: 'learning-plans', file: 'erd-learning-plans', title: 'Learning Plans' },
]

const PLANNING = ['STACK', 'ARCHITECTURE', 'CONVENTIONS', 'STRUCTURE', 'INTEGRATIONS', 'TESTING', 'CONCERNS']

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const SPINE_SCHEMA = {
  type: 'object', additionalProperties: true,
  required: ['routes', 'tables', 'crons'],
  properties: {
    routes: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['method', 'path'], properties: { method: { type: 'string' }, path: { type: 'string' }, file: { type: 'string' } } } },
    tables: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['varName'], properties: { name: { type: 'string' }, varName: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, tracked: { type: 'boolean' } } } },
    enums: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, varName: { type: 'string' } } } },
    foreignKeys: { type: 'array', items: { type: 'object', additionalProperties: true } },
    crons: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' }, schedule: { type: 'string' } } } },
    registry: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { key: { type: 'string' }, path: { type: 'string' }, schedule: { type: ['string', 'null'] }, manualOnly: { type: 'boolean' } } } },
    manualOnlyJobs: { type: 'array', items: { type: 'string' } },
    internalHandlers: { type: 'array', items: { type: 'string' } },
    orphanCrons: { type: 'array', items: { type: 'string' } },
    pages: { type: 'array', items: { type: 'string' } },
    publicPages: { type: 'array', items: { type: 'string' } },
    libDirs: { type: 'array', items: { type: 'string' } },
    libTopLevelFiles: { type: 'array', items: { type: 'string' } },
    componentDirs: { type: 'array', items: { type: 'string' } },
    testFileCount: { type: 'number' },
    integrationTestFileCount: { type: 'number' },
    migrationCount: { type: 'number' },
    enumCount: { type: 'number' },
    commit: { type: 'string' },
    git: { type: 'object', additionalProperties: true, properties: { modified: { type: 'array', items: { type: 'string' } }, untracked: { type: 'array', items: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}

const DOC_RESULT = {
  type: 'object', additionalProperties: true,
  required: ['file', 'wrote'],
  properties: {
    file: { type: 'string' },
    wrote: { type: 'boolean' },
    summary: { type: 'string' },
    claimedRoutes: { type: 'array', items: { type: 'string' } },
    claimedTables: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_RESULT = {
  type: 'object', additionalProperties: true,
  required: ['file', 'verdict'],
  properties: {
    file: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    inaccuracies: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { claim: { type: 'string' }, evidence: { type: 'string' }, correction: { type: 'string' } } } },
    unverifiedClaims: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { claim: { type: 'string' }, reason: { type: 'string' } } } },
    duplicationViolations: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const CRITIC_SCHEMA = { type: 'object', additionalProperties: true, properties: { gaps: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } }

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function rules(extra) {
  return [
    'GROUND RULES (follow exactly):',
    '- The current working directory is the repo root. Write files to the EXACT repo-relative path given, using the Write tool. Create parent dirs as needed.',
    '- Derive EVERY fact from code you actually open. Cite file:line for non-obvious claims. Do NOT cite from memory.',
    '- Any inventory list provided below (routes/tables/crons) is AUTHORITATIVE. Never invent or omit items. If you think it is wrong, record it in openQuestions; do not silently deviate.',
    '- .planning/codebase/*, AGENTS.md, README.md and every existing docs/** page date from the 2026-08-05 pass and are PARTIALLY stale (they say 188 tables / 15 crons / 241 endpoints in 178 files / 369 tests / 25 pages / 21 nav tools). Use them as format/voice templates and REFRESH in place; re-derive every number and every route/table list from code.',
    '- NEVER write to or modify these paths (reading is fine): ' + DENYLIST + '. Document the in-flight source but do not edit it.',
    '- Only write under docs/**, AGENTS.md, README.md, .planning/codebase/**. Never create or touch anything else.',
    '- Maturity badges come from this map; APPLY them, do not infer (no @deprecated markers exist in code). Verify the underlying mechanism. Map: ' + MATURITY_STR + '.',
    '- Canonical-home rule: reference/* owns mechanical detail (columns, endpoint signatures); features/* owns meaning (purpose, rules, flows, why). Feature docs LINK to reference; they must NOT restate column lists or full endpoint signatures.',
    '- End every document with this exact footer line: _Verified against ' + PROVENANCE + ' on ' + DATE + '._',
    extra || '',
  ].join('\n')
}

function apiGroupOf(path) {
  const is = p => path.indexOf(p) === 0
  if (is('/api/line') || is('/api/internal/line-')) return 'line'
  if (is('/api/credit-control') || is('/api/internal/sync-credit-control')) return 'credit-control'
  if (is('/api/class-assignments') || is('/api/classrooms') || is('/api/internal/class-assignments')) return 'classrooms-and-assignments'
  if (is('/api/sales-dashboard') || is('/api/internal/sync-sales-dashboard')) return 'sales-dashboard'
  if (is('/api/payroll')) return 'payroll'
  if (is('/api/wise-activity') || is('/api/internal/sync-wise-activity')) return 'wise-activity'
  if (is('/api/room-capacity') || is('/api/internal/sync-room-utilization')) return 'room-capacity'
  if (is('/api/ai-scheduler')) return 'ai-scheduler'
  if (is('/api/proposals')) return 'proposals'
  if (is('/api/admissions') || is('/api/internal/admissions-notifications')) return 'university-admissions'
  if (is('/api/us-universities')) return 'us-universities'
  if (is('/api/post-class-feedback') || is('/api/internal/post-class-feedback') || is('/api/internal/sync-post-class-feedback')) return 'post-class-feedback'
  if (is('/api/student-promotions') || is('/api/internal/student-promotions')) return 'student-promotions'
  if (is('/api/competitor-intelligence') || is('/api/internal/sync-competitor-intelligence')) return 'competitor-intelligence'
  if (is('/api/progress-tests') || is('/api/internal/progress-tests') || is('/api/internal/sync-progress-tests')) return 'progress-tests'
  if (is('/api/leave-requests') || is('/api/internal/sync-leave-requests')) return 'leave-requests'
  if (is('/api/student-schedule') || is('/api/student-report')) return 'student-schedule-and-report'
  if (is('/api/tutor-profiles')) return 'tutor-profiles'
  if (is('/api/data-health') || is('/api/internal/cron-watchdog')) return 'data-health'
  if (is('/api/internal/')) return 'internal-crons'
  return 'misc'
}

function dbDomainOf(v) {
  if (/^creditControl/.test(v)) return 'credit-control'
  if (/^classroom/.test(v)) return 'classrooms'
  if (/^line/.test(v)) return 'line'
  if (/^salesDashboard/.test(v)) return 'sales-dashboard'
  if (/^payroll/.test(v)) return 'payroll'
  if (/^leaveRequest/.test(v)) return 'leave-requests'
  if (/^roomCapacity/.test(v) || /^roomUtilization/.test(v)) return 'room-capacity'
  if (/^aiScheduler/.test(v) || /^proposal/.test(v)) return 'ai-and-proposals'
  if (/^(tutorContacts|tutorBusinessProfiles)$/.test(v)) return 'tutor-profiles'
  if (/^postClass/.test(v)) return 'post-class-feedback'
  if (/^admissions/.test(v) || /^ipeds/.test(v)) return 'university-admissions'
  if (/^competitor/.test(v)) return 'competitor-intelligence'
  if (/^progressTest/.test(v)) return 'progress-tests'
  if (/^studentPromotion/.test(v)) return 'student-promotions'
  if (/^studentSchedule/.test(v)) return 'student-schedule'
  if (/^learningPlan/.test(v)) return 'learning-plans'
  if (/^wiseActivity/.test(v)) return 'wise-activity'
  return 'core'
}

function routeKey(r) { return String(r.method).toUpperCase() + ' ' + r.path }
function fmtRoutes(rs) { return rs.map(routeKey).join('\n') }
function fmtTables(ts) { return ts.map(t => (t.varName || t.name) + ' (schema.ts lines ' + t.startLine + '-' + t.endLine + ')').join('\n') }

// ----------------------------------------------------------------------------
// Prompt builders
// ----------------------------------------------------------------------------
function inventoryPrompt() {
  return [
    'You are building the AUTHORITATIVE inventory spine for the BGScheduler repo. Run the commands below with the Bash tool and report ONLY what their output shows. Do not guess or recall from memory. This data is the oracle every other doc agent will trust.',
    '',
    '1. ENDPOINTS. Run: rg -n --no-heading -g "route.ts" -e "export (async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)" -e "export const (GET|POST|PUT|PATCH|DELETE)\\b" -e "export const \\{[^}]*\\} = handlers" src/app/api',
    '   For each match, the HTTP method is in the match text. Derive the URL path from the file path: strip the leading "src/app", drop the trailing "/route.ts". Keep dynamic segments like [contactId]. Drop Next.js route-group segments wrapped in parentheses such as (app) (they do not appear in the URL). Example: src/app/api/credit-control/actions/bulk/route.ts -> /api/credit-control/actions/bulk. Example: src/app/api/line/contacts/[contactId]/route.ts -> /api/line/contacts/[contactId]. Produce routes[] of {method, path, file}. A single file may export several methods -> several entries.',
    '   For "export const { GET, POST } = handlers" (src/app/api/auth/[...nextauth]/route.ts) emit one entry per listed method. Include OPTIONS handlers as method OPTIONS but tag them {cors:true} — they are CORS preflight, not business endpoints; the business endpoint count excludes them (expected 243 = 241 functions + 2 destructured). Then run: find src/app/api -name route.ts | wc -l  and confirm every route.ts file contributed at least one entry (expected 180 files); list any file with zero matches in notes.',
    '',
    '2. TABLES. Run: rg -n "= pgTable\\(" src/lib/db/schema.ts  (names + start lines). The endLine of a table is the line just before the next pgTable start (or end of file for the last). Run: wc -l src/lib/db/schema.ts to get the file length. Produce tables[] of {name (the SQL table string, 1st arg to pgTable), varName (the JS const), startLine, endLine}.',
    '   ENUMS. Run: rg -n "pgEnum\\(" src/lib/db/schema.ts -> enums[] of {name, varName}.',
    '   FKS. Run: rg -n "\\.references\\(" src/lib/db/schema.ts -> foreignKeys[] (best-effort {fromTable, fromColumn, toTable} from surrounding context; ok to leave fields blank if unclear).',
    '',
    '3. CRONS. Read vercel.json and list its crons[] as {path, schedule}. Run: find src/app/api/internal -name route.ts to list internal handlers; convert each to its URL path -> internalHandlers[]. orphanCrons[] = internalHandlers whose path is NOT present in vercel.json crons.',
    '   Read src/lib/data-health/cron-registry.ts and produce registry[] of {key, path, schedule, manualOnly} (expected 22 entries, 5 manualOnly). manualOnlyJobs[] = registry paths with manualOnly:true. orphanCrons[] = internalHandlers NOT in vercel.json AND NOT manualOnly in the registry. Note any registry schedule that differs from vercel.json.',
    '',
    '4. PAGES. Run: find src/app -name page.tsx -> pages[] as URL paths with route-group segments like (app)/(print) dropped (expected 31: 26 under (app), plus /login, /schedule/[token], and three (print) report routes). publicPages[] = those served outside the (app) group.',
    '5. LIB. Run: ls -1 src/lib -> separate directories (libDirs[]) from top-level .ts files (libTopLevelFiles[]).',
    '6. COMPONENTS. Run: ls -1 src/components -> componentDirs[].',
    '7. TESTS. Run: rg --files -g "**/__tests__/**/*.test.ts" -g "**/__tests__/**/*.test.tsx" | wc -l -> testFileCount. Also: rg --files -g "**/*.integration.test.ts" | wc -l -> integrationTestFileCount; ls drizzle/*.sql | wc -l -> migrationCount; rg -c "pgEnum\\(" src/lib/db/schema.ts -> enumCount.',
    '8. GIT. Run: git status --short -> git.modified[] (lines starting with " M" or "M ") and git.untracked[] (lines starting with "??"). Run: git rev-parse --short HEAD -> commit. The tree is expected CLEAN; if not, list it in notes.',
    '',
    'Return the full spine object. Set notes to anything surprising (e.g. a route group with no route.ts, an unexpected count). Accuracy and completeness are the entire point.',
  ].join('\n')
}

function featureWritePrompt(f) {
  return [
    'Write the feature deep-dive document at: ' + f.file,
    'Feature: ' + f.title + '  |  maturity: ' + (MATURITY[f.key] || f.maturity),
    'Relevant code locations to read: ' + f.paths.join('; '),
    'Notes: ' + f.notes,
    '',
    'Read the actual code in those locations. Then write a comprehensive feature doc following this section contract:',
    'If ' + f.file + ' already exists, READ it first and keep its section order and any still-accurate prose; rewrite what code contradicts.',
    '1. Title + a one-line maturity badge (e.g. **Status: experimental**).',
    '2. Purpose — what it does and who uses it.',
    '3. Conceptual data model — the tables it reads/writes, described conceptually, with a LINK to the relevant docs/reference/database/erd-*.md (do NOT dump columns here).',
    '4. API surface — a short list of the endpoints with a one-line purpose each, LINKING to the relevant docs/reference/api/*.md for full contracts (do NOT restate request/response schemas).',
    '5. UI — the page(s) under src/app/(app) and key components.',
    '6. Data flow — how a request/operation moves through the layers; include a Mermaid diagram (fenced mermaid block) if it clarifies.',
    '7. Business rules & edge cases — the non-obvious logic, fail-closed behavior, flags. Cite file:line.',
    '8. Tests — where the tests live and what they cover.',
    '9. Open questions — anything only a human can answer (intent, suspected dead code, ambiguity).',
    '',
    'After writing the file, return DOC_RESULT with file, wrote:true, a one-line summary, and openQuestions[].',
    '',
    rules(),
  ].join('\n')
}

function featureVerifyPrompt(f) {
  return [
    'Adversarially VERIFY the document at ' + f.file + ' against the actual code. Your job is to BREAK it, not bless it. Assume every claim is wrong until code proves it.',
    'Read ' + f.file + ', then independently read the code under: ' + f.paths.join('; '),
    'For each substantive prose claim: either confirm it with a file:line you actually read, or mark it as an inaccuracy (with the correction) or unverified (with the reason).',
    'Also flag DUPLICATION VIOLATIONS: any place the feature doc restates a full column list or a full endpoint request/response signature (those belong only in reference/* — the feature doc should link instead).',
    'A doc with zero findings is suspicious — look harder before declaring PASS.',
    'Return VERIFY_RESULT: verdict PASS or FAIL, inaccuracies[], unverifiedClaims[], duplicationViolations[], openQuestions[]. Do NOT edit the file.',
    '',
    rules(),
  ].join('\n')
}

function featureCorrectPrompt(f, v) {
  return [
    'The document at ' + f.file + ' FAILED verification. Apply the corrections precisely using the Edit/Write tools, then re-stamp the footer.',
    'Inaccuracies to fix: ' + JSON.stringify(v.inaccuracies || []),
    'Unverified claims to either prove (add a file:line citation) or soften/remove: ' + JSON.stringify(v.unverifiedClaims || []),
    'Duplication violations to resolve by replacing the dump with a link to the relevant reference doc: ' + JSON.stringify(v.duplicationViolations || []),
    'Re-read the cited code to confirm each fix. Return DOC_RESULT with file, wrote:true, summary of changes, and any remaining openQuestions[].',
    '',
    rules(),
  ].join('\n')
}

function foundationPrompt(d) {
  return [
    'Write the document at: ' + d.file + '  (' + d.title + ')',
    'Read these sources first: ' + d.reads.join('; '),
    'Task: ' + d.ask,
    '',
    'Write a thorough, code-grounded document. Cite file:line for non-obvious claims. Use Mermaid (fenced mermaid blocks) where a diagram clarifies.',
    'After writing, return DOC_RESULT with file, wrote:true, summary, and openQuestions[].',
    '',
    rules(),
  ].join('\n')
}

function docVerifyPrompt(file, title, reads) {
  return [
    'Adversarially VERIFY the document at ' + file + ' (' + title + ') against the actual code. Your job is to BREAK it, not bless it. Assume every claim is wrong until code proves it.',
    'Read ' + file + ', then independently read the sources it rests on: ' + (reads || []).join('; '),
    'For each substantive prose claim — every count, schedule, env var, file path, flag default, line-number citation: either confirm it with a file:line you actually read, or mark it as an inaccuracy (with the correction) or unverified (with the reason).',
    'Also flag DUPLICATION VIOLATIONS: any place this page restates detail that belongs to another canonical page (reference/* owns columns and endpoint signatures; features/* owns meaning) instead of linking.',
    'A doc with zero findings is suspicious — look harder before declaring PASS.',
    'Return VERIFY_RESULT: verdict PASS or FAIL, inaccuracies[], unverifiedClaims[], duplicationViolations[], openQuestions[]. Do NOT edit the file.',
    '',
    rules(),
  ].join('\n')
}

function docCorrectPrompt(file, v) {
  return [
    'The document at ' + file + ' FAILED verification. Apply the corrections precisely using the Edit/Write tools, then re-stamp the footer.',
    'Inaccuracies to fix: ' + JSON.stringify((v && v.inaccuracies) || []),
    'Unverified claims to either prove (add a file:line citation) or soften/remove: ' + JSON.stringify((v && v.unverifiedClaims) || []),
    'Duplication violations to resolve by replacing the dump with a link to the canonical page: ' + JSON.stringify((v && v.duplicationViolations) || []),
    'Re-read the cited code to confirm each fix. Return DOC_RESULT with file, wrote:true, summary of changes, and any remaining openQuestions[].',
    '',
    rules(),
  ].join('\n')
}

function apiRefPrompt(g, groupRoutes, cronNote) {
  if (g.key === 'index') {
    return [
      'Write the master API reference index at: docs/reference/api/index.md',
      'This is the canonical lookup of EVERY endpoint. Below is the AUTHORITATIVE list of all ' + groupRoutes.length + ' endpoints (METHOD path). Produce a single Markdown table with columns: Method, Path, Group, Auth (public/admin/cron), Brief purpose. Group each endpoint using its path prefix. For Auth: /api/internal/* and the cron routes are CRON_SECRET-protected; /api/auth/* is public; the rest require an authenticated admin session (verify against src/middleware.ts).',
      'Link each group to its detail page docs/reference/api/<group>.md. Do NOT write full request/response schemas here (those live in the per-group pages).',
      'Authoritative endpoint list:',
      fmtRoutes(groupRoutes),
      '',
      'After writing, return DOC_RESULT with file:"docs/reference/api/index.md", wrote:true, and claimedRoutes[] = the exact list of "METHOD /path" you included.',
      '',
      rules(),
    ].join('\n')
  }
  return [
    'Write the API reference page at: docs/reference/api/' + g.file + '.md  (' + g.title + ')',
    'Document EXACTLY these ' + groupRoutes.length + ' endpoints — no more, no fewer:',
    fmtRoutes(groupRoutes),
    (cronNote || ''),
    '',
    'For EACH endpoint: open its route.ts file, then document — HTTP method + path, auth requirement, the request shape (query/body, citing the Zod schema if present), the response shape, key side effects, and error/status codes. Group related endpoints with headings. Keep it accurate to the code (cite file:line).',
    'After writing, return DOC_RESULT with file:"docs/reference/api/' + g.file + '.md", wrote:true, summary, openQuestions[], and claimedRoutes[] = the exact list of "METHOD /path" you documented (must match the authoritative list above).',
    '',
    rules(),
  ].join('\n')
}

function apiCorrectPrompt(g, file, missing, extra) {
  return [
    'The API reference page ' + file + ' does not match the authoritative endpoint list (deterministic list-diff against the inventory spine).',
    missing.length ? ('MISSING endpoints you must ADD (open each route.ts and document it): \n' + missing.join('\n')) : 'No missing endpoints.',
    extra.length ? ('EXTRA endpoints you must REMOVE (they are not in the spine — likely hallucinated or mis-pathed): \n' + extra.join('\n')) : 'No extra endpoints.',
    'Edit the file to exactly cover the authoritative set, then return DOC_RESULT with claimedRoutes[] = the corrected full list.',
    '',
    rules(),
  ].join('\n')
}

function erdPrompt(d, domTables) {
  return [
    'Write the database reference + ER diagram at: docs/reference/database/' + d.file + '.md  (' + d.title + ')',
    'Document EXACTLY these ' + domTables.length + ' tables — no more, no fewer (varName + schema.ts line range):',
    fmtTables(domTables),
    '',
    'Read those exact line ranges in src/lib/db/schema.ts (do not read the whole file). Then produce:',
    '1. A Mermaid erDiagram (fenced mermaid block). To keep it legible, show each entity with only its primary key, foreign keys, and 1-2 identifying columns. If this domain references core tables (snapshots, tutors, identity groups), represent each referenced core table as a single stub node rather than expanding it.',
    '2. A short prose description per table: its grain (one row per what), key columns, and relationships. Full column lookups live in docs/reference/database/index.md — link there, do not duplicate the whole column list.',
    'After writing, return DOC_RESULT with file:"docs/reference/database/' + d.file + '.md", wrote:true, openQuestions[], and claimedTables[] = the exact varNames you documented.',
    '',
    rules(),
  ].join('\n')
}

function erdCorrectPrompt(d, file, missing, extra) {
  return [
    'The DB reference page ' + file + ' does not match the authoritative table set for this domain (list-diff vs spine).',
    missing.length ? ('MISSING tables to ADD (read their schema.ts line ranges): \n' + missing.join('\n')) : 'No missing tables.',
    extra.length ? ('EXTRA tables to REMOVE (not in this domain per the spine): \n' + extra.join('\n')) : 'No extra tables.',
    'Edit the file to exactly cover the domain table set (entities + prose), then return DOC_RESULT with claimedTables[] = the corrected list.',
    '',
    rules(),
  ].join('\n')
}

function dbIndexPrompt(tables) {
  const byDomain = {}
  for (const t of tables) { const d = dbDomainOf(t.varName || t.name || ''); (byDomain[d] = byDomain[d] || []).push(t) }
  return [
    'Write the master database reference at: docs/reference/database/index.md',
    'This is the canonical lookup of ALL ' + tables.length + ' tables. Below is the authoritative list grouped by domain. Produce a Markdown table with columns: Table (SQL name), Const (varName), Domain, Grain (one row per what — infer from the table, verify against schema.ts), Owning feature, ERD link.',
    'Read schema.ts in slices using the provided line ranges to confirm each table grain. Link each domain to its docs/reference/database/erd-*.md page.',
    'Authoritative tables by domain:',
    Object.keys(byDomain).map(dom => dom + ':\n' + fmtTables(byDomain[dom])).join('\n\n'),
    '',
    'After writing, return DOC_RESULT with file:"docs/reference/database/index.md", wrote:true, and claimedTables[] = every varName included (should total ' + tables.length + ').',
    '',
    rules(),
  ].join('\n')
}

function enumsPrompt(enums) {
  return [
    'Write the enum reference at: docs/reference/database/enums.md',
    'Document EXACTLY these ' + enums.length + ' Postgres enums (varName / name):',
    enums.map(e => (e.varName || '') + ' / ' + (e.name || '')).join('\n'),
    '',
    'For each, read its definition in src/lib/db/schema.ts, list its allowed values, and note which table(s)/column(s) use it (grep usages). Return DOC_RESULT with file and wrote:true.',
    '',
    rules(),
  ].join('\n')
}

function agentsMdPrompt(spine) {
  return [
    'Refresh AGENTS.md to match current reality. Read AGENTS.md first.',
    'REWRITE these inventory sections so they are accurate to the spine + the new docs/features pages: "What Is Built" (all ' + FEATURES.length + ' features incl. the experimental/in-progress ones with status), the database schema section (now ' + spine.tables.length + ' tables, not 188 — summarize by domain and LINK to docs/reference/database/index.md rather than listing all), the API routes section (now ' + spine.routes.length + ' endpoints — summarize by group and LINK to docs/reference/api/index.md), the frontend pages section (all ' + spine.pages.length + ' pages), and the Tests section (' + spine.testFileCount + ' test files).',
    'Update the "## Status:" heading (cron count = ' + (spine.crons || []).length + ' Vercel Cron entries) and the Tests section (' + spine.testFileCount + ' files, ' + (spine.integrationTestFileCount || 0) + ' integration).',
    'PRESERVE VERBATIM (do not touch): the opening "This is NOT the Next.js you know" warning, "Non-Negotiable Product Rules", "Source of Truth Rules", "Change Control", and the Admin Users list.',
    'REGENERATE the "## Environment Variables" section from src/lib/env.ts: heading "Environment Variables (N required, M defaulted, K optional — 18 declared)", table Variable | Zod rule | Purpose; then a short list "Read directly from process.env (not validated by env.ts)" (LEAVE_REQUESTS_*, POST_CLASS_PAYOUT_*, POST_CLASS_AUTO_APPROVE_*, SCHEDULE_EMAIL_*, OPENAI_*, ENABLE_AI_SCHEDULER, RESEND_API_KEY); link docs/reference/env.md. Keep the "## Admin Users" list VERBATIM. The "## Deployment" section is already correct — preserve it.',
    'Add a one-line pointer near the top to the new docs/ handbook (docs/README.md).',
    'Do NOT touch CLAUDE.md or PRD.md. Use Edit for surgical section replacement or Write the whole file while preserving the protected blocks. Return DOC_RESULT (file:"AGENTS.md").',
    '',
    rules(),
  ].join('\n')
}

function readmePrompt(spine) {
  return [
    'Refresh README.md. Read it first. Update the feature list to cover all ' + FEATURES.length + ' features, the pages list (' + spine.pages.length + '), and the commands section. Add a prominent link to the new docs/ handbook (docs/README.md) as the entry point for deeper docs. Keep it concise and developer-facing. Do NOT touch CLAUDE.md or PRD.md. Return DOC_RESULT (file:"README.md").',
    'Deploy text must read: push to main (Vercel auto-deploys); guarded npm run deploy:prod only from the Vercel-linked worktree on main; never bare npx vercel --prod. Update every count (tables, endpoints, pages, crons, tests, migrations, nav tools) from the spine.',
    '',
    rules(),
  ].join('\n')
}

function planningPrompt(name, spine) {
  return [
    'Refresh the GSD codebase map at: .planning/codebase/' + name + '.md',
    'Read the CURRENT file FIRST — but ONLY to preserve its heading skeleton and document style. Its factual content is STALE (written 2026-08-05: says 188 tables, 15 crons, 241 endpoints/178 files, 369 tests, 25 pages, 21 nav tools). Do a FULL FACTUAL REWRITE under the same headings, grounded in current code.',
    'Authoritative counts from the spine: ' + spine.tables.length + ' tables, ' + spine.routes.length + ' endpoints, ' + (spine.crons || []).length + ' crons, ' + spine.pages.length + ' pages, ' + spine.testFileCount + ' test files, lib modules: ' + (spine.libDirs || []).join(', ') + ', enums: ' + (spine.enumCount || 0) + ', migrations: ' + (spine.migrationCount || 0) + ', integration tests: ' + (spine.integrationTestFileCount || 0) + '.',
    name === 'STACK' ? 'Cover languages, runtime, frameworks, key dependencies (read package.json), config, npm scripts.' : '',
    name === 'ARCHITECTURE' ? 'Cover the layered architecture, snapshot model, in-memory index, data flow, key abstractions, entry points, error handling. Align with docs/handbook/architecture.md.' : '',
    name === 'CONVENTIONS' ? 'Cover naming, code style, imports, error handling, validation, logging, function/module/component patterns — verified against current code.' : '',
    name === 'STRUCTURE' ? 'Cover the current directory tree, key file locations, and module purposes for ALL features.' : '',
    name === 'INTEGRATIONS' ? 'Cover every external integration: Wise API, LINE Messaging, Google Sheets/OAuth, Neon Postgres, NextAuth, Vercel crons — with the env vars each needs.' : '',
    name === 'TESTING' ? 'Cover the vitest setup, unit vs integration projects, where tests live (__tests__), and coverage by domain.' : '',
    name === 'CONCERNS' ? 'Cover real tech debt / known issues / fragile areas / missing coverage, grounded in code (e.g. the modality-detection heuristic, past-day session fallback, the orphan sync-room-utilization handler, env vars read outside env.ts (LEAVE_REQUESTS_*, POST_CLASS_PAYOUT_*, SCHEDULE_EMAIL_*) while env.ts itself is imported by nothing, the admissions_* tables on main whose code sits on the unmerged codex/admissions-parity-hardening branch, the manual-only sync-room-utilization / line-backlog-recovery jobs, credit_control_* snapshot tables with no retention, cron_invocations never pruned and full-scanned by /data-health and /api/home/summary, two request-path Wise calls (POST /api/class-assignments/run and the public /schedule/[token] live sweep), the credit_control registry maxDurationSeconds 300 vs route 800 drift, six same-minute cron collisions, and student-promotions/july-1 returning 409 forever after 2026-07-01).' : '',
    'Do NOT touch CLAUDE.md (it is synced from these files by a separate step). Return DOC_RESULT (file:".planning/codebase/' + name + '.md").',
    '',
    rules(),
  ].join('\n')
}

function overviewPrompt(spine) {
  return [
    'Write the handbook overview at: docs/handbook/overview.md',
    'One short paragraph per feature (with its maturity badge) covering all ' + FEATURES.length + ' features: ' + FEATURES.map(f => f.title).join(', ') + '. Open with a 2-3 sentence description of the whole system (admin tool over the Wise scheduling platform for BeGifted Education). Link each feature paragraph to its docs/features/*.md page. End with the system-scale numbers (' + spine.tables.length + ' tables, ' + spine.routes.length + ' endpoints, ' + spine.pages.length + ' pages, ' + (spine.crons || []).length + ' crons, ' + spine.testFileCount + ' test files). Return DOC_RESULT.',
    '',
    rules(),
  ].join('\n')
}

function indexPrompt(spine) {
  return [
    'Write the documentation index at: docs/README.md',
    'This is the entry point to the handbook. Include: (1) a reading-order map starting with docs/handbook/not-the-nextjs-you-know.md and docs/handbook/overview.md; (2) a "canonical home" table explaining that features/* owns meaning and reference/* owns mechanical detail; (3) a maturity legend using exactly the badges in this map: ' + MATURITY_STR + '; (4) a linked table of contents covering handbook/, features/, reference/api/, reference/database/, operations/, and OPEN-QUESTIONS.md; (5) a note that the existing docs/ai-scheduler-*.md eval reports are separate and untouched. Use relative links that resolve within docs/. Return DOC_RESULT.',
    'Feature pages (ALL must be linked): ' + FEATURES.map(f => f.file).join(', '),
    'Foundation / operations / reference pages: ' + FOUNDATION.map(d => d.file).join(', '),
    'API pages: docs/reference/api/{' + API_GROUPS.map(g => g.file).join(',') + '}.md',
    'DB pages: docs/reference/database/{index,enums,' + DB_DOMAINS.map(d => d.file).join(',') + '}.md',
    'System scale from the spine: ' + spine.tables.length + ' tables, ' + spine.routes.length + ' endpoints, ' + spine.pages.length + ' pages, ' + (spine.crons || []).length + ' crons, ' + spine.testFileCount + ' test files, ' + (spine.migrationCount || 0) + ' migrations.',
    '',
    rules(),
  ].join('\n')
}

function openQuestionsPrompt(oq) {
  return [
    'Write docs/OPEN-QUESTIONS.md — the consolidated list of things only a human can answer, gathered from every documentation agent in this run.',
    'Organize the items below into sensible sections (e.g. "Maturity & lifecycle", "Suspected dead code", "Data/▶schema", "Operations", "Ambiguous behavior"). De-duplicate near-identical items. For each, keep it specific and actionable. Add a short intro explaining this was produced by an automated documentation pass verified against ' + PROVENANCE + '.',
    'Collected items:',
    JSON.stringify(oq, null, 1),
    '',
    'Return DOC_RESULT (file:"docs/OPEN-QUESTIONS.md").',
    '',
    rules(),
  ].join('\n')
}

function criticPrompt() {
  return [
    'You are the completeness critic for the documentation set just generated under docs/. Run: find docs -name "*.md" | sort, and skim the tree.',
    'Identify GAPS: a feature with no doc, a reference page that is empty/stub, a foundation topic not covered, broken-looking relative links, or a doc missing the verification footer. Do NOT rewrite anything.',
    'Then APPEND a section titled "## Completeness review (automated)" to docs/OPEN-QUESTIONS.md listing the gaps you found (use Edit to append; do not overwrite existing content).',
    'Return CRITIC_SCHEMA with gaps[] and a one-line summary.',
    '',
    rules(),
  ].join('\n')
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------
async function documentFeature(f) {
  const w = await agent(featureWritePrompt(f), { label: 'write:' + f.key, phase: 'Features', schema: DOC_RESULT })
  if (!w) return { feature: f.key, write: null }
  const v = await agent(featureVerifyPrompt(f), { label: 'verify:' + f.key, phase: 'Features', schema: VERIFY_RESULT })
  let c = null
  if (v && v.verdict === 'FAIL') {
    c = await agent(featureCorrectPrompt(f, v), { label: 'correct:' + f.key, phase: 'Features', schema: DOC_RESULT })
  }
  return { feature: f.key, write: w, verify: v, correct: c }
}

phase('Inventory')
const spine = await agent(inventoryPrompt(), { label: 'inventory', phase: 'Inventory', schema: SPINE_SCHEMA })
if (!spine || !spine.routes) { log('Inventory spine failed — aborting run.'); return { error: 'no-spine' } }
const routes = spine.routes || []
const tables = spine.tables || []
const enums = spine.enums || []
log('Spine: ' + routes.length + ' endpoints, ' + tables.length + ' tables, ' + enums.length + ' enums, ' + (spine.crons || []).length + ' crons, ' + (spine.pages || []).length + ' pages, ' + (spine.testFileCount || 0) + ' test files.')
if (spine.orphanCrons && spine.orphanCrons.length) log('Orphan internal handlers (no cron): ' + spine.orphanCrons.join(', '))

// group routes/tables deterministically (JS, not LLM)
const apiByGroup = {}
for (const r of routes) { const g = apiGroupOf(r.path); (apiByGroup[g] = apiByGroup[g] || []).push(r) }
const dbByDomain = {}
for (const t of tables) { const d = dbDomainOf(t.varName || t.name || ''); (dbByDomain[d] = dbByDomain[d] || []).push(t) }
for (const g of API_GROUPS) if (g.key !== 'index' && g.key !== 'internal-crons' && !(apiByGroup[g.key] || []).length) log('WARN empty API group: ' + g.key)
for (const d of DB_DOMAINS) if (!(dbByDomain[d.domain] || []).length) log('WARN empty DB domain: ' + d.domain)

// Foundation + Features concurrently
phase('Foundation')
const foundationP = parallel(FOUNDATION.map(d => () => agent(foundationPrompt(d), { label: 'found:' + d.key, phase: 'Foundation', schema: DOC_RESULT })))
const featuresP = Promise.all(FEATURES.map(f => documentFeature(f)))
const [foundationResults, featureResults] = await Promise.all([foundationP, featuresP])
const featOk = featureResults.filter(x => x && x.write).length
log('Foundation: ' + foundationResults.filter(Boolean).length + '/' + FOUNDATION.length + ' written. Features: ' + featOk + '/' + FEATURES.length + ' written.')

// Foundation verify -> correct (same discipline the feature docs get)
const foundationVerdicts = await parallel(FOUNDATION.map((d, i) => async () => {
  const r = foundationResults[i]
  if (!r || !r.wrote) return null
  const v = await agent(docVerifyPrompt(d.file, d.title, d.reads), { label: 'verify-found:' + d.key, phase: 'Foundation', schema: VERIFY_RESULT })
  let c = null
  if (v && v.verdict === 'FAIL') {
    c = await agent(docCorrectPrompt(d.file, v), { label: 'correct-found:' + d.key, phase: 'Foundation', schema: DOC_RESULT })
  }
  return { key: d.key, verify: v, correct: c }
}))
log('Foundation verify: ' + foundationVerdicts.filter(x => x && x.verify && x.verify.verdict === 'FAIL').length + ' FAIL -> corrected.')

// Reference (API + DB), keeping group<->result pairing for the list-diff
phase('Reference')
const apiResults = await Promise.all(API_GROUPS.map(async g => {
  const groupRoutes = g.key === 'index' ? routes : g.key === 'internal-crons' ? routes.filter(r => r.path.indexOf('/api/internal/') === 0) : (apiByGroup[g.key] || [])
  const cronNote = g.key === 'internal-crons'
    ? 'Cron-centric page: for each handler state its vercel.json schedule or "manual-only (registry key ...)" using this data:\n' + JSON.stringify(spine.crons || []) + '\n' + JSON.stringify(spine.registry || [])
    : ''
  const res = await agent(apiRefPrompt(g, groupRoutes, cronNote), { label: 'api:' + g.key, phase: 'Reference', schema: DOC_RESULT })
  return { g, groupRoutes, res }
}))
const dbResults = await Promise.all(DB_DOMAINS.map(async d => {
  const domTables = dbByDomain[d.domain] || []
  const res = await agent(erdPrompt(d, domTables), { label: 'erd:' + d.domain, phase: 'Reference', schema: DOC_RESULT })
  return { d, domTables, res }
}))
const [dbIndexRes, enumsRes] = await Promise.all([
  agent(dbIndexPrompt(tables), { label: 'db:index', phase: 'Reference', schema: DOC_RESULT }),
  agent(enumsPrompt(enums), { label: 'db:enums', phase: 'Reference', schema: DOC_RESULT }),
])

// Deterministic list-diff verification (plain JS against the spine) -> targeted corrections
const corrections = []
for (const x of apiResults) {
  if (!x.res || x.g.key === 'index') continue
  const truth = x.groupRoutes.map(routeKey)
  const claimed = (x.res.claimedRoutes || []).map(s => String(s).trim())
  const missing = truth.filter(t => claimed.indexOf(t) === -1)
  const extra = claimed.filter(c => truth.indexOf(c) === -1)
  if (missing.length || extra.length) {
    log('API ' + x.g.file + ': ' + missing.length + ' missing, ' + extra.length + ' extra -> correcting')
    corrections.push(() => agent(apiCorrectPrompt(x.g, 'docs/reference/api/' + x.g.file + '.md', missing, extra), { label: 'fix-api:' + x.g.key, phase: 'Reference', schema: DOC_RESULT }))
  }
}
for (const x of dbResults) {
  if (!x.res) continue
  const truth = x.domTables.map(t => t.varName || t.name)
  const claimed = x.res.claimedTables || []
  const missing = truth.filter(t => claimed.indexOf(t) === -1)
  const extra = claimed.filter(c => truth.indexOf(c) === -1)
  if (missing.length || extra.length) {
    log('ERD ' + x.d.file + ': ' + missing.length + ' missing, ' + extra.length + ' extra -> correcting')
    corrections.push(() => agent(erdCorrectPrompt(x.d, 'docs/reference/database/' + x.d.file + '.md', missing, extra), { label: 'fix-erd:' + x.d.domain, phase: 'Reference', schema: DOC_RESULT }))
  }
}
if (corrections.length) { await parallel(corrections) } else { log('Reference list-diff: all pages match the spine.') }

// Prose reconciliation (in-place refresh)
phase('Reconcile')
const proseResults = await parallel([
  () => agent(agentsMdPrompt(spine), { label: 'prose:AGENTS.md', phase: 'Reconcile', schema: DOC_RESULT }),
  () => agent(readmePrompt(spine), { label: 'prose:README.md', phase: 'Reconcile', schema: DOC_RESULT }),
  ...PLANNING.map(n => () => agent(planningPrompt(n, spine), { label: 'plan:' + n, phase: 'Reconcile', schema: DOC_RESULT })),
])
log('Reconcile: ' + proseResults.filter(Boolean).length + '/' + (2 + PLANNING.length) + ' prose docs refreshed. (CLAUDE.md is synced by the main loop afterward.)')

// Prose verify -> correct for the two hand-maintained root docs
const PROSE_VERIFY_READS = ['the spine counts given', 'src/lib/db/schema.ts (pgTable count)', 'vercel.json', 'src/lib/navigation/tools.ts', 'src/lib/env.ts']
const proseVerdicts = await parallel([
  { file: 'AGENTS.md', res: proseResults[0] },
  { file: 'README.md', res: proseResults[1] },
].map(p => async () => {
  if (!p.res || !p.res.wrote) return null
  const v = await agent(docVerifyPrompt(p.file, p.file, PROSE_VERIFY_READS), { label: 'verify:' + p.file, phase: 'Reconcile', schema: VERIFY_RESULT })
  let c = null
  if (v && v.verdict === 'FAIL') {
    c = await agent(docCorrectPrompt(p.file, v), { label: 'correct:' + p.file, phase: 'Reconcile', schema: DOC_RESULT })
  }
  return { key: p.file, verify: v, correct: c }
}))
log('Prose verify: ' + proseVerdicts.filter(x => x && x.verify && x.verify.verdict === 'FAIL').length + ' FAIL -> corrected.')

// Collate open questions from every agent (plain JS)
const oq = []
function pushOQ(arr) { if (arr && arr.length) for (const i of arr) oq.push(i) }
for (const r of foundationResults) if (r) pushOQ(r.openQuestions)
for (const f of featureResults) {
  if (!f) continue
  if (f.write) pushOQ(f.write.openQuestions)
  if (f.verify) { pushOQ(f.verify.openQuestions); if (f.verify.unverifiedClaims) for (const u of f.verify.unverifiedClaims) oq.push('[' + f.feature + '] unverified: ' + (u.claim || '')) }
  if (f.correct) pushOQ(f.correct.openQuestions)
}
for (const x of apiResults) if (x.res) pushOQ(x.res.openQuestions)
for (const x of dbResults) if (x.res) pushOQ(x.res.openQuestions)
if (dbIndexRes) pushOQ(dbIndexRes.openQuestions)
for (const r of proseResults) if (r) pushOQ(r.openQuestions)
for (const x of foundationVerdicts) {
  if (!x) continue
  if (x.verify) { pushOQ(x.verify.openQuestions); if (x.verify.unverifiedClaims) for (const u of x.verify.unverifiedClaims) oq.push('[' + x.key + '] unverified: ' + (u.claim || '')) }
  if (x.correct) pushOQ(x.correct.openQuestions)
}
for (const x of proseVerdicts) {
  if (!x) continue
  if (x.verify) { pushOQ(x.verify.openQuestions); if (x.verify.unverifiedClaims) for (const u of x.verify.unverifiedClaims) oq.push('[' + x.key + '] unverified: ' + (u.claim || '')) }
  if (x.correct) pushOQ(x.correct.openQuestions)
}
if (spine.orphanCrons && spine.orphanCrons.length) oq.push('Orphan internal handler(s) with no vercel.json cron — manual, disabled, or missing schedule? ' + spine.orphanCrons.join(', '))
if (spine.manualOnlyJobs && spine.manualOnlyJobs.length) oq.push('Manual-only registry jobs with no vercel.json schedule — intended? ' + spine.manualOnlyJobs.join(', '))
for (const q of EXTRA_OQ) oq.push(q)

// Synthesis
phase('Synthesize')
const synthResults = await parallel([
  () => agent(overviewPrompt(spine), { label: 'overview', phase: 'Synthesize', schema: DOC_RESULT }),
  () => agent(indexPrompt(spine), { label: 'index', phase: 'Synthesize', schema: DOC_RESULT }),
  () => agent(openQuestionsPrompt(oq), { label: 'open-questions', phase: 'Synthesize', schema: DOC_RESULT }),
])
// completeness critic runs AFTER OPEN-QUESTIONS exists (it appends to it)
const critic = await agent(criticPrompt(), { label: 'completeness-critic', phase: 'Synthesize', schema: CRITIC_SCHEMA })

return {
  commit: COMMIT,
  provenance: PROVENANCE,
  counts: { endpoints: routes.length, tables: tables.length, enums: enums.length, crons: (spine.crons || []).length, pages: (spine.pages || []).length, testFiles: spine.testFileCount || 0, integrationTests: spine.integrationTestFileCount || 0, migrations: spine.migrationCount || 0 },
  orphanCrons: spine.orphanCrons || [],
  foundationWritten: foundationResults.filter(Boolean).length,
  featuresWritten: featOk,
  featuresFailedVerify: featureResults.filter(f => f && f.verify && f.verify.verdict === 'FAIL').length,
  apiPages: apiResults.filter(x => x.res).length,
  dbPages: dbResults.filter(x => x.res).length,
  referenceCorrections: corrections.length,
  proseRefreshed: proseResults.filter(Boolean).length,
  openQuestionCount: oq.length,
  completenessGaps: (critic && critic.gaps) || [],
}
