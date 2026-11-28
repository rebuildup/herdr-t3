/*
 * Live terminal-surface registry (issue #429). `PaneTerminal` registers a
 * read-only handle for each mounted pane so surfaces that are not the
 * pane itself — the copy-report dialog — can pull bounded scrollback
 * text through the same engine the user sees (`textOf` over engine
 * history, soft wraps already joined, trailing cell blanks dropped).
 *
 * Only *mounted* panes are registered: the map is populated inside the
 * surface effect and cleared on dispose, so a lookup can never return a
 * dead engine or a pane the user cannot currently see. No polling, no
 * caching of text — every read goes to the live session.
 */
import type { EngineHistory, ScreenRange } from "./ghostty/session.ts";

export interface PaneSurfaceHandle {
  /** current cell grid, for range construction */
  cols(): number;
  rows(): number;
  history(): EngineHistory;
  /** engine textOf: plain text, trailing row blanks dropped, wraps joined */
  textOf(range: ScreenRange): string;
}

const registry = new Map<string, PaneSurfaceHandle>();

function key(machine: string, paneId: string): string {
  return `${machine}\n${paneId}`;
}

export function registerPaneSurface(
  machine: string,
  paneId: string,
  handle: PaneSurfaceHandle,
): void {
  registry.set(key(machine, paneId), handle);
}

export function unregisterPaneSurface(machine: string, paneId: string): void {
  registry.delete(key(machine, paneId));
}

/** The mounted surface for a pane, or null when it is not on screen. */
export function getPaneSurface(machine: string, paneId: string): PaneSurfaceHandle | null {
  return registry.get(key(machine, paneId)) ?? null;
}
