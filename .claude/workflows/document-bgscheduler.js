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
const PROVENANCE = A.provenance || (COMMIT + ' + uncommitted WIP')
const DATE = A.date || '2026-05-31'
const MATURITY = A.maturityMap || {}
const DENYLIST = (A.denylist || [
  'docs/ai-scheduler-*.md', 'docs/ai-scheduler-eval-cases.json', 'docs/superpowers/**',
  'PRD.md', '**/.DS_Store', 'node_modules/**', '.next/**', '.vercel/**',
  'src/lib/leave-requests/**', 'src/lib/db/schema.ts', 'src/lib/auth.ts',
]).join(', ')
const MATURITY_STR = JSON.stringify(MATURITY)

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
    paths: ['src/lib/line', 'src/app/api/line', 'src/app/(app)/line-review', 'src/components/line-review'],
    notes: 'LARGE subsystem. Sections: webhook/ingest + contacts, classifier + scheduler reviews (write-path gated by ENABLE_LINE_SCHEDULER), link validation + OA resolver, wise-action logs. NARRATIVE ONLY — link to reference/api/line.md for the endpoint list; do not enumerate all routes here.' },
  { key: 'room-capacity', title: 'Room Capacity', maturity: 'stable',
    file: 'docs/features/room-capacity.md',
    paths: ['src/lib/room-capacity', 'src/app/api/room-capacity', 'src/app/api/internal/sync-room-utilization', 'src/app/(app)/room-capacity', 'src/components/room-capacity'],
    notes: 'Utilization + forecast model. NOTE the sync-room-utilization internal handler appears to have no vercel.json cron entry — flag this in openQuestions.' },
  { key: 'data-health', title: 'Data Health', maturity: 'stable',
    file: 'docs/features/data-health.md',
    paths: ['src/app/api/data-health', 'src/app/(app)/data-health'],
    notes: 'Surfaces sync_runs status, snapshot_stats, and data_issues. Mostly read layer.' },
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
  { key: 'leave-requests', title: 'Leave Requests', maturity: 'in-progress-uncommitted',
    file: 'docs/features/leave-requests.md',
    paths: ['src/lib/leave-requests', 'drizzle/0036_tutor_leave_requests.sql', 'the leave_request* tables in src/lib/db/schema.ts'],
    notes: 'IN PROGRESS and UNCOMMITTED at this revision. Document ONLY what exists (e.g. config.ts and the leave_request* tables). Explicitly state that routes/UI are pending. Do NOT edit the source.' },
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
    reads: ['package.json (scripts)', 'README.md', 'src/lib/internal/cron-auth.ts', 'vercel.json', 'src/app/api/internal/sync-wise/route.ts'],
    ask: 'Write an operational runbook: deploy (vercel --prod), the npm scripts (db:generate, db:migrate, db:seed, test*), manually triggering each sync via curl with CRON_SECRET, the single-flight guard + abandoned-run recovery, snapshot rollback (failed sync preserves previous active snapshot), and where to look when a sync fails.' },
  { key: 'ops-auth', file: 'docs/operations/auth-and-access.md', title: 'Auth & Access',
    reads: ['src/lib/auth.ts (READ only — do not edit)', 'src/lib/auth-edge.ts', 'src/middleware.ts', 'src/app/api/auth'],
    ask: 'Document the auth model: Auth.js (NextAuth) Google provider, the admin_users allowlist, the middleware gate (which paths bypass auth: /login, /api/auth/*, /api/internal/*), and the auth vs auth-edge split. List the allowlisted admin emails count (verify against seed/schema, not memory).' },
  { key: 'ops-observability', file: 'docs/operations/observability.md', title: 'Observability',
    reads: ['src/lib/db/schema.ts (sync_runs, *_sync_runs, snapshot_stats, data_issues — read those table slices)', 'src/app/api/data-health/route.ts'],
    ask: 'Document how to observe system health: the sync_runs / credit_control_sync_runs / wise_activity_sync_runs / payroll_sync_runs tables, snapshot_stats, data_issues by type/severity, and the /data-health surface. Describe failure modes and how stale snapshots are flagged.' },
  { key: 'ref-env', file: 'docs/reference/env.md', title: 'Environment Variables',
    reads: ['src/lib/env.ts (the Zod schema is the source of truth)', '.env.example'],
    ask: 'Produce the canonical env var reference from the Zod schema in src/lib/env.ts: every variable, whether it is required (.min(1)), defaulted, or optional, its purpose, and where it is consumed. Reconcile against the README/AGENTS prose claim of "9 required" and state the precise Zod truth. Include the optional LINE/feature-flag vars.' },
  { key: 'ref-crons', file: 'docs/reference/crons.md', title: 'Cron Schedule',
    reads: ['vercel.json (authoritative for scheduled crons)', 'the spine cron data provided below'],
    ask: 'Document every cron in vercel.json: schedule, endpoint, and what it does. Add a section "Internal handlers without a cron schedule" listing any /api/internal/* handler not wired in vercel.json (e.g. sync-room-utilization) and flag it as manual/disabled -> openQuestions.' },
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
  { key: 'internal-crons', file: 'internal-crons', title: 'Internal / Cron API' },
  { key: 'misc', file: 'misc', title: 'Search, Tutors, Filters, Compare, Data Health, Auth, Admin' },
]

const DB_DOMAINS = [
  { domain: 'core', file: 'erd-core', title: 'Core: Snapshots, Sync, Tutors, Normalization' },
  { domain: 'credit-control', file: 'erd-credit-control', title: 'Credit Control' },
  { domain: 'classrooms', file: 'erd-classrooms', title: 'Classrooms & Assignments' },
  { domain: 'line', file: 'erd-line', title: 'LINE' },
  { domain: 'sales-dashboard', file: 'erd-sales-dashboard', title: 'Sales Dashboard' },
  { domain: 'payroll', file: 'erd-payroll', title: 'Payroll' },
  { domain: 'tutor-profiles', file: 'erd-tutor-profiles', title: 'Tutor Profiles' },
  { domain: 'leave-requests', file: 'erd-leave-requests', title: 'Leave Requests (in progress)' },
  { domain: 'room-capacity', file: 'erd-room-capacity', title: 'Room Capacity' },
  { domain: 'ai-and-proposals', file: 'erd-ai-and-proposals', title: 'AI Scheduler & Proposals' },
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
    internalHandlers: { type: 'array', items: { type: 'string' } },
    orphanCrons: { type: 'array', items: { type: 'string' } },
    pages: { type: 'array', items: { type: 'string' } },
    libDirs: { type: 'array', items: { type: 'string' } },
    libTopLevelFiles: { type: 'array', items: { type: 'string' } },
    componentDirs: { type: 'array', items: { type: 'string' } },
    testFileCount: { type: 'number' },
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
    '- .planning/codebase/* and the CURRENT AGENTS.md are STALE. Use them ONLY as a format/voice template. NEVER copy a number, table count, route list, or factual claim from them.',
    '- NEVER write to or modify these paths (reading is fine): ' + DENYLIST + '. Document the in-flight source but do not edit it.',
    '- Maturity badges come from this map; APPLY them, do not infer (no @deprecated markers exist in code). Verify the underlying mechanism. Map: ' + MATURITY_STR + '.',
    '- Canonical-home rule: reference/* owns mechanical detail (columns, endpoint signatures); features/* owns meaning (purpose, rules, flows, why). Feature docs LINK to reference; they must NOT restate column lists or full endpoint signatures.',
    '- End every document with this exact footer line: _Verified against ' + PROVENANCE + ' on ' + DATE + '._',
    extra || '',
  ].join('\n')
}

function apiGroupOf(path) {
  if (path.indexOf('/api/line') === 0) return 'line'
  if (path.indexOf('/api/credit-control') === 0) return 'credit-control'
  if (path.indexOf('/api/class-assignments') === 0 || path.indexOf('/api/classrooms') === 0 || path.indexOf('/api/internal/class-assignments') === 0) return 'classrooms-and-assignments'
  if (path.indexOf('/api/sales-dashboard') === 0 || path.indexOf('/api/internal/sync-sales-dashboard') === 0) return 'sales-dashboard'
  if (path.indexOf('/api/payroll') === 0) return 'payroll'
  if (path.indexOf('/api/wise-activity') === 0 || path.indexOf('/api/internal/sync-wise-activity') === 0) return 'wise-activity'
  if (path.indexOf('/api/room-capacity') === 0 || path.indexOf('/api/internal/sync-room-utilization') === 0) return 'room-capacity'
  if (path.indexOf('/api/ai-scheduler') === 0) return 'ai-scheduler'
  if (path.indexOf('/api/proposals') === 0) return 'proposals'
  if (path.indexOf('/api/internal/') === 0) return 'internal-crons'
  return 'misc'
}

function dbDomainOf(v) {
  if (/^creditControl/.test(v)) return 'credit-control'
  if (/^classroom/.test(v)) return 'classrooms'
  if (/^line/.test(v)) return 'line'
  if (/^salesDashboard/.test(v)) return 'sales-dashboard'
  if (/^payroll/.test(v)) return 'payroll'
  if (/^leaveRequest/.test(v)) return 'leave-requests'
  if (/^roomCapacity/.test(v)) return 'room-capacity'
  if (/^aiScheduler/.test(v) || /^proposal/.test(v)) return 'ai-and-proposals'
  if (/^(tutorContacts|tutorBusinessProfiles)/.test(v)) return 'tutor-profiles'
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
    '1. ENDPOINTS. Run: rg -n --no-heading -g "route.ts" "export (async )?function (GET|POST|PUT|PATCH|DELETE)" src/app/api',
    '   For each match, the HTTP method is in the match text. Derive the URL path from the file path: strip the leading "src/app", drop the trailing "/route.ts". Keep dynamic segments like [contactId]. Drop Next.js route-group segments wrapped in parentheses such as (app) (they do not appear in the URL). Example: src/app/api/credit-control/actions/bulk/route.ts -> /api/credit-control/actions/bulk. Example: src/app/api/line/contacts/[contactId]/route.ts -> /api/line/contacts/[contactId]. Produce routes[] of {method, path, file}. A single file may export several methods -> several entries.',
    '',
    '2. TABLES. Run: rg -n "= pgTable\\(" src/lib/db/schema.ts  (names + start lines). The endLine of a table is the line just before the next pgTable start (or end of file for the last). Run: wc -l src/lib/db/schema.ts to get the file length. Produce tables[] of {name (the SQL table string, 1st arg to pgTable), varName (the JS const), startLine, endLine}.',
    '   ENUMS. Run: rg -n "pgEnum\\(" src/lib/db/schema.ts -> enums[] of {name, varName}.',
    '   FKS. Run: rg -n "\\.references\\(" src/lib/db/schema.ts -> foreignKeys[] (best-effort {fromTable, fromColumn, toTable} from surrounding context; ok to leave fields blank if unclear).',
    '',
    '3. CRONS. Read vercel.json and list its crons[] as {path, schedule}. Run: find src/app/api/internal -name route.ts to list internal handlers; convert each to its URL path -> internalHandlers[]. orphanCrons[] = internalHandlers whose path is NOT present in vercel.json crons.',
    '',
    '4. PAGES. Run: find "src/app/(app)" -name page.tsx -> pages[] (URL-ish paths).',
    '5. LIB. Run: ls -1 src/lib -> separate directories (libDirs[]) from top-level .ts files (libTopLevelFiles[]).',
    '6. COMPONENTS. Run: ls -1 src/components -> componentDirs[].',
    '7. TESTS. Run: rg --files -g "**/__tests__/**/*.test.ts" -g "**/__tests__/**/*.test.tsx" | wc -l -> testFileCount.',
    '8. GIT. Run: git status --short -> git.modified[] (lines starting with " M" or "M ") and git.untracked[] (lines starting with "??").',
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

function apiRefPrompt(g, groupRoutes) {
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
    (d.domain === 'leave-requests' ? 'NOTE: these tables are UNCOMMITTED WIP (modified schema.ts). Badge this page IN PROGRESS.' : ''),
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
    'REWRITE these inventory sections so they are accurate to the spine + the new docs/features pages: "What Is Built" (all ' + FEATURES.length + ' features incl. the experimental/in-progress ones with status), the database schema section (now ' + spine.tables.length + ' tables, not 14 — summarize by domain and LINK to docs/reference/database/index.md rather than listing all), the API routes section (now ' + spine.routes.length + ' endpoints — summarize by group and LINK to docs/reference/api/index.md), the frontend pages section (all ' + spine.pages.length + ' pages), and the Tests section (' + spine.testFileCount + ' test files).',
    'PRESERVE VERBATIM (do not touch): the opening "This is NOT the Next.js you know" warning, "Non-Negotiable Product Rules", "Source of Truth Rules", "Change Control", the Environment Variables table, and the Admin Users list.',
    'Add a one-line pointer near the top to the new docs/ handbook (docs/README.md).',
    'Do NOT touch CLAUDE.md or PRD.md. Use Edit for surgical section replacement or Write the whole file while preserving the protected blocks. Return DOC_RESULT (file:"AGENTS.md").',
    '',
    rules(),
  ].join('\n')
}

function readmePrompt(spine) {
  return [
    'Refresh README.md. Read it first. Update the feature list to cover all ' + FEATURES.length + ' features, the pages list (' + spine.pages.length + '), and the commands section. Add a prominent link to the new docs/ handbook (docs/README.md) as the entry point for deeper docs. Keep it concise and developer-facing. Do NOT touch CLAUDE.md or PRD.md. Return DOC_RESULT (file:"README.md").',
    '',
    rules(),
  ].join('\n')
}

function planningPrompt(name, spine) {
  return [
    'Refresh the GSD codebase map at: .planning/codebase/' + name + '.md',
    'Read the CURRENT file FIRST — but ONLY to preserve its heading skeleton and document style. Its factual content is STALE (it predates ~10 features and says things like "14 tables" / "cron at midnight UTC"). Do a FULL FACTUAL REWRITE under the same headings, grounded in current code.',
    'Authoritative counts from the spine: ' + spine.tables.length + ' tables, ' + spine.routes.length + ' endpoints, ' + (spine.crons || []).length + ' crons, ' + spine.pages.length + ' pages, ' + spine.testFileCount + ' test files, lib modules: ' + (spine.libDirs || []).join(', ') + '.',
    name === 'STACK' ? 'Cover languages, runtime, frameworks, key dependencies (read package.json), config, npm scripts.' : '',
    name === 'ARCHITECTURE' ? 'Cover the layered architecture, snapshot model, in-memory index, data flow, key abstractions, entry points, error handling. Align with docs/handbook/architecture.md.' : '',
    name === 'CONVENTIONS' ? 'Cover naming, code style, imports, error handling, validation, logging, function/module/component patterns — verified against current code.' : '',
    name === 'STRUCTURE' ? 'Cover the current directory tree, key file locations, and module purposes for ALL features.' : '',
    name === 'INTEGRATIONS' ? 'Cover every external integration: Wise API, LINE Messaging, Google Sheets/OAuth, Neon Postgres, NextAuth, Vercel crons — with the env vars each needs.' : '',
    name === 'TESTING' ? 'Cover the vitest setup, unit vs integration projects, where tests live (__tests__), and coverage by domain.' : '',
    name === 'CONCERNS' ? 'Cover real tech debt / known issues / fragile areas / missing coverage, grounded in code (e.g. the modality-detection heuristic, past-day session fallback, the orphan sync-room-utilization handler, the uncommitted leave-requests WIP).' : '',
    'Do NOT touch CLAUDE.md (it is synced from these files by a separate step). Return DOC_RESULT (file:".planning/codebase/' + name + '.md").',
    '',
    rules(),
  ].join('\n')
}

function overviewPrompt(spine) {
  return [
    'Write the handbook overview at: docs/handbook/overview.md',
    'One short paragraph per feature (with its maturity badge) covering all ' + FEATURES.length + ' features: ' + FEATURES.map(f => f.title).join(', ') + '. Open with a 2-3 sentence description of the whole system (admin tool over the Wise scheduling platform for BeGifted Education). Link each feature paragraph to its docs/features/*.md page. End with the system-scale numbers (' + spine.tables.length + ' tables, ' + spine.routes.length + ' endpoints, ' + spine.pages.length + ' pages). Return DOC_RESULT.',
    '',
    rules(),
  ].join('\n')
}

function indexPrompt() {
  return [
    'Write the documentation index at: docs/README.md',
    'This is the entry point to the handbook. Include: (1) a reading-order map starting with docs/handbook/not-the-nextjs-you-know.md and docs/handbook/overview.md; (2) a "canonical home" table explaining that features/* owns meaning and reference/* owns mechanical detail; (3) a maturity legend (stable / experimental / legacy / in-progress); (4) a linked table of contents covering handbook/, features/, reference/api/, reference/database/, operations/, and OPEN-QUESTIONS.md; (5) a note that the existing docs/ai-scheduler-*.md eval reports are separate and untouched. Use relative links that resolve within docs/. Return DOC_RESULT.',
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

// Foundation + Features concurrently
phase('Foundation')
const foundationP = parallel(FOUNDATION.map(d => () => agent(foundationPrompt(d), { label: 'found:' + d.key, phase: 'Foundation', schema: DOC_RESULT })))
const featuresP = Promise.all(FEATURES.map(f => documentFeature(f)))
const [foundationResults, featureResults] = await Promise.all([foundationP, featuresP])
const featOk = featureResults.filter(x => x && x.write).length
log('Foundation: ' + foundationResults.filter(Boolean).length + '/' + FOUNDATION.length + ' written. Features: ' + featOk + '/' + FEATURES.length + ' written.')

// Reference (API + DB), keeping group<->result pairing for the list-diff
phase('Reference')
const apiResults = await Promise.all(API_GROUPS.map(async g => {
  const groupRoutes = g.key === 'index' ? routes : (apiByGroup[g.key] || [])
  const res = await agent(apiRefPrompt(g, groupRoutes), { label: 'api:' + g.key, phase: 'Reference', schema: DOC_RESULT })
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
if (spine.orphanCrons && spine.orphanCrons.length) oq.push('Orphan internal handler(s) with no vercel.json cron — manual, disabled, or missing schedule? ' + spine.orphanCrons.join(', '))
oq.push('leave-requests is uncommitted WIP at ' + PROVENANCE + ' — confirm intended scope, the planned routes/UI, and whether the 5 leave_request* tables are final.')
oq.push('Branch state: docs generated on docs/full-redocumentation off ' + COMMIT + ', which is 16 commits ahead of main. Confirm the intended merge path.')

// Synthesis
phase('Synthesize')
const synthResults = await parallel([
  () => agent(overviewPrompt(spine), { label: 'overview', phase: 'Synthesize', schema: DOC_RESULT }),
  () => agent(indexPrompt(), { label: 'index', phase: 'Synthesize', schema: DOC_RESULT }),
  () => agent(openQuestionsPrompt(oq), { label: 'open-questions', phase: 'Synthesize', schema: DOC_RESULT }),
])
// completeness critic runs AFTER OPEN-QUESTIONS exists (it appends to it)
const critic = await agent(criticPrompt(), { label: 'completeness-critic', phase: 'Synthesize', schema: CRITIC_SCHEMA })

return {
  commit: COMMIT,
  provenance: PROVENANCE,
  counts: { endpoints: routes.length, tables: tables.length, enums: enums.length, crons: (spine.crons || []).length, pages: (spine.pages || []).length, testFiles: spine.testFileCount || 0 },
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
