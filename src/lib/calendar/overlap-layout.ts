// ---------------------------------------------------------------------------
// Overlap detection — GCal-style sub-column layout for overlapping sessions
// ---------------------------------------------------------------------------

export interface LayoutInfo {
  column: number;
  totalColumns: number;
}

export function computeOverlapColumns(
  sessions: { startMinute: number; endMinute: number }[],
): LayoutInfo[] {
  if (sessions.length === 0) return [];

  // Sort indices by start time, then by duration descending (longer sessions first)
  const indices = sessions.map((_, i) => i);
  indices.sort((a, b) => {
    const diff = sessions[a].startMinute - sessions[b].startMinute;
    if (diff !== 0) return diff;
    return (sessions[b].endMinute - sessions[b].startMinute) -
           (sessions[a].endMinute - sessions[a].startMinute);
  });

  // Greedy column assignment
  const columns = new Array<number>(sessions.length).fill(0);
  const columnEnds: number[] = [];

  for (const idx of indices) {
    const s = sessions[idx];
    let placed = false;
    for (let c = 0; c < columnEnds.length; c++) {
      if (columnEnds[c] <= s.startMinute) {
        columns[idx] = c;
        columnEnds[c] = s.endMinute;
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns[idx] = columnEnds.length;
      columnEnds.push(s.endMinute);
    }
  }

  // Build connected overlap groups via union-find
  const parent = sessions.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      const si = sessions[indices[i]];
      const sj = sessions[indices[j]];
      // Sorted by start, so sj.startMinute >= si.startMinute
      if (sj.startMinute >= si.endMinute) break; // no more overlaps possible
      union(indices[i], indices[j]);
    }
  }

  // Count max column per group
  const groupMaxCol = new Map<number, number>();
  for (let i = 0; i < sessions.length; i++) {
    const root = find(i);
    groupMaxCol.set(root, Math.max(groupMaxCol.get(root) ?? 0, columns[i] + 1));
  }

  return sessions.map((_, i) => ({
    column: columns[i],
    totalColumns: groupMaxCol.get(find(i)) ?? 1,
  }));
}
