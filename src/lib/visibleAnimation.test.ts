import { describe, expect, test } from "bun:test";

import {
  formatVisibleAnimationDiagnostics,
  visibleAnimationDiagnostics,
  type VisibleAnimationDiagnostics,
} from "./visibleAnimation";

// Issue #420: the diagnostics snapshot is the real-device evidence for the
// Windows animation-stop investigation. These tests pin its shape and its
// no-DOM behavior (bun test has no window/document/IntersectionObserver).

describe("visibleAnimationDiagnostics", () => {
  test("returns safe defaults without a DOM", () => {
    const d = visibleAnimationDiagnostics();
    expect(d.intersectionObserver).toBe(false);
    expect(d.reducedMotion).toBeNull();
    expect(d.visibilityState).toBe("unavailable");
    expect(d.observed).toBe(0);
    expect(d.running).toBe(0);
    expect(d.samples).toEqual([]);
  });
});

describe("formatVisibleAnimationDiagnostics", () => {
  test("emits a self-describing JSON report", () => {
    const diagnostics: VisibleAnimationDiagnostics = {
      intersectionObserver: true,
      reducedMotion: false,
      visibilityState: "visible",
      observed: 2,
      running: 1,
      userAgent: "Mozilla/5.0 test",
      platform: "Win32",
      samples: [
        {
          intersecting: true,
          running: true,
          animationName: "spin",
          animationPlayState: "running",
          animationDuration: "1s",
        },
      ],
    };
    const text = formatVisibleAnimationDiagnostics(diagnostics);
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe("herdr-t3.visible-animation");
    expect(parsed.issue).toBe(420);
    expect(parsed.reducedMotion).toBe(false);
    expect(parsed.visibilityState).toBe("visible");
    expect(parsed.observed).toBe(2);
    expect(parsed.running).toBe(1);
    expect(parsed.samples[0].animationPlayState).toBe("running");
  });
});
