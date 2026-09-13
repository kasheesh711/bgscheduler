export class DeferredProcessing extends Error {}

/** Leave time to persist the next checkpoint before either deadline expires. */
export function requireProcessingTime(deadline: number, leaseUntil: Date | null, requiredMs: number) {
  if (Date.now() + requiredMs + 15_000 > Math.min(deadline, leaseUntil?.getTime() ?? 0))
    throw new DeferredProcessing("The next worker will resume the saved processing stage.");
}
