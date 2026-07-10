# University Admissions rollout, import, and recovery runbook

This is the operational checklist for releasing the University Admissions hardening and worksheet-parity migrations. It covers parity schema migration `0053_nosy_spectrum.sql`, safe legacy test-status backfill `0054_admissions_test_status_backfill.sql`, the family invitation outbox, the explicit Google Sheets connection, and the one-time legacy-workbook importer.

The safe release order is **database first, application second, family portals last**. Family portals default to closed, so deploying the code does not invite or expose a family until staff deliberately opens an individual case.

> **Current production state (2026-07-10):** migrations `0053–0054` are applied.
> The parity application code is not deployed. The readiness check reports four
> rollout-blocking missing values: `RESEND_API_KEY`,
> `ADMISSIONS_EMAIL_FROM`, `ADMISSIONS_EMAIL_REPLY_TO`, and
> `NEXT_PUBLIC_APP_URL`. Configure and re-run the check before code deploy;
> do not open a family portal while any blocker remains.

## 1. Production preflight

### Database migrations

1. Load the intended production environment, confirm `DATABASE_URL` identifies the production Neon project, and run:

   ```bash
   npm run check:admissions-production
   ```

   This read-only preflight checks required admissions environment values,
   compares the local SHA-256 hashes for migrations `0050–0054` with
   `drizzle.__drizzle_migrations`, inspects the latest admissions notification
   run and outbox status, and reports how many family portals are open.
2. Inspect the Drizzle migration journal and production migration table.
   Migrations `0050` through `0054` must all be applied. Production currently
   has both `0053` and `0054`.
3. If any required hash is absent, stop the code deployment and apply migrations:

   ```bash
   npm run db:migrate
   ```

4. Verify `0053` created the following additions:

   - enums `admissions_test_sitting_status` and `admissions_notification_outbox_status`;
   - tables `admissions_awards`, `admissions_college_research`, `admissions_interest_events`, `admissions_college_requirements`, `admissions_financial_aid_offers`, `admissions_scholarships`, `admissions_essay_prompt_catalog`, `admissions_notification_outbox`, `admissions_import_runs`, `admissions_import_issues`, and `admissions_import_mappings`;
   - family-portal columns on `admissions_cases`;
   - major and admissions/portal URL columns on `admissions_college_list_items`;
   - family-sharing columns on essays and self-report sections;
   - typed-score, sitting-status, late-deadline, subject, and soft-delete columns on test sittings;
   - soft deletion and the live-record uniqueness rule on academic records.

   Then verify `0054` performed only the safe status restoration for
   non-deleted rows that still had the new `planned` default:

   - any sitting with `score_details` or a nonblank legacy `actual_score` is
     `score_received`;
   - any remaining unscored sitting with `test_date` before the current
     Bangkok date is `taken`;
   - future unscored sittings remain `planned`;
   - deleted sittings are untouched.

5. Check for a `running` admissions import or notification run left by an interrupted rehearsal. Do not delete ledger rows. Investigate and mark a genuinely abandoned import failed through an approved database change before retrying.
6. Run `npm run check:admissions-production` again after migration. All five
   migration checks must pass. A missing notification run is a warning until
   the first protected run is triggered; a non-success latest run is a release
   failure. Failed outbox rows and already-open portals require operator review.

Do not reuse or renumber older migration filenames. `0053` follows the merged
admissions migrations `0050–0052`; `0054` is the data-only status backfill
that follows `0053`.

### Application and email configuration

Verify these production values before the code deployment:

| Variable | Required release check |
|---|---|
| `DATABASE_URL` | Points to the migrated production Neon database. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` | Present; the OAuth redirect URI matches production. |
| `CRON_SECRET` | Present in both Vercel and the cron runtime. |
| `RESEND_API_KEY` | Present and authorized for the configured sender domain. |
| `ADMISSIONS_EMAIL_FROM` | A verified production sender, not the `onboarding@resend.dev` fallback. |
| `ADMISSIONS_EMAIL_REPLY_TO` | A monitored admissions-team inbox. |
| `NEXT_PUBLIC_APP_URL` | Canonical production base URL used by linked experiences. |

Ordinary Google sign-in requests only `openid email profile`. Google Sheets access is a separate, explicit staff action. Do not connect Sheets while signed in as a student or parent, and never create a Google token row for a family account.

### Release verification

Before deployment, run:

```bash
npm run typecheck
npm test
npm run build
npm run guard:production-route-surface
npm run check:admissions-production
git diff --check
```

After deployment, confirm:

- `/login?callbackUrl=/admissions` shows the role-neutral BeGifted Portal login;
- an admin and an assigned counselor can open `/admissions`;
- an unassigned counselor cannot open another counselor's case;
- every caseload table row and board card opens `/admissions/[caseId]`;
- a newly created case has `family_portal_open = false`;
- `/api/internal/admissions-notifications` rejects a missing or bad bearer secret;
- the latest `admissions_notification_runs` row completes and the data-health cron record is healthy.

## 2. Pilot sequence

Use one newly created case and one imported case. Exercise all four roles before opening any production family portal.

1. **Admin:** create/activate a counselor, verify cohort/template management, and inspect the case audit history.
2. **Counselor:** create the fresh case, assign or reassign counselors, add a parent, change a member email, revoke/reactivate membership, and verify lifecycle controls show only valid transitions.
3. **Student:** while the portal is still closed, confirm the deep link and APIs deny access. Open the case portal, sign in with the exact invited address, and exercise tasks, essays, activities, awards, testing, research, and student-owned requirements at a 375 px viewport.
4. **Parent:** confirm the portal is read-only, the role label and sign-out are visible, sibling switching shows only linked open cases, Thai/English switching works, and no mutation control is present.
5. Record a `committed` application event and confirm the case changes to `committed` in the same transaction. Exercise `completed` separately and verify family access becomes read-only. Confirm `withdrawn` and `archived` deny family routes even if membership remains active.
6. Verify the parent projection contains the approved profile, academics, checklist, colleges, completeness, decisions, recommenders, essay metadata, activities, awards, released testing, scholarships, aid comparison, announcements, and shared notes. It must not contain staff-only notes, audit rows, member emails, internal IDs, Wise/OAuth data, accommodations, unreleased scores, private self-reflection, or unshared Google Docs links.
7. Confirm recognized transcript statuses became canonical college-document rows. Reconcile aggregate recommendation and test-send warnings manually; the source workbook does not identify a recommender or sitting, and the importer deliberately does not infer either one.

Open additional portals case-by-case only after the two pilot cases pass.

## 3. Invitation outbox operations

Opening a portal queues invites for invited/bounced student and parent memberships in the same transaction as the portal state change. Adding a family member, changing an email while the portal is open, reactivating, or explicitly resending also queues an invite. The application attempts immediate delivery after commit; failures remain retryable.

The daily admissions-notifications cron processes due `pending`, `failed`, and expired `processing` outbox rows before deadline reminders. The dedupe key is unique in the outbox and reused as the Resend idempotency key and notification-log key.

When an invite is reported missing:

1. Confirm the member's normalized email, role, and current status.
2. Confirm the case portal is open and the case is not withdrawn or archived.
3. Inspect the latest `admissions_notification_outbox` row: `status`, `attempt_count`, `next_attempt_at`, `last_error`, and `provider_message_id`.
4. Inspect `admissions_notification_log` for the same dedupe key and recipient. A log row means the keyed send is terminal; do not manufacture a duplicate send.
5. Verify `RESEND_API_KEY`, sender verification, and reply-to configuration.
6. Run the protected notification endpoint once if waiting for the next cron is inappropriate:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://bgscheduler.vercel.app/api/internal/admissions-notifications?runType=daily"
   ```

7. If the address itself is wrong, use People & Access to change it. That revokes the old membership, creates the replacement, audits the change, and queues a new invite when the portal is open.

Never mutate `attempt_count`, dedupe keys, or notification-log rows simply to force another email. Use the supported resend/reactivate/email-change action so the audit and idempotency rules remain intact.

## 4. One-time workbook import

### Source preparation

1. Make a student-specific copy of the BeGifted Student Template. Do not point the importer at the shared master template.
2. Share the copied workbook read-only with the staff Google account that will import it.
3. In the admissions case, choose **Connect Sheets** and complete Google consent. This is a staff-only, read-only Sheets scope for admissions imports.
4. Keep the source workbook unchanged between preview and commit.

### Preview

Paste the copied workbook URL into the Casework import wizard and select **Preview**. The bounded reader loads only the supported ranges for Meetings, Tasks, About You, Academics, Tests, Activities, Majors & Careers, College Criteria, Research Notes, Demonstrated Interest, `ApplicationTracker!D33:DD52`, Essay Prompts, Financial Aid Comparisons, and Scholarship Tracker. Each present range is also read in formula mode; formula-owned cells are blanked before parsing and fingerprinting while literal cells are retained. The application tracker is read as fixed-width `D:CV` and `CX:DD` rectangles so sparse rows stay aligned while credential-bearing `CW` is never requested.

Review:

- target entity counts;
- field-level changes;
- validated US/IB/A-Level academic records and any academic cells retained for
  manual review rather than guessed;
- unresolved or ambiguous college names;
- missing/invalid dates;
- unsupported dropdown values;
- character-limit violations;
- unsafe URL schemes or embedded URL credentials (blocking; the secret value
  is redacted from academic archive metadata);
- missing tabs or malformed ranges;
- any explicit notice that a portal-password cell was ignored.

Preview is read-only. Blocking errors prevent confirmation. Formula-only reference data, blank template rows, hidden lookup/master tabs, and application-portal password cells are not imported.

### Commit

Choose an explicit conflict policy:

- `preserve_existing`: keep current case values and add only missing records;
- `overwrite_existing`: update matching supported records from the workbook.

Both policies are non-destructive. Clearing or removing a source row never
deletes a case record; the preview flags previously mapped rows that are now
absent, and staff must review and soft-delete those records through their
normal case controls. This prevents an accidental sheet edit from erasing the
application record.

The importer reloads the source and requires the preview fingerprint to match. It then writes the import run, supported target records, issues/mappings, and audit entry in one database transaction. A failure rolls back the entire import.

Idempotency key: `(case_id, spreadsheet_id, source_fingerprint)`. Committing an already committed fingerprint is a no-op. A changed source generates a different fingerprint and requires a new preview plus an explicit conflict policy.
For changed-source imports, stable worksheet coordinates are resolved through
the latest committed `admissions_import_mappings`, so an edited title, date,
college name, or score updates the previously imported target under
`overwrite_existing` instead of creating a duplicate.

After success:

1. Reconcile committed counts with the preview and the source workbook.
2. Spot-check at least one record from every populated entity type.
3. Keep the source workbook as a read-only archive.
4. Do not configure a recurring sync or edit the archive expecting changes to flow into the application.

The importer never reads or stores application-portal passwords. Do not paste passwords into notes, URLs, or conflict-resolution text.

## 5. Recovery and rollback

### Import failure before commit

No target data was written. Correct the source or Sheets authorization, refresh the preview, and retry.

### Import failure during commit

The audited transaction rolls back target rows, mappings, issues, and the terminal state together. Inspect the application error and database logs; do not partially recreate rows by hand. Resolve the cause and create a fresh preview before retrying.

### Bad but successfully committed import

There is no destructive "undo workbook" endpoint. Close the family portal first if incorrect data could be exposed. Use the audit log and `admissions_import_mappings` to identify imported targets, then prepare a reviewed corrective migration or use supported soft-delete/update APIs. Preserve the import ledger and archive for traceability.

### Application rollback after `0053–0054`

Application code can be rolled back while leaving `0053` schema objects and
the `0054` status corrections in place. Do not drop the new tables/columns or
blindly reset sitting statuses during an incident; doing so destroys audit,
import, queued-invitation evidence, or valid restored test state and may break
a newer worker still in flight.

### Emergency family-access containment

Close the affected case portal. Closing is audited and immediately blocks student/parent deep links and APIs for that case. For a broader incident, remove admissions access at the application layer and coordinate a reviewed containment change; do not revoke staff or delete membership rows indiscriminately.

## 6. Post-pilot monitoring

During the first rollout week, review daily:

- admissions notification run status, sent/skipped counts, and error summaries;
- failed/past-due outbox rows and repeated provider errors;
- bounced invitations and email-change frequency;
- parent projection leak tests in the release build;
- import preview-versus-commit reconciliation;
- audit coverage for portal, membership, lifecycle, academics, awards, testing, college detail, money, and import mutations;
- support feedback on the student 375 px flows and parent bilingual/sibling navigation.

Escalate rather than opening additional family portals if email delivery, projection safety, migration state, or audit completeness is uncertain.
