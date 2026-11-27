import { describe, expect, it } from "bun:test";
import type { PaneInfo, PaneLayoutSnapshot } from "../../shared/protocol";
import { paneCanvasView } from "./paneCanvas.ts";

const pane = (pane_id: string, focused = false): PaneInfo =>
  ({
    pane_id,
    agent_status: "idle",
    focused,
    revision: 0,
    tab_id: "t",
    terminal_id: `term-${pane_id}`,
    workspace_id: "w",
  }) as PaneInfo;

const layout = (
  rects: Record<string, { x: number; y: number; width: number; height: number }>,
  opts: { focused_pane_id?: string; zoomed?: boolean; area?: { width: number; height: number } } = {},
): PaneLayoutSnapshot =>
  ({
    area: opts.area ?? { x: 0, y: 0, width: 100, height: 100 },
    focused_pane_id: opts.focused_pane_id ?? "",
    panes: Object.entries(rects).map(([pane_id, r]) => ({
      pane_id,
      focused: false,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    })),
    splits: [],
    tab_id: "t",
    workspace_id: "w",
    zoomed: opts.zoomed ?? false,
  }) as PaneLayoutSnapshot;

describe("paneCanvasView", () => {
  it("normalizes herdr rects to area fractions", () => {
    const panes = [pane("a"), pane("b")];
    const snap = layout(
      {
        a: { x: 0, y: 0, width: 50, height: 100 },
        b: { x: 50, y: 0, width: 50, height: 100 },
      },
      { focused_pane_id: "a" },
    );
    const view = paneCanvasView(panes, snap, panes[0]);
    expect(view.zoomed).toBe(false);
    expect(view.canDragPanes).toBe(true);
    expect(view.panes).toHaveLength(2);
    expect(view.panes[0]!.frame).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
    expect(view.panes[1]!.frame).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(view.panes[0]!.focused).toBe(true);
    expect(view.panes[0]!.emphasis).toBe("focused");
    expect(view.panes[1]!.emphasis).toBe("unfocused");
  });

  it("shows only the focused pane full-bleed when zoomed", () => {
    const panes = [pane("a"), pane("b")];
    const snap = layout(
      { a: { x: 0, y: 0, width: 50, height: 100 }, b: { x: 50, y: 0, width: 50, height: 100 } },
      { focused_pane_id: "b", zoomed: true },
    );
    const view = paneCanvasView(panes, snap, panes[1]);
    expect(view.zoomed).toBe(true);
    expect(view.canDragPanes).toBe(false);
    expect(view.panes).toHaveLength(1);
    expect(view.panes[0]!.pane.pane_id).toBe("b");
    expect(view.panes[0]!.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(view.panes[0]!.emphasis).toBe("none");
  });

  it("falls back to tabPanes when zoomed but no focused pane resolves", () => {
    const panes = [pane("a"), pane("b")];
    const snap = layout(
      { a: { x: 0, y: 0, width: 50, height: 100 }, b: { x: 50, y: 0, width: 50, height: 100 } },
      { zoomed: true },
    );
    const view = paneCanvasView(panes, snap, undefined);
    expect(view.panes).toHaveLength(2);
    expect(view.canDragPanes).toBe(false); // still zoomed
  });

  it("emits null frames and none emphasis for a lone pane", () => {
    const panes = [pane("a")];
    const view = paneCanvasView(panes, undefined, panes[0]);
    expect(view.panes).toHaveLength(1);
    expect(view.panes[0]!.frame).toBeNull();
    expect(view.panes[0]!.emphasis).toBe("none");
    expect(view.canDragPanes).toBe(false);
    // no layout -> pane.focused flag decides
    expect(paneCanvasView([pane("a", true)], undefined, undefined).panes[0]!.focused).toBe(true);
  });

  it("clamps the area denominator like the CSS percent math", () => {
    const panes = [pane("a")];
    const snap = layout(
      { a: { x: 10, y: 0, width: 5, height: 5 } },
      { area: { width: 0, height: 0 } },
    );
    const view = paneCanvasView(panes, snap, panes[0]);
    // max(0,1) denominator -> raw values pass through as fractions
    expect(view.panes[0]!.frame).toEqual({ x: 10, y: 0, width: 5, height: 5 });
  });
});
