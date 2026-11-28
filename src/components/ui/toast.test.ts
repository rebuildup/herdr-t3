import { describe, expect, test } from "bun:test";

import { toastAgeLabel, toastMetaParts, type ToastNoticeData } from "./toast";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
} from "./toast.logic";

// Issue #550: the toast contract — age/meta derivation, action
// visibility and the stacked layout math — is pure logic and pinned
// here so the visual layer stays a thin renderer.

describe("toastAgeLabel", () => {
  const now = 1_800_000_000_000;

  test("fresh notices read 'just now'", () => {
    expect(toastAgeLabel(now - 1_000, now)).toBe("just now");
    expect(toastAgeLabel(now - 44_000, now)).toBe("just now");
    // Future timestamps clamp to zero age.
    expect(toastAgeLabel(now + 60_000, now)).toBe("just now");
  });

  test("minutes and hours bucket by rounding", () => {
    expect(toastAgeLabel(now - 90_000, now)).toBe("2m ago");
    expect(toastAgeLabel(now - 3_600_000, now)).toBe("1h ago");
    expect(toastAgeLabel(now - 5 * 3_600_000, now)).toBe("5h ago");
  });

  test("day-old notices fall back to a date string", () => {
    const label = toastAgeLabel(now - 3 * 86_400_000, now);
    expect(label).not.toContain("ago");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("toastMetaParts", () => {
  test("joins context and age with the separator, skipping blanks", () => {
    const data: ToastNoticeData = {
      context: "my-app · mbp",
      createdAt: Date.now() - 120_000,
    };
    expect(toastMetaParts(data)).toEqual(["my-app · mbp", "2m ago"]);
  });

  test("missing fields produce no parts", () => {
    expect(toastMetaParts(undefined)).toEqual([]);
    expect(toastMetaParts({})).toEqual([]);
    expect(toastMetaParts({ context: "  " })).toEqual([]);
  });
});

describe("toast.logic", () => {
  test("hasVisibleToastAction requires non-empty children", () => {
    expect(hasVisibleToastAction(undefined)).toBe(false);
    expect(hasVisibleToastAction(null)).toBe(false);
    expect(hasVisibleToastAction({})).toBe(false);
    expect(hasVisibleToastAction({ children: "" })).toBe(false);
    expect(hasVisibleToastAction({ children: "Open" })).toBe(true);
    expect(hasVisibleToastAction({ children: 0 })).toBe(true);
  });

  test("shouldHideCollapsedToastContent hides only stacked-behind toasts", () => {
    expect(shouldHideCollapsedToastContent(0, 1)).toBe(false);
    expect(shouldHideCollapsedToastContent(0, 3)).toBe(false);
    expect(shouldHideCollapsedToastContent(1, 3)).toBe(true);
    expect(shouldHideCollapsedToastContent(2, 3)).toBe(true);
  });

  test("buildVisibleToastLayout stacks heights and marks ending toasts", () => {
    const layout = buildVisibleToastLayout([
      { id: "a", height: 40 },
      { id: "b", height: 60, transitionStatus: "ending" as const },
      { id: "c", height: 0 },
    ]);
    expect(layout.frontmostHeight).toBe(40);
    expect(layout.items.map((i) => [i.toast.id, i.visibleIndex, i.offsetY])).toEqual([
      ["a", 0, 0],
      ["b", 1, 40],
      ["c", 1, 40],
    ]);
  });
});
