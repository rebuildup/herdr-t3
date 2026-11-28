/**
 * GUI window-activity gate for the inter-client operator role
 * (issue #600 verification of #584, program #233/#568; contract:
 * docs/migration/contracts/terminal-noninterference.md).
 *
 * The operator role carries input AND PTY size authority
 * (`direct_attach_resize_locks`). A GUI window nobody is looking at must
 * not hold that authority: while the window is hidden or blurred the
 * canvas releases the role (every pane demotes to ObserveTerminal, so
 * the resize lock returns to layout/herdr control) and suppresses new
 * promotions until the window is active again. Real input intent cannot
 * arrive while blurred anyway — the gate exists for the state that
 * outlives the blur: a pane promoted just before the window lost focus
 * must not keep pinning its size.
 *
 * Pure helpers are DOM-free so bun-test can pin them; the subscription
 * wiring guards `window`/`document` for non-DOM environments.
 */

export interface WindowActivitySignals {
  /** `document.visibilityState === "hidden"` (occluded/minimized) */
  hidden: boolean;
  /** the window does not have OS focus (blur without hide) */
  blurred: boolean;
}

/** Active = visible AND focused. Either signal alone deactivates. */
export function windowActive(signals: WindowActivitySignals): boolean {
  return !signals.hidden && !signals.blurred;
}

/**
 * Operator-role transition on an activity change: losing activity always
 * releases the role (demote to observe); regaining it never restores one —
 * the user must produce real input intent again (AGENTS.md §3: nothing is
 * re-armed silently).
 */
export function operatorAfterWindowActivity(
  operator: string | null,
  active: boolean,
): string | null {
  return active ? operator : null;
}

/**
 * Subscribe to window activity changes. Returns the current activity and
 * an unsubscribe function. In non-DOM environments (bun test, SSR) the
 * subscription is a no-op reporting active — there is no window to be
 * inactive.
 */
export function subscribeWindowActivity(
  onChange: (active: boolean) => void,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    onChange(true);
    return () => {};
  }
  let blurred = !document.hasFocus();
  const emit = () => {
    onChange(windowActive({ hidden: document.visibilityState === "hidden", blurred }));
  };
  const onVisibility = () => emit();
  const onBlur = () => {
    blurred = true;
    emit();
  };
  const onFocus = () => {
    blurred = false;
    emit();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  emit();
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
  };
}
