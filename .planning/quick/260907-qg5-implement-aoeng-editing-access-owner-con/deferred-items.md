# Deferred items

## Local lint artifacts outside this task

- `npm run lint` reported five pre-existing errors in ignored `.payout-ops/fen-2026/reconcile.cjs` and `.payout-ops/fen-2026/recover-invoices.ts` (CommonJS `require` style and explicit `any`). These local operational artifacts are outside the collaborator-access change and were not edited.
- Existing warnings in unrelated source/documentation-script files were also left unchanged. The task separately checks lint with the ignored `.payout-ops/**` directory excluded to reflect the tracked repository's CI scope.
