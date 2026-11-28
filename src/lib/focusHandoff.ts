/*
 * State-based terminal focus handoff (issue #435). GUI workspace/tab
 * selection used to leave DOM focus wherever it was — the tab button
 * suppresses mousedown focus and nothing re-focused the terminal, so the
 * user had to click the pane again before typing. The old fix
 * (`paneFocus.ts`) fired blind 200 ms/800 ms retries at whatever
 * `[data-focused]` happened to be rendered, which could target a stale
 * pane and raced the user's next action.
 *
 * This coordinator instead tracks an explicit *pending handoff*: the
 * latest GUI navigation/focus request wins (a generation, not a queue),
 * and it resolves only when the bridge snapshot proves herdr focused the
 * expected workspace/tab and the target pane's `.ghostty-input` is actually
 * mounted. Snapshot pushes, resizes and re-renders alone never create or
 * move a handoff; focus landing on another editable surface, dialog, menu
 * or palette cancels it, as does leaving the workspace route or the
 * deadline expiring.
 *
 * DOM focus here is purely client-side: it must not be confused with the
 * pane's DECSET 1004 focus reports (docs/design/terminal-io.md §4), which
 * the surface emits from the input element's own focus/blur events.
 */
import { LOCAL_MACHINE } from "./api";
import { deriveWorkspace } from "./workspace";
import type { SessionSnapshot } from "../../shared/protocol";
import {
  getBridgeState,
  machineListOf,
  subscribeBridgeState,
} from "~/shell/bridge";
import { currentRoute } from "~/shell/router";
import { isEditableTarget } from "./shortcuts";

/** How long a handoff may wait for herdr + the surface to catch up. */
const HANDOFF_TIMEOUT_MS = 10_000;

export interface FocusHandoffTarget {
  /** machine id; defaults to the routed machine (or the default machine) */
  machine?: string;
  /** workspace the handoff expects; null/undefined = the routed/default one */
  workspaceId?: string | null;
  /** tab the handoff expects; null/undefined = whatever tab is active */
  tabId?: string | null;
}

interface PendingHandoff {
  machine: string;
  workspaceId: string | null;
  tabId: string | null;
  deadline: number;
}

let pending: PendingHandoff | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

function defaultMachine(): string {
  const s = getBridgeState();
  if (s.snapshots[LOCAL_MACHINE]) return LOCAL_MACHINE;
  const first = machineListOf(s).find((m) => s.snapshots[m.id]);
  return first?.id ?? LOCAL_MACHINE;
}

/**
 * The pane a handoff should focus, or null while the snapshot does not yet
 * prove the requested state. Pure so the contract is unit-testable: the
 * DOM layer only mounts `.ghostty-input` for the pane this returns.
 *
 * `workspaceId`/`tabId` are strict when given — a snapshot that still shows
 * the previous selection yields null (keep waiting), never a stale pane.
 */
export function handoffPaneId(
  snapshot: SessionSnapshot | null | undefined,
  workspaceId: string | null,
  tabId: string | null,
): string | null {
  const view = deriveWorkspace(snapshot, workspaceId);
  if (!view.workspace || !view.activeTab) return null;
  if (workspaceId !== null && view.workspace.workspace_id !== workspaceId) {
    return null;
  }
  if (tabId !== null && view.activeTab.tab_id !== tabId) return null;
  return view.focusedPane?.pane_id ?? null;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/** Surfaces that own keyboard focus legitimately — a handoff must never
 *  steal from them (issue #435: no focus theft from inputs/dialogs/menus). */
function isUiFocusSurface(target: HTMLElement): boolean {
  if (target.closest(".ghostty-input")) return false;
  return (
    isEditableTarget(target) ||
    target.closest('[role="dialog"], [role="menu"], [data-command-palette]') !==
      null
  );
}

function clearPending(): void {
  pending = null;
  if (deadlineTimer) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
}

/** Re-check the pending handoff against the latest snapshot + DOM. */
function evaluate(): void {
  const p = pending;
  if (!p) return;
  if (Date.now() > p.deadline) {
    clearPending();
    return;
  }
  const route = currentRoute();
  // The handoff only makes sense on the workspace surface; navigating to
  // settings (or anywhere else) cancels it.
  if (route.name !== "workspace") {
    clearPending();
    return;
  }
  const state = getBridgeState();
  const snapshot = state.snapshots[p.machine];
  // Probe snapshots are list data, not a live session — never focus off them.
  if (!snapshot || state.probeSnapshots[p.machine]) return;
  const paneId = handoffPaneId(snapshot, p.workspaceId, p.tabId);
  if (!paneId) return;
  const input = document.querySelector<HTMLElement>(
    `[data-pane-id="${cssEscape(paneId)}"] .ghostty-input`,
  );
  if (!(input instanceof HTMLElement)) return;
  clearPending();
  input.focus({ preventScroll: true });
}

/** Route changes are themselves focus intents: landing on a workspace
 *  route (click, back/forward, deep link, settings close) hands focus to
 *  the displayed workspace's focused pane once it is ready. */
function onHashChange(): void {
  // Defer so the router's own listener has parsed the new hash first.
  setTimeout(() => {
    const route = currentRoute();
    if (route.name === "workspace") {
      requestFocusHandoff({
        workspaceId: route.workspaceId,
      });
    } else {
      clearPending();
    }
  }, 0);
}

function ensureWired(): void {
  if (wired || typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  wired = true;
  subscribeBridgeState(evaluate);
  // The surface's hidden input mounts asynchronously (engine load +
  // attach), so snapshot pushes alone are not enough — watch for the
  // element appearing while a handoff is pending.
  new MutationObserver(() => {
    if (pending) evaluate();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener(
    "focusin",
    (event) => {
      if (!pending) return;
      const target = event.target;
      if (target instanceof HTMLElement && isUiFocusSurface(target)) {
        clearPending();
      }
    },
    true,
  );
}

/**
 * Ask the coordinator to move DOM focus to the input of the pane herdr
 * reports focused for the target workspace/tab once both the snapshot and
 * the mounted surface agree. Latest call wins; safe to call before the
 * RPC that produces the state has even been sent.
 */
export function requestFocusHandoff(target: FocusHandoffTarget = {}): void {
  ensureWired();
  const route = currentRoute();
  const routeMachine =
    route.name === "workspace" ? (route.machine ?? defaultMachine()) : null;
  pending = {
    machine: target.machine ?? routeMachine ?? defaultMachine(),
    workspaceId:
      target.workspaceId !== undefined
        ? target.workspaceId
        : route.name === "workspace"
          ? route.workspaceId
          : null,
    tabId: target.tabId ?? null,
    deadline: Date.now() + HANDOFF_TIMEOUT_MS,
  };
  if (deadlineTimer) clearTimeout(deadlineTimer);
  deadlineTimer = setTimeout(clearPending, HANDOFF_TIMEOUT_MS);
  evaluate();
}

/**
 * Return focus to the working terminal of the current route (issue #128
 * menu/palette restore path). State-based successor of the old fixed
 * 200 ms/800 ms retries: resolves when the snapshot and the mounted
 * surface agree, and is cancelled by any later explicit request.
 */
export function focusPaneTerminal(): void {
  requestFocusHandoff();
}

/** Drop any pending handoff (e.g. the user deliberately moved focus). */
export function cancelFocusHandoff(): void {
  clearPending();
}
