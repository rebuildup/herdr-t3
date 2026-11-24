import { describe, expect, it } from "bun:test";
import {
  CompositionTracker,
  focusReport,
  mouseReportCell,
  pointerDragKind,
  sendsHoverMotion,
  wheelButton,
} from "./inputPolicy.ts";

const text = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : new TextDecoder().decode(bytes);

describe("focusReport", () => {
  it("emits CSI I / CSI O only while the pane asked for focus events", () => {
    expect(text(focusReport(true, true))).toBe("\x1b[I");
    expect(text(focusReport(false, true))).toBe("\x1b[O");
    expect(focusReport(true, false)).toBeNull();
    expect(focusReport(false, false)).toBeNull();
  });
});

describe("CompositionTracker", () => {
  it("commits compositionend text exactly once", () => {
    const c = new CompositionTracker();
    c.start();
    expect(c.active).toBe(true);
    expect(c.end("日本語")).toBe("日本語");
    expect(c.active).toBe(false);
  });

  it("sends nothing for a cancelled (empty) composition", () => {
    const c = new CompositionTracker();
    c.start();
    expect(c.end("")).toBeNull();
  });

  it("swallows the insertText echo of a commit", () => {
    const c = new CompositionTracker();
    c.start();
    expect(c.end("確定")).toBe("確定");
    // same task: the platform's duplicate beforeinput insertText is the echo
    expect(c.beforeInputText("確定")).toBeNull();
  });

  it("still forwards a different insertText after a commit", () => {
    const c = new CompositionTracker();
    c.start();
    c.end("確定");
    expect(c.beforeInputText("別の文字")).toBe("別の文字");
  });

  it("drops insertText that arrives mid-composition", () => {
    const c = new CompositionTracker();
    c.start();
    expect(c.beforeInputText("変換中")).toBeNull();
    expect(c.end("確定")).toBe("確定");
  });

  it("treats consecutive compositions independently", () => {
    const c = new CompositionTracker();
    c.start();
    expect(c.end("一回目")).toBe("一回目");
    c.start();
    expect(c.end("二回目")).toBe("二回目");
    expect(c.beforeInputText("二回目")).toBeNull();
  });
});

// terminal-io.md §7: the deterministic pointer/mouse contract rows that do
// not need a DOM — the surface wires PointerEvents to these helpers.
describe("pointerDragKind", () => {
  it("sends the drag to the pane only when it reports the mouse and Shift is up", () => {
    expect(pointerDragKind(false, true)).toBe("mouse");
    expect(pointerDragKind(false, false)).toBe("select");
    // §5.2: Shift+drag is the local-selection escape hatch in every mode
    expect(pointerDragKind(true, true)).toBe("select");
    expect(pointerDragKind(true, false)).toBe("select");
  });
});

describe("wheelButton", () => {
  it("maps the dominant axis to the wheel button a pane expects", () => {
    expect(wheelButton(0, -120)).toBe("wheelUp");
    expect(wheelButton(0, 120)).toBe("wheelDown");
    expect(wheelButton(-120, 0)).toBe("wheelLeft");
    expect(wheelButton(120, 0)).toBe("wheelRight");
    // dominant axis wins on diagonals
    expect(wheelButton(30, -120)).toBe("wheelUp");
    expect(wheelButton(-120, 30)).toBe("wheelLeft");
    expect(wheelButton(0, 0)).toBeNull();
  });
});

describe("sendsHoverMotion", () => {
  it("reports buttonless motion only in 'any' mouse mode", () => {
    expect(sendsHoverMotion("any")).toBe(true);
    expect(sendsHoverMotion("none")).toBe(false);
    expect(sendsHoverMotion("x10")).toBe(false);
    expect(sendsHoverMotion("normal")).toBe(false);
    expect(sendsHoverMotion("button")).toBe(false);
  });
});

describe("mouseReportCell", () => {
  // §7 coordinate row: screen cells include kept scrollback (viewportTop
  // offset); reports must land on viewport cells or not at all.
  it("converts screen rows through the viewport top", () => {
    // viewportTop=10, viewport rows=0..23 → screen rows 10..33
    expect(mouseReportCell({ x: 4, y: 10 }, 10, 80, 24)).toEqual({ col: 4, row: 0 });
    expect(mouseReportCell({ x: 4, y: 33 }, 10, 80, 24)).toEqual({ col: 4, row: 23 });
    expect(mouseReportCell({ x: 4, y: 20 }, 10, 80, 24)).toEqual({ col: 4, row: 10 });
  });

  it("clamps columns and rows into the grid", () => {
    expect(mouseReportCell({ x: 200, y: 40 }, 10, 80, 24)).toEqual({ col: 79, row: 23 });
    expect(mouseReportCell({ x: 79, y: 33 }, 10, 80, 24)).toEqual({ col: 79, row: 23 });
  });

  it("refuses points inside scrollback above the viewport", () => {
    // y=9 is one row above the viewport top — no viewport cell can name it
    expect(mouseReportCell({ x: 4, y: 9 }, 10, 80, 24)).toBeNull();
    expect(mouseReportCell({ x: 4, y: 0 }, 10, 80, 24)).toBeNull();
  });
});
