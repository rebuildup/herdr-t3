import { describe, expect, test } from "bun:test";
import {
  operatorAfterWindowActivity,
  subscribeWindowActivity,
  windowActive,
} from "./windowActivity";

/**
 * Contract tests for the window-activity gate (issue #600, verifying the
 * #584 operator-role split): an inactive/blurred GUI window must not hold
 * or acquire the writable attach — no operator promotion, no resize-lock
 * retention, no silent re-arm on refocus.
 */

describe("windowActive", () => {
  test("visible + focused is the only active state", () => {
    expect(windowActive({ hidden: false, blurred: false })).toBe(true);
    expect(windowActive({ hidden: true, blurred: false })).toBe(false);
    expect(windowActive({ hidden: false, blurred: true })).toBe(false);
    expect(windowActive({ hidden: true, blurred: true })).toBe(false);
  });
});

describe("operatorAfterWindowActivity", () => {
  test("losing window activity always releases the operator role", () => {
    expect(operatorAfterWindowActivity("p1", false)).toBeNull();
    expect(operatorAfterWindowActivity(null, false)).toBeNull();
  });

  test("regaining activity never restores the role — intent must re-grant", () => {
    // The role was already cleared on blur; focus returning leaves it
    // null. Restoration is impossible through this transition by design.
    expect(operatorAfterWindowActivity(null, true)).toBeNull();
    // An operator granted while active survives unrelated activity ticks.
    expect(operatorAfterWindowActivity("p2", true)).toBe("p2");
  });
});

describe("subscribeWindowActivity", () => {
  test("non-DOM environments report active and unsubscribe cleanly", () => {
    // bun test has no window/document: the gate must not deactivate panes
    // in headless/test contexts.
    const seen: boolean[] = [];
    const off = subscribeWindowActivity((a) => seen.push(a));
    expect(seen).toEqual([true]);
    off();
    expect(seen).toEqual([true]);
  });
});
