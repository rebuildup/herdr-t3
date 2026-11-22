import { useSyncExternalStore } from "react";

/*
 * Ported from t3code apps/web/src/lib/windowControlsOverlay.ts (MIT).
 * Deviation: T3 reserves MACOS_TITLEBAR_HEIGHT for its custom macOS titlebar;
 * herdr-t3 uses the native window frame, so the overlay height is the only
 * source of a caption strip.
 */

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

/** Height of the native caption strip drawn over the page, or 0 when the window has none. */
export function windowControlsOverlayHeight(): number {
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().height : 0;
}

function subscribeTitlebarArea(listener: () => void): () => void {
  const overlay = getWindowControlsOverlay();
  overlay?.addEventListener("geometrychange", listener);
  return () => overlay?.removeEventListener("geometrychange", listener);
}

function getNativeTitlebarHeight(): number {
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0;
}

export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribeTitlebarArea, getNativeTitlebarHeight, () => 0);
}
