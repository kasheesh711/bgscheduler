import type { Database } from '@/lib/db';
import { deriveGrowthLifecycleEvents } from './lifecycle';
import { loadGrowthEvidence, reconcileGrowthLifecycleEvents } from './store';

/** Successful local ingestion owns lifecycle persistence. Reports remain pure reads. */
export async function captureGrowthLifecycle(db: Database, now: Date): Promise<void> {
  const evidence = await loadGrowthEvidence(db, now);
  await reconcileGrowthLifecycleEvents(db, deriveGrowthLifecycleEvents(evidence, now));
}
