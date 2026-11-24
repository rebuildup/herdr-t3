/*
 * Pane reading order for "focus next pane" (WorkspaceHeader): herdr's
 * layout rects define the visual order — top-to-bottom rows, left-to-right
 * within a row — and focus advances circularly through it.
 */
import type { PaneInfo, PaneLayoutSnapshot } from "../../shared/protocol";

export function nextPaneInReadingOrder(
  panes: readonly PaneInfo[],
  layout: PaneLayoutSnapshot | null | undefined,
  focusedPaneId: string,
): string | null {
  if (panes.length < 2 || !layout) return null;
  const rectOf = new Map(layout.panes.map((p) => [p.pane_id, p.rect]));
  const ordered = [...panes].sort((a, b) => {
    const ra = rectOf.get(a.pane_id);
    const rb = rectOf.get(b.pane_id);
    if (!ra || !rb) return 0;
    return ra.y - rb.y || ra.x - rb.x;
  });
  const index = ordered.findIndex((p) => p.pane_id === focusedPaneId);
  const next = ordered[(index + 1) % ordered.length];
  return next?.pane_id ?? null;
}
