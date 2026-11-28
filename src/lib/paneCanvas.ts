import type { PaneInfo, PaneLayoutSnapshot } from "../../shared/protocol";
import { paneTitle } from "./workspace";

/*
 * Workspace-canvas pane model (issue #324): the pure derivation
 * WorkspaceCanvas applies to herdr's pane layout — which panes are
 * visible, where each frame sits (as fractions of the layout area),
 * which pane is focused, and which hairline emphasis the frame gets.
 * Zoomed layouts show only the focused pane full-bleed; every other
 * pane keeps herdr's reported rect. Geometry is emitted as 0..1
 * fractions so renderers (CSS percentages, GPUI bounds) stay
 * resolution-independent.
 */

/** Normalized pane frame: fractions of the layout area, each in 0..1. */
export interface PaneFrameGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Split-boundary hairline class (interaction.md §1, issue #432). */
export type PaneFrameEmphasis = "none" | "focused" | "unfocused";

export interface CanvasPaneView {
  pane: PaneInfo;
  title: string;
  focused: boolean;
  /** Normalized geometry; null when herdr reported no rect for the pane. */
  frame: PaneFrameGeometry | null;
  emphasis: PaneFrameEmphasis;
}

export interface PaneCanvasView {
  zoomed: boolean;
  /** Drag-swap is only meaningful with 2+ visible panes and no zoom. */
  canDragPanes: boolean;
  panes: CanvasPaneView[];
}

export function paneCanvasView(
  tabPanes: readonly PaneInfo[],
  layout: PaneLayoutSnapshot | null | undefined,
  focusedPane: PaneInfo | null | undefined,
): PaneCanvasView {
  const zoomed = layout?.zoomed === true;
  // herdr's zoom shows only the focused pane, full-bleed (issue #75).
  const visible = zoomed && focusedPane ? [focusedPane] : [...tabPanes];
  const area = layout?.area ?? { width: 1, height: 1 };
  const panes = visible.map((pane) => {
    const focused = layout
      ? pane.pane_id === layout.focused_pane_id
      : pane.focused === true;
    let frame: PaneFrameGeometry | null = null;
    if (zoomed) {
      frame = { x: 0, y: 0, width: 1, height: 1 };
    } else {
      const rect = layout?.panes.find((p) => p.pane_id === pane.pane_id)?.rect;
      if (rect) {
        frame = {
          x: rect.x / Math.max(area.width, 1),
          y: rect.y / Math.max(area.height, 1),
          width: rect.width / Math.max(area.width, 1),
          height: rect.height / Math.max(area.height, 1),
        };
      }
    }
    const emphasis: PaneFrameEmphasis =
      zoomed || visible.length <= 1 ? "none" : focused ? "focused" : "unfocused";
    return { pane, title: paneTitle(pane), focused, frame, emphasis };
  });
  return {
    zoomed,
    canDragPanes: !zoomed && panes.length > 1,
    panes,
  };
}
