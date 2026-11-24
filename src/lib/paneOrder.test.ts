import { describe, expect, it } from "bun:test";
import type { PaneInfo, PaneLayoutSnapshot } from "../../shared/protocol";
import { nextPaneInReadingOrder } from "./paneOrder.ts";

const pane = (pane_id: string): PaneInfo =>
  ({ pane_id, agent_status: "idle", focused: false, revision: 0, tab_id: "t", terminal_id: "x", workspace_id: "w" }) as PaneInfo;

const layout = (rects: Record<string, { x: number; y: number }>): PaneLayoutSnapshot =>
  ({
    area: { x: 0, y: 0, width: 100, height: 100 },
    focused_pane_id: "",
    panes: Object.entries(rects).map(([pane_id, r]) => ({
      pane_id,
      focused: false,
      rect: { x: r.x, y: r.y, width: 50, height: 50 },
    })),
    splits: [],
    tab_id: "t",
    workspace_id: "w",
    zoomed: false,
  }) as PaneLayoutSnapshot;

describe("nextPaneInReadingOrder", () => {
  it("advances top-to-bottom, left-to-right and wraps around", () => {
    const panes = [pane("a"), pane("b"), pane("c"), pane("d")];
    // two rows: a|b on top, c|d below
    const snap = layout({ a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, c: { x: 0, y: 50 }, d: { x: 50, y: 50 } });
    expect(nextPaneInReadingOrder(panes, snap, "a")).toBe("b");
    expect(nextPaneInReadingOrder(panes, snap, "b")).toBe("c");
    expect(nextPaneInReadingOrder(panes, snap, "d")).toBe("a"); // wraps
  });

  it("returns null with fewer than two panes or no layout", () => {
    expect(nextPaneInReadingOrder([pane("a")], layout({ a: { x: 0, y: 0 } }), "a")).toBeNull();
    expect(nextPaneInReadingOrder([pane("a"), pane("b")], null, "a")).toBeNull();
  });
});
