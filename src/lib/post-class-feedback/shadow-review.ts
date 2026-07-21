export interface PostClassShadowSyncEvidence {
  id: string;
  finishedAt: Date | null;
  detailFetchedCount: number;
  sessionCount: number;
  assessedCount: number;
  metadata: Record<string, unknown>;
}

/**
 * Selects evidence that proves the current Wise form mapping has completed a
 * useful shadow pass. Old, partial, empty, or differently mapped runs cannot
 * satisfy the activation checklist.
 */
export function selectFreshPostClassShadowSync(
  runs: PostClassShadowSyncEvidence[],
  policyVersion: number,
  mappingVersion: number,
  mappingUpdatedAt: Date,
): PostClassShadowSyncEvidence | null {
  return runs.find((run) => {
    const runMappingVersion = typeof run.metadata.mappingVersion === "number"
      ? run.metadata.mappingVersion
      : Number(run.metadata.mappingVersion);
    const runPolicyVersion = typeof run.metadata.policyVersion === "number"
      ? run.metadata.policyVersion
      : Number(run.metadata.policyVersion);
    return run.finishedAt !== null &&
      run.finishedAt.getTime() >= mappingUpdatedAt.getTime() &&
      run.metadata.outcome === "success" &&
      runPolicyVersion === policyVersion &&
      runMappingVersion === mappingVersion &&
      run.detailFetchedCount > 0 &&
      run.sessionCount > 0 &&
      run.assessedCount > 0;
  }) ?? null;
}
