/*
 * Context card open state (issue #390) — T3 Code's
 * `threadPanelVisibilityByThreadKey` pattern adapted to herdr-t3's
 * machine/workspace scope. The card is a floating surface over the
 * workspace canvas (inline) or a popover anchored to the header
 * trigger; each workspace keeps its own open state, persisted to
 * localStorage like the right panel's surfaces.
 *
 * The header trigger registers its element per scope so the popover
 * fallback can anchor to it; anchors are DOM references and are never
 * persisted.
 */
import { useSyncExternalStore } from "react";

import { getLocalStorageJson, setLocalStorageJson } from "~/lib/localStorage";

const STORAGE_KEY = "herdr-t3:context-card:v1";

interface ContextCardStoreState {
  openByScope: Record<string, boolean>;
  /** scope -> trigger element for popover anchoring (not persisted). */
  anchors: Record<string, Element>;
}

let state: ContextCardStoreState = {
  openByScope: readPersisted(),
  anchors: {},
};

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: ContextCardStoreState) {
  state = next;
  try {
    setLocalStorageJson(STORAGE_KEY, state.openByScope);
  } catch {
    /* storage unavailable */
  }
  emit();
}

function readPersisted(): Record<string, boolean> {
  const raw = getLocalStorageJson<unknown>(STORAGE_KEY);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true) out[scope] = true;
  }
  return out;
}

export function setContextCardOpen(scope: string, open: boolean) {
  if ((state.openByScope[scope] === true) === open) return;
  const openByScope = { ...state.openByScope };
  if (open) openByScope[scope] = true;
  else delete openByScope[scope];
  setState({ ...state, openByScope });
}

export function toggleContextCard(scope: string) {
  setContextCardOpen(scope, !(state.openByScope[scope] === true));
}

export function setContextCardAnchor(scope: string, element: Element | null) {
  const current = state.anchors[scope];
  if (current === element) return;
  const anchors = { ...state.anchors };
  if (element) anchors[scope] = element;
  else delete anchors[scope];
  setState({ ...state, anchors });
}

export function getContextCardAnchor(scope: string): Element | null {
  return state.anchors[scope] ?? null;
}

export interface ContextCardSnapshot {
  open: boolean;
  anchor: Element | null;
}

/* getSnapshot must return a stable reference between store writes —
 * a fresh object per call would re-render forever. */
const snapshots = new Map<string, ContextCardSnapshot>();

function snapshotFor(scope: string): ContextCardSnapshot {
  const open = state.openByScope[scope] === true;
  const anchor = state.anchors[scope] ?? null;
  const cached = snapshots.get(scope);
  if (cached && cached.open === open && cached.anchor === anchor) return cached;
  const next: ContextCardSnapshot = { open, anchor };
  snapshots.set(scope, next);
  return next;
}

export function useContextCardState(scope: string): ContextCardSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshotFor(scope),
    () => CLOSED_SNAPSHOT,
  );
}

const CLOSED_SNAPSHOT: ContextCardSnapshot = { open: false, anchor: null };
