/*
 * Keyboard shortcut plumbing for the app shell. `mod` means Meta on macOS
 * and Ctrl elsewhere; handlers only fire for explicit modifier combos so
 * plain typing is never intercepted.
 */

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function modKey(event: KeyboardEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

/** True when the event matches `key` with the required modifiers held. */
export function matchShortcut(
  event: KeyboardEvent,
  spec: { key: string; mod?: boolean; shift?: boolean; alt?: boolean },
): boolean {
  if (event.key.toLowerCase() !== spec.key.toLowerCase()) return false;
  const mod = modKey(event);
  if (spec.mod !== undefined && mod !== spec.mod) return false;
  if (spec.shift !== undefined && event.shiftKey !== spec.shift) return false;
  if (spec.alt !== undefined && event.altKey !== spec.alt) return false;
  return true;
}
