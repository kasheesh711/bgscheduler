# Unearned revenue V5 publication

The local Scheduling runner invokes the existing BeGifted Datasets accounting engine. It publishes a compact Finance workbook and immutable monthly report revisions using the connected Google account. Vercel remains a read-only importer at 01:30 Bangkok. The local publisher retains its existing daily 00:15 schedule and quiet-success notification policy.

## Runtime and commands

The reviewed Python extension lives in `scripts/unearned-python/`. Install it into the existing Datasets environment with:

```sh
python3 scripts/unearned-python/install.py '../BeGifted Datasets'
```

The installer verifies the unchanged accounting engine, applies only the recognition/creation-date exposure patch to the package engine, and installs the reporting module, bundle builder and tests. Existing package matching, frozen opening controls, valuation and accounting tolerances remain unchanged.

```sh
# Full daily run: extract sources, calculate, validate, publish.
npx tsx --tsconfig scripts/tsconfig.json scripts/publish-unearned-revenue.ts --publish

# Validate an already extracted private bundle without Google writes.
npx tsx --tsconfig scripts/tsconfig.json scripts/publish-unearned-revenue.ts --bundle /absolute/path/bundle.json.gz --validate

# Prepare and verify report files; leave the main workbook untouched.
npx tsx --tsconfig scripts/tsconfig.json scripts/publish-unearned-revenue.ts --bundle /absolute/path/bundle.json.gz

# Commit that prepared run after importer deployment and access verification.
npx tsx --tsconfig scripts/tsconfig.json scripts/publish-unearned-revenue.ts --bundle /absolute/path/bundle.json.gz --publish
```

Defaults resolve the sibling `BeGifted Datasets` directory, its `.venv/bin/python`, this checkout's `.env.production.local`, and the existing service account credential path. Override with `--datasets-dir`, `--env-file`, and `--google-credentials`. Secrets remain in the existing environment files and are never written into report bundles. Source extraction uses the service account; Drive creation uses the application's existing Sheets/Drive OAuth connection.

The runner creates a private `publisher.lock` recording its PID. On an interrupted run, verify that process is no longer running before removing a stale lock. Never remove a live process's lock. The `.prepared.json` file beside the bundle records validated uploaded revisions so retries can continue from completed monthly reports. Repeating an already published cutoff/fingerprint validates the current manifest and returns `unchanged`.

Exit 0 means published, unchanged, prepared, or validated as requested. Exit 2 means publication succeeded with changed review conditions. Exit 1 means failure. Inspect the publication marker to resolve an uncertain network response after the final atomic request; never assume a timed-out write failed. Do not notify on ordinary success or unchanged review conditions.

## Finance and capacity

The live URL remains unchanged. Exactly three tabs are visible: `ภาพรวม`, `รายนักเรียน`, and `รายละเอียดแพ็กเกจ`. Main student/package rows show the latest completed Bangkok day; the overview contains every daily total beginning 1 March 2026. Each daily link opens a saved student/package date filter in a monthly workbook. Each student links to its corresponding package rows. Zero-balance students remain present. Opening lots, unresolved attribution and signed valuation adjustments are separate labelled rows.

The original `Package Control` sheet ID is preserved and hidden, with a maintenance link. Its settings, override history and frozen opening baselines survive publication. `Model Status` is also hidden. Everything else needed for calculation and audit is stored outside the main workbook.

The main workbook must allocate fewer than 1,000,000 cells, including retained controls. Monthly reports may allocate at most 2,000,000 cells. Oversized months split at complete day boundaries. The first cutover additionally checks the legacy grids plus compact staging and destination grids against Google's 10,000,000-cell limit. Subsequent refreshes use only compact staging.

## Values contract and revisions

A V5 manifest identifies run, cutoff, source fingerprint, accounting model, revision timestamp, checksummed gzip contract/audit files, row counts, mandatory QA, exact daily coverage, monthly report IDs and their grid sizes, and the V4 rollback copy. The canonical model is explicitly `LEGACY_ACCOUNT_RATE`; approving a different model requires updating and validating the daily report implementation first.

The contract preserves the website's existing month-end/latest data columns, receipt identities and V4 package evidence. Computed values replace formula requirements only after V5 checksum/manifest verification. The importer retains the V4 formula path for rollback. Each snapshot stores the publication manifest and real report/audit links. Published-value evidence is labelled as such; source links still point to the original purchase and credit records.

Backfilled history is reconstructed from the evidence available at the revision date. A corrected source creates an identifiable new revision. Changed month data gets a new workbook; old reports, contracts, audit files and manifests are never overwritten. Unchanged monthly data can reuse a previously published revision. The audit gzip includes normalized source records, candidate matching edges, account/event/lot calculations, recognitions, controls, daily reports, published tables and QA results.

## Failure boundaries and rollout

Before cutover the publisher checks daily institute/student/package sums, the existing engine's monthly closes, source row disappearance, unchanged Finance controls, file checksums, report values and capacities. It prepares reports under the private `ChatGPT/BeGifted Unearned Revenue` Drive folder with the current Finance audience. No invitation emails are sent automatically. Google visitor invitations require explicit operator authorization; unresolved Finance access blocks the main cutover.

The final Sheets `batchUpdate` copies all three validated compact grids, swaps links/results, hides controls, appends only missing opening baselines, removes generated legacy/staging tabs, and writes the publication marker in one atomic request. A preparation or validation failure never changes the displayed Finance results. An interrupted commit is resolved by rereading its run/checksum marker.

Deploy migration `0079_unearned_revenue_publication.sql` and the V4/V5-compatible importer before switching the main workbook. Preserve a full native rollback copy. Verify the new report navigation and audience, commit, then run one website import and an idempotent repeat before resuming the paused local publisher.

The frozen V4 comparison tool captures the published source rates, opening credits and credit events, reruns the unchanged engine and daily closing projection, and checks every existing account/student/month-end/latest balance. Save its gzip result alongside the cutover audit. Rollback uses the native V4 copy (including formulas and sources) and restores its complete generated tabs/status at the original URL while preserving the original control tab. Pause the local publisher first; the deployed importer continues accepting V4.
