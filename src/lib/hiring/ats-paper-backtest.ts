export type PaperPair = { id: string; name: string; fractions: number[]; penalty: number; saved: number; mark: number; subjects: string[] };
export function replayWeights(pair: PaperPair, weights: number[]) {
  return Math.max(0, weights.reduce((total, w, j) => total + w * pair.fractions[j], -pair.penalty));
}

/** Search all seven-weight allocations on the five-point grid, plus the saved rule if it is off-grid.
 * Each omission chooses weights from its training candidates, then predicts the omitted mark. */
export function paperBacktest(pairs: PaperPair[], saved: number[]) {
  const n = pairs.length;
  if (n < 3 || pairs.every(p => p.mark === pairs[0].mark)) return null;
  const marks = pairs.map(p => p.mark);
  const sumY = marks.reduce((a,b) => a+b, 0), sumYY = marks.reduce((a,b) => a+b*b, 0);
  const slots = n >= 4 ? n + 1 : 1;
  const best = Array.from({ length: slots }, () => ({ r: -Infinity, cost: Infinity, prediction: 0 }));
  let bestWeights = saved.slice(), savedR: number | null = null, tried = 0, ties = 0;
  const xs = new Float64Array(n);
  // A constant saved score in an omission fold predicts the training mean.
  const savedPredictions = marks.map(y => (sumY-y)/(n-1));
  function evaluate(weights: number[], current = false) {
    tried++;
    let sumX = 0, sumXX = 0, sumXY = 0;
    for (let i = 0; i < n; i++) {
      const x = current ? pairs[i].saved : replayWeights(pairs[i], weights);
      xs[i] = x; sumX += x; sumXX += x*x; sumXY += x*marks[i];
    }
    const cost = weights.reduce((sum,w,j) => sum + Math.abs(w-saved[j]), 0);
    for (let fold = 0; fold < slots; fold++) {
      const omit = fold > 0, m = omit ? n-1 : n;
      const x = omit ? xs[fold-1] : 0, y = omit ? marks[fold-1] : 0;
      const sx = sumX-x, sy = sumY-y;
      const xx = sumXX-x*x-sx*sx/m, yy = sumYY-y*y-sy*sy/m;
      if (xx < 1e-9 || yy < 1e-9) continue;
      const xy = sumXY-x*y-sx*sy/m;
      const r = Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy)));
      if (current && !omit) savedR = r;
      if (current && omit) savedPredictions[fold-1] = sy/m + xy/xx*(x-sx/m);
      const slot = best[fold], improvement = r > slot.r + 1e-10, tied = Math.abs(r-slot.r) <= 1e-10;
      if (!omit) { if (improvement) ties = 1; else if (tied) ties++; }
      if (!improvement && !(tied && cost < slot.cost)) continue;
      slot.r = r; slot.cost = cost;
      if (omit) slot.prediction = sy/m + xy/xx*(x-sx/m);
      else bestWeights = weights.slice();
    }
  }
  evaluate(saved, true);
  const weights = Array<number>(saved.length).fill(0);
  function allocate(j: number, remaining: number) {
    if (j === weights.length-1) {
      weights[j] = remaining;
      if (weights.some((v,i) => v !== saved[i])) evaluate(weights);
      return;
    }
    for (let w = 0; w <= remaining; w += 5) { weights[j] = w; allocate(j+1, remaining-w); }
  }
  allocate(0, 100);
  if (!Number.isFinite(best[0].r)) return null;
  const held = best.slice(1).flatMap((fold,i) => Number.isFinite(fold.r) ? [{
    error: Math.abs(fold.prediction-marks[i]), savedError: Math.abs(savedPredictions[i]-marks[i]), baseline: Math.abs((sumY-marks[i])/(n-1)-marks[i]),
  }] : []);
  return { weights: bestWeights, savedR: savedR as number | null, bestR: best[0].r, tried, ties, folds: held.length,
    mae: held.length ? held.reduce((a,b)=>a+b.error,0)/held.length : null,
    savedMae: held.length ? held.reduce((a,b)=>a+b.savedError,0)/held.length : null,
    baseline: held.length ? held.reduce((a,b)=>a+b.baseline,0)/held.length : null };
}
