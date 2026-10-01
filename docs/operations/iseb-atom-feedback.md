# ISEB format and Atom evidence

This rollout covers online ISEB 11+/13+ lessons for Kevin, Gift, Ek, Peat and Mimi. The existing attendance, teacher-enablement, deadline, English, nickname, billing and guarded Wise POST rules still apply.

## Server workflow

1. The Atom collector runs at minutes **06, 21, 36 and 51**. A new private Chromium profile signs in normally, collects this account's student catalog, and reads completed tests, practices and exam-topic activities for approved links with pending lessons. The profile is closed after every run.
2. Each run reads a complete Wise timetable for the relevant Bangkok days, including the preceding day for midnight boundaries. Activity and timetable snapshots are append-only.
3. The lesson worker freezes the lesson record and `AtomLessonEvidence`. Both writers get the same applicable guides. Both factual judges get the same lesson and Atom evidence. They judge facts, attribution and homework; they do not judge voice.
4. Deterministic format failures use the existing fallback writer. A second failure holds the draft. Confirmed source contradictions hold immediately. Missing or ambiguous Atom evidence produces no Atom statistics; the lesson-only path continues.
5. Before a stored draft can post, its guide versions, student link revision and Atom hash are checked again. A change sends it back for generation.
6. The existing hourly server review job checks deterministic format and requests a separate API style review. The Review screen shows the first ten verified Mimi v2 posts and first ten other ISEB posts, their completed reviews, and uncertain outcomes separately. Missing retained lesson evidence or either factual verdict cannot complete a review. An explicitly documented Atom omission can be reviewed against the retained lesson.

The production workflow uses the existing Sol writer, Luna fallback and two GLM factual passes. No local worker or running Codex chat is involved. The offline replay script below is a pre-activation comparison tool.

## Frozen format

- **Topics:** consecutive numbered short labels, one per line. A material name requires current evidence.
- **Performance:** one or two warm paragraphs covering strengths, difficulties and guidance. Name any Atom activity whose verified statistics are included. Avoid repeating the topic list.
- **Improvement:** numbered, concrete practice actions. Mimi v2 retains the coaching from the approved third screenshot, including precise terminology and how to approach a question when those points fit the lesson.
- **Homework:** numbered tasks the tutor explicitly assigned during this lesson, otherwise empty. An Atom assignment is insufficient evidence.

There are no per-field minimums or forced strategy counts. The existing 300-character combined policy minimum remains. Sparse source material can lead to a hold; padding is forbidden. Mimi v1 and its source examples remain unchanged. `pipeline.styleGuide` retains its meaning; `formatGuide`, `atomEvidenceHash`, `atomMapping`, `lessonEvidenceHash` and both `factualVerdicts` are recorded separately.

## Matching and statistics

Links are explicit Wise-ID to Atom-ID approvals in **Feedback Autowriter → Details → ISEB format, Atom student links and monitoring**. Names only narrow candidates. Reviewers can see all links; the existing operations owner can approve or revoke them. A link cannot be active for two Wise students, and each revision is retained.

Answers must match the student's approved ID, subject and half-open Wise interval `[start, end)` in Asia/Bangkok. Another lesson overlapping an answer prevents attribution. A unique activity name or exact ID can establish an outside-window match only when the current lesson record explicitly describes doing or reviewing that activity in this lesson on the same Bangkok date. Homework, assignment, historical and other-tutor references cannot establish that exception.

A partial activity uses only matched answers and their answer time. It retains the full activity question count as a separately labelled total, and drops whole-activity SAS and topic estimates. Correct answers, attempted questions, total questions, answer time, SAS and modelled topic estimates are distinct. Assistance flags remain visible; absence of a flag does not establish independent mastery.

Snapshots older than 45 minutes, incomplete timetables, authentication failures and unknown response shapes omit statistics. A newer failed collection cannot silently fall back to an older successful snapshot. Confirmed student or source-count contradictions hold affected drafts until resolved by fresh evidence or staff.

A test score repeated in the transcript is not a validated Atom result. When Atom evidence is omitted, the writer omits test/practice scores, correctness counts, SAS and completion times. A local check rejects numerical result claims in that path before the factual judges run. Homework results stay excluded even when discussed in the lesson.

The observed Atom account exposes English, Maths, VR and NVR activity endpoints. Subjects with no supported activity endpoint receive no Atom statistics. The collector does not infer a score from an unsupported payload.

## Deployment and independent activation

Migration **0103** adds approved links, sync runs, snapshots, timetables, retained evidence, style reviews and a rollout receipt. Apply it before enabling collection. All switches require the exact string `true`.

| Setting | Purpose | Initial value |
|---|---|---|
| `ATOM_USERNAME`, `ATOM_PASSWORD` | Normal sign-in credentials; server secrets only | Set through the deployment secret store |
| `FEEDBACK_ATOM_COLLECTOR_ENABLED` | Read-only scheduled collection | Enable after dark deployment |
| `FEEDBACK_AUTOWRITER_ISEB_FORMAT_ENABLED` | Shared format v1 and Mimi voice v2 | Off until comparison approval |
| `FEEDBACK_ATOM_ENRICHMENT_ENABLED` | Include matched Atom evidence | Off until comparison approval and unattended proof |
| `FEEDBACK_AUTOWRITER_ISEB_REVIEW_ENABLED` | API style checks in the server review job | Enable at activation |

The last two content switches are independently gated by a persisted owner approval. Atom enrichment also requires a successful **scheduled** cloud run with a deployment ID and nonzero snapshot/activity counts, plus the owner's explicit confirmation that Codex and the local computer were off. An interactive admin probe cannot establish that proof.

Use the repository's guarded production deployment workflow from clean, pushed `main`. Deploy this code with content switches off. Credentials must never enter model prompts, committed files, console output or browser screenshots. The collector intercepts browser writes and permits only the normal login POST; direct activity reads are GET-only. Preview deployments never run the collector.

### Review the 20 comparisons

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/replay-iseb-feedback.ts \
  --env-dir=/private/checkout \
  --mimi-v1-dir=/private/preserved-v1-review \
  --transcript-dir=/private/archived-transcripts
```

The output folder is `.feedback-autowriter/iseb-v2-comparisons/` (ignored by Git). It preserves all attempts and contains `comparison.html`, per-class source hashes, call receipts and both factual verdicts. Ten accepted drafts are Mimi comparisons; the other ten cover Kevin, Gift, Ek and Peat. Available retained transcripts are preferred; otherwise the current Wise summary is used. Peat has no September lesson recorded under an ISEB programme, so the source query also searches his older ISEB lessons. This replay deliberately uses **unmapped Atom omissions**: it cannot authorize student links or fabricate enriched examples. A separate review of matched statistics remains necessary before enrichment.

After reviewing failures and obtaining 20 accepted drafts, save that exact bundle to the authenticated Review screen:

```bash
npx tsx --tsconfig scripts/tsconfig.json scripts/save-iseb-comparison-bundle.ts \
  --env-dir=/private/checkout --dir=.feedback-autowriter/iseb-v2-comparisons
```

Saving does not approve it. Kevin approves the displayed bundle in Review. A different bundle clears that approval. For Atom, approve student links, let the cloud collector run through pending lessons with the local computer off, then record the successful scheduled run ID and the explicit unattended confirmation in Review. Check every statistic in the enriched comparisons against its Atom source before enabling enrichment.

For unposted enriched comparisons, run the same replay with `--with-atom --out=.feedback-autowriter/iseb-atom-comparisons`. It reads only approved links and validated snapshots, while bypassing the content activation switch. Collect the relevant lesson dates first; missing or stale snapshots still omit statistics. The separate output directory preserves the lesson-only bundle.

At activation, enable the server style-review switch and independently enable the approved content switch(es). Read back the effective switches in Review. Only then pause the old **Review Mimi's first ten live posts** Codex heartbeat. Keep the v1 files and receipt. The new server job owns the first-ten monitoring; unresolved post outcomes and missing required source evidence remain actionable incidents through the existing email/LINE channels.

### Scheduled retrieval trial with an empty queue

If no eligible feedback is pending, a temporary read-only trial can exercise the same scheduled cloud collector. Set `FEEDBACK_ATOM_TRIAL_STUDENT_ID` to an actively approved Atom identity, `FEEDBACK_ATOM_TRIAL_DATE` to a known activity date in the past 30 days, and `FEEDBACK_ATOM_TRIAL_EXPIRES_AT` to an ISO timestamp no more than 24 hours ahead. The trial expires automatically, records `counts.trial = true`, and does not queue or post feedback. Remove these three settings after recording the result. An admin probe still cannot count as unattended proof; the owner must confirm a scheduled run occurred with Codex and the computer off.

For current and future lesson dates, Atom collection reads the complete, strictly paginated Wise FUTURE listing and then filters exact Bangkok dates. Wise's FUTURE DATE query has returned previous-day sessions in production. PAST reads keep strict calendar boundaries; duplicate occurrences across the two listings must agree on lesson ownership and timing.

## Failure and rollback

- Turn off either content switch to stop that feature independently. Drafts with stale guide/evidence stamps are regenerated before posting.
- Turn off collection if sign-in or response validation repeatedly fails. Missing Atom statistics never imply an empty lesson.
- Source contradictions require human review. Do not bypass them by editing a snapshot; revoke a wrong link or collect corrected source data.
- The evidence tables reject updates and deletes. Student links keep revision history. Existing posting halts and uncertain-POST reconciliation remain authoritative.

## Verification record

See the rollout receipt and saved validation logs for the exact revision tested. Unit tests cover numbering/fallback, empty homework, sparse source evidence, identical model inputs, score rejection, wrong students, duplicate names, midnight boundaries, overlaps, partial activities, assistance, stale snapshots and response drift. Postgres integration tests cover link uniqueness, immutable evidence, failed collections, stale drafts, source holds and review accounting. Local sign-in success is not unattended cloud verification.
