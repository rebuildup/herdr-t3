/*
 * Ported from T3 Code (MIT, © 2026 T3 Tools Inc.).
 * Source: apps/web/src/lib/visibleAnimation.ts @ 9cc4018c.
 * Local changes: header comment; `running` tracking on observed
 * animations and the #420 diagnostics snapshot/formatter (Settings →
 * Diagnostics reports the gating inputs on real devices).
 */
interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
  running: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function updateAnimation(animation: ObservedAnimation) {
  const running =
    animation.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches;
  animation.running = running;
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto",
  );
}

function updateAnimations() {
  for (const animation of animations.values()) updateAnimation(animation);
}

export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") return;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAnimations);
    document.addEventListener("visibilitychange", updateAnimations);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const animation = { element, intersecting: false, running: false };
  animations.set(element, animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAnimations);
    }
  };
}

/*
 * Diagnostics snapshot for the Windows animation-stop investigation
 * (issue #420). The gating inputs — prefers-reduced-motion, document
 * visibility, IntersectionObserver state and the computed animation
 * longhands — are exactly what a real-device check needs; Settings →
 * Diagnostics copies this as JSON so the report does not depend on
 * devtools being available in the packaged app.
 */
export interface VisibleAnimationSample {
  intersecting: boolean;
  running: boolean;
  animationName: string;
  animationPlayState: string;
  animationDuration: string;
}

export interface VisibleAnimationDiagnostics {
  intersectionObserver: boolean;
  /** Live media-query result; null when matchMedia is unavailable. */
  reducedMotion: boolean | null;
  visibilityState: string;
  observed: number;
  running: number;
  userAgent: string | null;
  platform: string | null;
  samples: VisibleAnimationSample[];
}

const DIAGNOSTIC_SAMPLE_LIMIT = 6;

export function visibleAnimationDiagnostics(): VisibleAnimationDiagnostics {
  const samples: VisibleAnimationSample[] = [];
  let running = 0;
  for (const animation of animations.values()) {
    if (animation.running) running += 1;
    if (samples.length < DIAGNOSTIC_SAMPLE_LIMIT && typeof getComputedStyle === "function") {
      try {
        const style = getComputedStyle(animation.element);
        samples.push({
          intersecting: animation.intersecting,
          running: animation.running,
          animationName: style.animationName,
          animationPlayState: style.animationPlayState,
          animationDuration: style.animationDuration,
        });
      } catch {
        /* a detached element must not break the diagnostics snapshot */
      }
    }
  }
  return {
    intersectionObserver: typeof IntersectionObserver !== "undefined",
    reducedMotion:
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : null,
    visibilityState: typeof document === "undefined" ? "unavailable" : document.visibilityState,
    observed: animations.size,
    running,
    userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
    platform: typeof navigator === "undefined" ? null : navigator.platform,
    samples,
  };
}

export function formatVisibleAnimationDiagnostics(
  diagnostics: VisibleAnimationDiagnostics,
): string {
  return JSON.stringify(
    { kind: "herdr-t3.visible-animation", issue: 420, ...diagnostics },
    null,
    2,
  );
}
