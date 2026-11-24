/*
 * Drag-reorder → herdr `insert_index` math (issues #111/#152), shared by
 * the workspace list and the tab strip. herdr's `insert_index` is a
 * *pre-removal* insertion point: the item lands before the element
 * currently at that index (`length` appends). `side` is which half of the
 * drop target was hit. Adjacent drops — landing where the item already
 * sits — are no-ops and return null so no RPC fires.
 * Verified against herdr 0.9.5.
 */
export function moveInsertIndex(
  from: number,
  target: number,
  side: "before" | "after",
): number | null {
  const to = target + (side === "after" ? 1 : 0);
  if (to === from || to === from + 1) return null;
  return to;
}
