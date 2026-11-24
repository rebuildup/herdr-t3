import { describe, expect, it } from "bun:test";
import { CompositionTracker, focusReport } from "./inputPolicy.ts";

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
