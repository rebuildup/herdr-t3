/*
 * Right-panel surface store (issue #333): T3 Code's rightPanelStore
 * pattern adapted to herdr-t3's machine/workspace scope. Surfaces are
 * docked tabs beside the workspace canvas — never modal — so terminal
 * input and scroll stay live while a surface is open.
 *
 * Scope key is `${machine}\n${workspace_id}`: each workspace keeps its
 * own open surfaces, matching T3's per-thread panel state. State is
 * persisted to localStorage so reopening a workspace restores its tabs.
 */
import { useSyncExternalStore } from "react";

import { getLocalStorageJson, setLocalStorageJson } from "~/lib/localStorage";

export type RightPanelSurface =
  | { id: `git:${string}`; kind: "git"; paneId: string }
  | { id: "projects"; kind: "projects" }
  | { id: "scripts"; kind: "scripts" }
  | { id: "checkpoints"; kind: "checkpoints"; paneId: string | null }
  | { id: "worktrees"; kind: "worktrees" }
  | { id: "automations"; kind: "automations" }
  | { id: "conversations"; kind: "conversations" }
  | { id: "usage"; kind: "usage" }
  | { id: "artifacts"; kind: "artifacts" }
  | { id: "handoffs"; kind: "handoffs" }
  | { id: "controls"; kind: "controls" }
  | { id: "textgen"; kind: "textgen" }
  | { id: "secrets"; kind: "secrets" }
  | { id: "machines"; kind: "machines" }
  | { id: "mcp"; kind: "mcp" };

export interface RightPanelScopeState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

export const EMPTY_PANEL_STATE: RightPanelScopeState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

/* Same narrow-layout breakpoint as T3 (rightPanelLayout.ts). Shared so
   the workspace header can tell whether the inline panel — the only
   mode that owns the desktop titlebar — is the one rendering. */
export const RIGHT_PANEL_NARROW_QUERY = "(max-width: 980px)";

const STORAGE_KEY = "herdr-t3:right-panel:v1";

interface RightPanelStoreState {
  byScope: Record<string, RightPanelScopeState>;
}

let state: RightPanelStoreState = { byScope: readPersisted() };

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: RightPanelStoreState) {
  state = next;
  persist();
  emit();
}

function persist() {
  try {
    setLocalStorageJson(STORAGE_KEY, state.byScope);
  } catch {
    /* storage unavailable */
  }
}

function isSurface(value: unknown): value is RightPanelSurface {
  if (value === null || typeof value !== "object") return false;
  const s = value as { id?: unknown; kind?: unknown };
  if (typeof s.id !== "string" || typeof s.kind !== "string") return false;
  switch (s.kind) {
    case "git":
      return s.id.startsWith("git:") && typeof (value as { paneId?: unknown }).paneId === "string";
    case "checkpoints":
      return (
        s.id === "checkpoints" &&
        ((value as { paneId?: unknown }).paneId === null ||
          typeof (value as { paneId?: unknown }).paneId === "string")
      );
    case "projects":
    case "scripts":
    case "worktrees":
    case "automations":
    case "conversations":
    case "usage":
    case "artifacts":
    case "handoffs":
    case "controls":
    case "textgen":
    case "secrets":
    case "machines":
    case "mcp":
      return s.id === s.kind;
    default:
      return false;
  }
}

function readPersisted(): Record<string, RightPanelScopeState> {
  const raw = getLocalStorageJson<unknown>(STORAGE_KEY);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, RightPanelScopeState> = {};
  for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const v = value as Partial<RightPanelScopeState>;
    if (!Array.isArray(v.surfaces)) continue;
    const surfaces = v.surfaces.filter(isSurface);
    const ids = new Set<string>(surfaces.map((s) => s.id));
    out[scope] = {
      isOpen: v.isOpen === true,
      activeSurfaceId:
        typeof v.activeSurfaceId === "string" && ids.has(v.activeSurfaceId)
          ? v.activeSurfaceId
          : (surfaces[0]?.id ?? null),
      surfaces,
    };
  }
  return out;
}

function scopeState(scope: string): RightPanelScopeState {
  return state.byScope[scope] ?? EMPTY_PANEL_STATE;
}

function updateScope(
  scope: string,
  updater: (current: RightPanelScopeState) => RightPanelScopeState,
) {
  const current = scopeState(scope);
  const next = updater(current);
  if (next === current) return;
  const byScope = { ...state.byScope };
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0
  ) {
    delete byScope[scope];
  } else {
    byScope[scope] = next;
  }
  setState({ byScope });
}

/** Open (or activate) a surface; the panel becomes visible. */
export function openSurface(scope: string, surface: RightPanelSurface) {
  updateScope(scope, (current) => {
    const exists = current.surfaces.some((s) => s.id === surface.id);
    // Re-opening refreshes the payload in place (e.g. checkpoints picks up
    // the currently focused pane) without moving the tab.
    const surfaces = exists
      ? current.surfaces.map((s) => (s.id === surface.id ? surface : s))
      : [...current.surfaces, surface];
    return {
      isOpen: true,
      surfaces,
      activeSurfaceId: surface.id,
    };
  });
}

/** Toggle: an already-open surface closes; anything else opens. */
export function toggleSurface(scope: string, surface: RightPanelSurface) {
  const current = scopeState(scope);
  if (current.surfaces.some((s) => s.id === surface.id)) {
    closeSurface(scope, surface.id);
    return;
  }
  openSurface(scope, surface);
}

export function activateSurface(scope: string, surfaceId: string) {
  updateScope(scope, (current) =>
    current.surfaces.some((s) => s.id === surfaceId)
      ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
      : current,
  );
}

export function closeSurface(scope: string, surfaceId: string) {
  updateScope(scope, (current) => {
    const index = current.surfaces.findIndex((s) => s.id === surfaceId);
    if (index < 0) return current;
    const surfaces = current.surfaces.filter((s) => s.id !== surfaceId);
    const activeSurfaceId =
      current.activeSurfaceId === surfaceId
        ? (surfaces[Math.min(index, surfaces.length - 1)]?.id ?? null)
        : current.activeSurfaceId;
    return { ...current, surfaces, activeSurfaceId };
  });
}

export function closeOtherSurfaces(scope: string, surfaceId: string) {
  updateScope(scope, (current) =>
    current.surfaces.some((s) => s.id === surfaceId)
      ? { isOpen: true, surfaces: current.surfaces.filter((s) => s.id === surfaceId), activeSurfaceId: surfaceId }
      : current,
  );
}

export function closeAllSurfaces(scope: string) {
  updateScope(scope, () => EMPTY_PANEL_STATE);
}

/** Hide the panel without discarding its surfaces (reopen restores tabs).
 *  An open panel with zero surfaces stays openable/closable so the T3
 *  "Open a surface" empty state remains reachable (issue #411). */
export function setPanelOpen(scope: string, open: boolean) {
  updateScope(scope, (current) =>
    current.isOpen === open ? current : { ...current, isOpen: open },
  );
}

/** Move a surface to `toIndex` (clamped), T3 `moveSurface` semantics. */
export function moveSurface(scope: string, surfaceId: string, toIndex: number) {
  updateScope(scope, (current) => {
    const from = current.surfaces.findIndex((s) => s.id === surfaceId);
    if (from < 0) return current;
    const clamped = Math.max(0, Math.min(toIndex, current.surfaces.length - 1));
    if (clamped === from) return current;
    const surfaces = [...current.surfaces];
    const [moved] = surfaces.splice(from, 1);
    if (moved === undefined) return current;
    surfaces.splice(clamped, 0, moved);
    return { ...current, surfaces };
  });
}

export function getPanelState(scope: string): RightPanelScopeState {
  return scopeState(scope);
}

export function useRightPanelState(scope: string): RightPanelScopeState {
  return useSyncExternalStore(subscribe, () => scopeState(scope), () => EMPTY_PANEL_STATE);
}
