// A single 0-100 health score for a scan run, weighted by how close each
// checked value was to the design system: a full match counts fully, a
// near-miss counts half (it drifted, but is still recognizably close to a
// real token), and an unrecognized value counts for nothing. "missing"
// (a state-completeness failure) is treated the same as unrecognized —
// there's no partial credit for a component missing a required state.
export interface SeverityCounts {
  match: number;
  "near-miss": number;
  unrecognized: number;
  missing?: number;
}

export function healthScore(counts: SeverityCounts): number {
  const total = counts.match + counts["near-miss"] + counts.unrecognized + (counts.missing ?? 0);
  if (total === 0) return 100;

  const weighted = counts.match * 1 + counts["near-miss"] * 0.5;
  return Math.round((weighted / total) * 100);
}
