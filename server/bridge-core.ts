/**
 * Transport-agnostic bridge session: herdr snapshot/event fan-out, whitelisted
 * RPC dispatch and per-pane terminal attach slots. Consumed by the dev
 * WebSocket server (server/index.ts) and the Electron Main process
 * (desktop/main.ts) over the same ClientFrame/ServerFrame contract.
 */
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isRpcMethod } from "../shared/protocol.ts";
import {
  HerdrError,
  herdrRpc,
  subscribeEvents,
  type EventFrame,
  type Subscription,
} from "./herdr.ts";
import { openTerminalLink, type TerminalLink } from "./client-link.ts";

const STRUCTURE_SUBSCRIPTIONS: Record<string, unknown>[] = [
  { type: "workspace.created" },
  { type: "workspace.updated" },
  { type: "workspace.metadata_updated" },
  { type: "workspace.renamed" },
  { type: "workspace.moved" },
  { type: "workspace.reordered" },
  { type: "workspace.closed" },
  { type: "worktree.created" },
  { type: "worktree.opened" },
  { type: "worktree.removed" },
  { type: "tab.created" },
  { type: "tab.closed" },
  { type: "tab.renamed" },
  { type: "tab.moved" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.updated" },
  { type: "pane.moved" },
  { type: "layout.updated" },
];

function statusSubscriptions(snapshot: SessionSnapshot): Record<string, unknown>[] {
  return snapshot.panes.map((pane) => ({ type: "pane.agent_status_changed", pane_id: pane.pane_id }));
}

export async function fetchSnapshot(): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {});
  return result.snapshot;
}

interface TerminalSlot {
  refs: number;
  link: TerminalLink | null;
  /** Operations queued until the attach resolves. */
  queue: (() => void)[];
  gone: boolean;
}

interface SessionState {
  send: (frame: ServerFrame) => void;
  subscription: Subscription | null;
  subscribedPaneIds: Set<string>;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
  snapshot: SessionSnapshot | null;
  terminals: Map<string, TerminalSlot>;
}

function pushSnapshot(state: SessionState): void {
  void fetchSnapshot()
    .then((snapshot) => {
      state.snapshot = snapshot;
      state.send({ type: "snapshot", snapshot });
      reconcileSubscriptions(state, snapshot);
    })
    .catch(() => {
      /* herdr unreachable; the client shows its own offline state */
    });
}

function reconcileSubscriptions(state: SessionState, snapshot: SessionSnapshot): void {
  const ids = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const same =
    state.subscribedPaneIds.size === ids.size && [...ids].every((id) => state.subscribedPaneIds.has(id));
  if (same) return;
  // A second subscribe on a live connection is ignored: reopen with the full set.
  state.subscription?.close();
  state.subscription = openSubscription(state, snapshot);
}

function openSubscription(state: SessionState, snapshot: SessionSnapshot): Subscription {
  state.subscribedPaneIds = new Set(snapshot.panes.map((pane) => pane.pane_id));
  return subscribeEvents([...STRUCTURE_SUBSCRIPTIONS, ...statusSubscriptions(snapshot)], {
    onEvent: (frame: EventFrame) => {
      state.send({ type: "event", event: frame });
      scheduleSnapshot(state);
    },
    onError: () => scheduleSnapshot(state),
    onClose: () => {
      state.subscription = null;
      state.subscribedPaneIds = new Set();
      scheduleSnapshot(state);
      // Retry the subscription itself; the snapshot push above already ran once.
      state.pushTimer = setTimeout(() => {
        state.pushTimer = null;
        void fetchSnapshot().then((snapshot) => {
          state.send({ type: "snapshot", snapshot });
          state.subscription = openSubscription(state, snapshot);
        }).catch(() => {});
      }, 2000);
    },
  });
}

function scheduleSnapshot(state: SessionState): void {
  if (state.snapshotTimer !== null) return;
  state.snapshotTimer = setTimeout(() => {
    state.snapshotTimer = null;
    pushSnapshot(state);
  }, 120);
}

function dropTerminal(state: SessionState, paneId: string, slot: TerminalSlot, reason: string): void {
  if (slot.gone) return;
  slot.gone = true;
  if (state.terminals.get(paneId) === slot) state.terminals.delete(paneId);
  state.send({ type: "terminal_closed", paneId, reason });
}

function ensureTerminal(state: SessionState, paneId: string, cols: number, rows: number): TerminalSlot {
  const existing = state.terminals.get(paneId);
  if (existing) {
    existing.refs += 1;
    return existing;
  }
  const slot: TerminalSlot = { refs: 1, link: null, queue: [], gone: false };
  state.terminals.set(paneId, slot);

  const pane = state.snapshot?.panes.find((p) => p.pane_id === paneId);
  const terminalId = pane?.terminal_id;
  if (!terminalId) {
    slot.gone = true;
    state.terminals.delete(paneId);
    state.send({ type: "terminal_closed", paneId, reason: "unknown_pane" });
    return slot;
  }

  openTerminalLink(terminalId, { cols, rows }, {
    onEvent: (event) => {
      if (slot.gone) return;
      if (event.type === "terminal") {
        state.send({ type: "terminal_data", paneId, data: Buffer.from(event.bytes).toString("base64") });
      } else if (event.type === "shutdown") {
        dropTerminal(state, paneId, slot, event.reason ?? "herdr_shutdown");
        slot.link?.close();
      }
    },
    onClose: (reason) => {
      dropTerminal(state, paneId, slot, reason);
    },
  }).then((link) => {
    if (slot.gone) {
      link.close();
      return;
    }
    slot.link = link;
    for (const op of slot.queue.splice(0)) op();
  }).catch((error: unknown) => {
    dropTerminal(state, paneId, slot, error instanceof Error ? error.message : String(error));
  });
  return slot;
}

function releaseTerminal(state: SessionState, paneId: string): void {
  const slot = state.terminals.get(paneId);
  if (!slot) return;
  slot.refs -= 1;
  if (slot.refs > 0) return;
  state.terminals.delete(paneId);
  slot.gone = true;
  slot.link?.close();
}

function handleClientFrame(state: SessionState, frame: ClientFrame): void {
  switch (frame.type) {
    case "rpc": {
      if (!isRpcMethod(frame.method)) {
        state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: "method_not_allowed", message: frame.method } });
        return;
      }
      void herdrRpc(frame.method, frame.params ?? {})
        .then((result) => {
          state.send({ type: "rpc_result", id: frame.id, ok: true, result });
          scheduleSnapshot(state);
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: err.code, message: err.message } });
        });
      return;
    }
    case "subscribe_terminal":
      // The client follows with terminal_resize once its grid is measured;
      // input/resize frames queue until the attach resolves.
      ensureTerminal(state, frame.paneId, frame.cols ?? 80, frame.rows ?? 24);
      return;
    case "unsubscribe_terminal":
      releaseTerminal(state, frame.paneId);
      return;
    case "terminal_input": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      const bytes = new TextEncoder().encode(frame.data);
      const write = () => slot.link?.write(bytes);
      if (slot.link) write();
      else slot.queue.push(write);
      return;
    }
    case "terminal_resize": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      const resize = () => slot.link?.resize(frame.cols, frame.rows);
      if (slot.link) resize();
      else slot.queue.push(resize);
      return;
    }
  }
}

export interface BridgeSession {
  /** Feed one client frame (already JSON-parsed). */
  handleFrame(frame: ClientFrame): void;
  /** Initial snapshot + subscription; resolves when the first snapshot is pushed or fails. */
  start(): Promise<void>;
  /** Most recent snapshot this session produced, or null before the first one. */
  latestSnapshot(): SessionSnapshot | null;
  /** Release subscriptions and every terminal link. */
  close(): void;
}

/**
 * Create a bridge session bound to one consumer (one WebSocket, or one
 * Electron window). `send` receives ServerFrames; the consumer owns framing.
 */
export function createBridgeSession(send: (frame: ServerFrame) => void): BridgeSession {
  const state: SessionState = {
    send,
    subscription: null,
    subscribedPaneIds: new Set(),
    snapshotTimer: null,
    pushTimer: null,
    snapshot: null,
    terminals: new Map(),
  };
  return {
    handleFrame: (frame) => handleClientFrame(state, frame),
    start: () =>
      fetchSnapshot()
        .then((snapshot) => {
          state.snapshot = snapshot;
          state.send({ type: "ready", snapshot });
          state.subscription = openSubscription(state, snapshot);
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: "boot", ok: false, error: { code: err.code, message: err.message } });
        }),
    latestSnapshot: () => state.snapshot,
    close: () => {
      state.subscription?.close();
      if (state.snapshotTimer) clearTimeout(state.snapshotTimer);
      if (state.pushTimer) clearTimeout(state.pushTimer);
      for (const [paneId, slot] of state.terminals) {
        slot.gone = true;
        slot.link?.close();
        state.terminals.delete(paneId);
      }
    },
  };
}
