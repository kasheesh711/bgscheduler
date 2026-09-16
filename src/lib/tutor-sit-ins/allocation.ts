export type ScienceCandidate = {
  key: string;
  options: Array<{ email: string; starts: string[] }>;
};

/** Scarce lessons first, then the least-loaded available head and earliest lesson. */
export function allocateScience(
  candidates: ScienceCandidate[],
  initialLoads: Map<string, number> = new Map(),
) {
  const loads = new Map(initialLoads);
  const result = new Map<string, string | null>();
  const count = (candidate: ScienceCandidate) =>
    new Set(candidate.options.flatMap((o) => o.starts)).size;
  for (const candidate of [...candidates].sort(
    (a, b) =>
      (count(a) || Infinity) - (count(b) || Infinity) ||
      a.key.localeCompare(b.key),
  )) {
    const available = candidate.options.filter((o) => o.starts.length);
    const choices = available.length ? available : candidate.options;
    const chosen = [...choices].sort(
      (a, b) =>
        (loads.get(a.email) || 0) - (loads.get(b.email) || 0) ||
        (a.starts[0] || "~").localeCompare(b.starts[0] || "~") ||
        a.email.localeCompare(b.email),
    )[0];
    result.set(candidate.key, chosen?.email || null);
    if (chosen) loads.set(chosen.email, (loads.get(chosen.email) || 0) + 1);
  }
  return result;
}
