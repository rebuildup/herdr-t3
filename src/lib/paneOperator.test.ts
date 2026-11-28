import { describe, expect, test } from "bun:test";
import {
  AttachEgress,
  ATTACH_PENDING_MAX_OPS,
  observeScrollTarget,
  operatorAfterFocusChange,
  type ScrollInfo,
} from "./paneOperator";

/**
 * Contract tests for issue #584 (program #568): viewing and scrolling an
 * observe pane must never acquire the writable attach, first real input
 * promotes it without losing a byte, and focus loss releases the role.
 */

function harness(initialWritable = false) {
  let writable = initialWritable;
  const sent: string[] = [];
  const intents: number[] = [];
  const egress = new AttachEgress({
    writable: () => writable,
    intent: () => intents.push(1),
  });
  return {
    egress,
    sent,
    intents,
    setWritable: (v: boolean) => {
      writable = v;
    },
    input: (tag: string) => egress.input(() => sent.push(tag), tag.length),
    reply: (tag: string) => egress.reply(() => sent.push(tag), tag.length),
    mouse: (action: "press" | "motion" | "release" | "moved", tag: string) =>
      egress.mouse(action, () => sent.push(tag)),
  };
}

describe("AttachEgress observe gating (issue #584)", () => {
  test("viewing alone sends nothing and never requests promotion", () => {
    const h = harness();
    // Stream traffic and resizes are not egress ops; nothing calls in.
    expect(h.sent).toEqual([]);
    expect(h.intents).toEqual([]);
    expect(h.egress.pendingCount).toBe(0);
  });

  test("engine replies are held without promoting — a querying pane stays observe", () => {
    const h = harness();
    h.reply("DA1");
    h.reply("DA2");
    expect(h.sent).toEqual([]);
    expect(h.intents).toEqual([]);
    expect(h.egress.pendingCount).toBe(2);
    // Promotion flushes replies in order, ahead of nothing else.
    h.setWritable(true);
    h.egress.flush();
    expect(h.sent).toEqual(["DA1", "DA2"]);
  });

  test("first keystroke promotes and the byte is not lost across the flip", () => {
    const h = harness();
    h.input("a");
    h.input("b");
    expect(h.intents).toHaveLength(2);
    expect(h.sent).toEqual([]); // nothing reaches an observe link
    // Mode negotiation lands: subscribe(writable) went out first (the
    // caller's ordering contract), then flush drains in order.
    h.setWritable(true);
    h.egress.flush();
    expect(h.sent).toEqual(["a", "b"]);
    // Already writable: straight through, no further intent.
    h.input("c");
    expect(h.sent).toEqual(["a", "b", "c"]);
    expect(h.intents).toHaveLength(2);
  });

  test("flush while still observing is a no-op — ops are never dropped into the void", () => {
    const h = harness();
    h.input("held");
    h.egress.flush();
    expect(h.sent).toEqual([]);
    expect(h.egress.pendingCount).toBe(1);
    h.setWritable(true);
    h.egress.flush();
    expect(h.sent).toEqual(["held"]);
  });

  test("mouse press promotes and buffers; hover motion never does", () => {
    const h = harness();
    h.mouse("moved", "hover1");
    h.mouse("moved", "hover2");
    expect(h.intents).toEqual([]);
    expect(h.sent).toEqual([]);
    h.mouse("press", "down");
    h.mouse("motion", "drag");
    h.mouse("release", "up");
    expect(h.intents).toHaveLength(1);
    expect(h.sent).toEqual([]);
    h.setWritable(true);
    h.egress.flush();
    expect(h.sent).toEqual(["down", "drag", "up"]);
    // Demoted again: a release without a buffered press is not a gesture.
    h.setWritable(false);
    h.mouse("release", "stray");
    h.mouse("moved", "hover3");
    expect(h.sent).toEqual(["down", "drag", "up"]);
    expect(h.intents).toHaveLength(1);
  });

  test("demotion re-gates: ops after writable→observe buffer again, flush on re-promote", () => {
    const h = harness();
    h.input("first");
    h.setWritable(true);
    h.egress.flush();
    expect(h.sent).toEqual(["first"]);
    // Focus moved away: the slot demotes to observe. Input now buffers
    // again instead of reaching a link that cannot carry it.
    h.setWritable(false);
    h.input("second");
    expect(h.sent).toEqual(["first"]);
    expect(h.egress.pendingCount).toBe(1);
    h.setWritable(true);
    h.egress.flush();
    expect(h.sent).toEqual(["first", "second"]);
  });

  test("pending ops are bounded — oldest drop first under pressure", () => {
    const h = harness();
    for (let i = 0; i < ATTACH_PENDING_MAX_OPS + 10; i++) h.input(`k${i}`);
    expect(h.egress.pendingCount).toBe(ATTACH_PENDING_MAX_OPS);
    h.setWritable(true);
    h.egress.flush();
    // The first ten ops were evicted; the tail survived in order.
    expect(h.sent[0]).toBe("k10");
    expect(h.sent).toHaveLength(ATTACH_PENDING_MAX_OPS);
  });
});

describe("observeScrollTarget (issue #584)", () => {
  const info = (offset: number, max: number): ScrollInfo => ({ offset, max });

  test("wheel down approaches the bottom, wheel up scrolls into history", () => {
    expect(observeScrollTarget(info(0, 100), 3)).toBeNull(); // already at bottom
    expect(observeScrollTarget(info(50, 100), 3)).toBe(47);
    expect(observeScrollTarget(info(50, 100), -3)).toBe(53);
  });

  test("clamps at both ends and refuses unknown scroll ranges", () => {
    expect(observeScrollTarget(info(2, 100), 10)).toBe(0);
    expect(observeScrollTarget(info(98, 100), -10)).toBe(100);
    expect(observeScrollTarget(info(10, 0), 3)).toBeNull(); // max unknown/none
    expect(observeScrollTarget(info(10, 100), 0)).toBeNull();
  });
});

describe("operatorAfterFocusChange (issue #584)", () => {
  test("focus moving to a different pane releases the operator role", () => {
    expect(operatorAfterFocusChange("p1", "p1", "p2")).toBeNull();
    expect(operatorAfterFocusChange(null, "p1", "p2")).toBeNull();
  });

  test("a grant on the newly focused pane survives the transition", () => {
    // Click-to-operate promotes and focuses together: the promote lands
    // before the snapshot's focus change arrives.
    expect(operatorAfterFocusChange("p2", "p1", "p2")).toBe("p2");
  });

  test("no focus change keeps the role; matching pane keeps it", () => {
    expect(operatorAfterFocusChange("p1", "p1", "p1")).toBe("p1");
    expect(operatorAfterFocusChange("p1", null, null)).toBe("p1");
  });
});
