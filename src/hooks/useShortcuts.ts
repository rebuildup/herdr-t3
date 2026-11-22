import { useEffect, useRef } from "react";

/**
 * Registers a single keydown handler. The handler is read through a ref so
 * callers can pass fresh closures without re-subscribing every render.
 */
export function useShortcutHandler(
  handler: (event: KeyboardEvent) => void,
  enabled = true,
) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => ref.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
