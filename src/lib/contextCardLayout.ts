/*
 * Context card placement + density (issue #390) — port of T3 Code's
 * `threadDetailsCardLayout.ts` (`components/chat/`) adapted to the
 * workspace canvas. The card is 280px wide (T3's
 * `--thread-details-panel-width`) and prefers an inline card floating
 * at the canvas's top-right; when the canvas is too narrow it falls
 * back to a popover anchored to the header trigger.
 *
 * Density is resolved from *measured* content heights per density, so
 * it follows available space in both directions — space returning
 * restores `full` (unlike a one-way downgrade).
 */

export const CONTEXT_CARD_GAP = 12;
export const CONTEXT_CARD_WIDTH = 280;
/**
 * Remaining canvas width the card must leave visible. T3 guards its
 * chat lane at `minChatWidth` 640; a terminal canvas stays usable with
 * less, so the card yields to popover mode below ~400px of pane area
 * (roughly one usable pane plus its borders).
 */
export const CONTEXT_CARD_MIN_REMAINING = 400;
/** Below this the card is not worth showing even as a popover. */
export const CONTEXT_CARD_MIN_HEIGHT = 160;

export type ContextCardDensity = "full" | "compact" | "essential";

export function resolveContextCardDensity(
  height: number,
  content: { full: number; compact: number },
): ContextCardDensity {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/**
 * Inline placement inside the canvas container, or null when the card
 * must render as a popover instead. `top`/`height` are in container
 * pixels; the caller positions the card `absolute` at `right`/`top`.
 */
export function resolveContextCardPlacement({
  container,
  rightInset = 0,
}: {
  container: { width: number; height: number };
  /** Extra clearance kept free on the card's right edge, in px — e.g.
   * the narrow-layout right-panel sheet that overlays the canvas's
   * right side (issue #480). */
  rightInset?: number;
}): { right: number; top: number; width: number; height: number } | null {
  const { width, height } = container;
  if (width - CONTEXT_CARD_WIDTH - CONTEXT_CARD_GAP * 2 < CONTEXT_CARD_MIN_REMAINING) {
    return null;
  }
  const right = CONTEXT_CARD_GAP + rightInset;
  // The shifted card must still fit inside the container — otherwise the
  // popover fallback is the lesser evil.
  if (width - right - CONTEXT_CARD_WIDTH < CONTEXT_CARD_GAP) return null;
  const top = CONTEXT_CARD_GAP;
  const available = height - top - CONTEXT_CARD_GAP;
  if (available < CONTEXT_CARD_MIN_HEIGHT) return null;
  return {
    right,
    top,
    width: CONTEXT_CARD_WIDTH,
    height: available,
  };
}
