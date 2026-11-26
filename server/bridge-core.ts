/**
 * Transport-agnostic bridge session: herdr snapshot/event fan-out, whitelisted
 * RPC dispatch and per-pane terminal attach slots. Consumed by the dev
 * WebSocket server (server/index.ts) and the Electron Main process
 * (desktop/main.ts) over the same ClientFrame/ServerFrame contract.
 */
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isRpcMethod } from "../shared/protocol.ts";
import { protocolCodecWasm } from "../shared/protocolWasm.ts";
import {
  HerdrError,
  herdrRpc,
  subscribeEvents,
  type EventFrame,
  type Subscription,
} from "./herdr.ts";
import { openTerminalLink, type TerminalLink } from "./client-link.ts";
import { clientSocketPath } from "./client-link.ts";
import { herdrSocketPath, socketAddress } from "./herdr.ts";
import { socketConnector, type Connector } from "./socket.ts";

/**
 * Where a bridge session's herdr traffic goes. `api` carries the JSON-lines
 * RPC + events.subscribe contract; `client` carries the private bincode
 * terminal-attach protocol. Local uses the unix socket / named pipe;
 * SSH machines use herdr's remote bridge commands over ssh stdio
 * (server/ssh.ts, ADR-0006).
 */
export interface BridgeEndpoint {
  api: Connector;
  client: Connector;
  /** Human-readable endpoint name for diagnostics. */
  label: string;
}

export function localEndpoint(): BridgeEndpoint {
  return {
    api: socketConnector(socketAddress(herdrSocketPath())),
    client: socketConnector(socketAddress(clientSocketPath())),
    label: herdrSocketPath(),
  };
}

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

/**
 * `pane.scroll_changed` for every pane with a live terminal attach
 * (issues #433/#436): the selection contract needs the server's
 * authoritative `offset_from_bottom`/`max_offset_from_bottom` to project
 * highlights onto the rows the attach blit actually shows.
 */
function scrollSubscriptions(state: SessionState): Record<string, unknown>[] {
  return [...state.terminals.keys()].map((pane_id) => ({
    type: "pane.scroll_changed",
    pane_id,
  }));
}

/**
 * Reopen the event subscription when the attached-pane set changed since
 * the last open — herdr ignores a second subscribe on a live connection,
 * so the full set (structure + status + scroll) goes out together.
 */
function syncScrollSubscriptions(state: SessionState): void {
  if (!state.snapshot || !state.subscription) return;
  const want = new Set(state.terminals.keys());
  if (
    want.size === state.scrollSubscribed.size &&
    [...want].every((id) => state.scrollSubscribed.has(id))
  ) {
    return;
  }
  state.scrollSubscribed = want;
  state.subscription.close();
  state.subscription = openSubscription(state, state.snapshot);
}

export async function fetchSnapshot(endpoint?: BridgeEndpoint): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>(
    "session.snapshot",
    {},
    endpoint ? { connect: endpoint.api, timeoutMs: 20000 } : {},
  );
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
  endpoint: BridgeEndpoint;
  machine: string;
  subscription: Subscription | null;
  subscribedPaneIds: Set<string>;
  /** pane ids the live subscription carries `pane.scroll_changed` for */
  scrollSubscribed: Set<string>;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
  snapshot: SessionSnapshot | null;
  terminals: Map<string, TerminalSlot>;
}

function pushSnapshot(state: SessionState): void {
  void fetchSnapshot(state.endpoint)
    .then((snapshot) => {
      state.snapshot = snapshot;
      state.send({ type: "snapshot", snapshot, machine: state.machine });
      reconcileSubscriptions(state, snapshot);
    })
    .catch((error: unknown) => {
      /* herdr unreachable; surface it so diagnostics and the client can tell
         "offline" apart from "empty session". Renderers ignore unknown ids. */
      const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
      state.send({
        type: "rpc_result",
        id: "bridge-health",
        ok: false,
        error: { code: err.code, message: err.message },
        machine: state.machine,
      });
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
  state.scrollSubscribed = new Set(state.terminals.keys());
  return subscribeEvents(
    [
      ...STRUCTURE_SUBSCRIPTIONS,
      ...statusSubscriptions(snapshot),
      ...scrollSubscriptions(state),
    ],
    {
      onEvent: (frame: EventFrame) => {
        state.send({ type: "event", event: frame, machine: state.machine });
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
          void fetchSnapshot(state.endpoint)
            .then((snapshot) => {
              state.send({ type: "snapshot", snapshot, machine: state.machine });
              state.subscription = openSubscription(state, snapshot);
            })
            .catch(() => {});
        }, 2000);
      },
    },
    state.endpoint.api,
  );
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
  state.send({ type: "terminal_closed", paneId, reason, machine: state.machine });
}

function ensureTerminal(state: SessionState, paneId: string, cols: number, rows: number, takeover: boolean): TerminalSlot {
  const existing = state.terminals.get(paneId);
  if (existing) {
    existing.refs += 1;
    return existing;
  }
  const slot: TerminalSlot = { refs: 1, link: null, queue: [], gone: false };
  state.terminals.set(paneId, slot);
  syncScrollSubscriptions(state);

  const pane = state.snapshot?.panes.find((p) => p.pane_id === paneId);
  const terminalId = pane?.terminal_id;
  if (!terminalId) {
    // The pane may be newer than the last snapshot (just created by an RPC
    // whose snapshot push is still debounced). Refresh once and retry
    // instead of failing the attach outright.
    void fetchSnapshot(state.endpoint)
      .then((snapshot) => {
        state.snapshot = snapshot;
        const fresh = snapshot.panes.find((p) => p.pane_id === paneId)?.terminal_id;
        if (slot.gone) return;
        if (!fresh) {
          dropTerminal(state, paneId, slot, "unknown_pane");
          return;
        }
        attachTerminal(state, slot, paneId, fresh, cols, rows, takeover);
      })
      .catch(() => {
        if (!slot.gone) dropTerminal(state, paneId, slot, "unknown_pane");
      });
    return slot;
  }
  attachTerminal(state, slot, paneId, terminalId, cols, rows, takeover);
  return slot;
}

function attachTerminal(
  state: SessionState,
  slot: TerminalSlot,
  paneId: string,
  terminalId: string,
  cols: number,
  rows: number,
  takeover: boolean,
): void {
  // Default attach observes without stealing the viewer role from an
  // existing client (TUI, second window). Takeover is only requested when
  // the client explicitly asked for it after an attach refusal.
  openTerminalLink(terminalId, { cols, rows, connect: state.endpoint.client, takeover }, {
    onEvent: (event) => {
      if (slot.gone) return;
      if (event.type === "terminal") {
        state.send({ type: "terminal_data", paneId, data: Buffer.from(event.bytes).toString("base64"), machine: state.machine });
      } else if (event.type === "mouse_capture") {
        // herdr ServerMessage::MouseCapture: the attached pane's program
        // currently requests mouse reporting (issue #169). Older herdr
        // never sends it — the client keeps its conservative fallback.
        state.send({ type: "terminal_mouse_capture", paneId, enabled: event.enabled, machine: state.machine });
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
}

function releaseTerminal(state: SessionState, paneId: string): void {
  const slot = state.terminals.get(paneId);
  if (!slot) return;
  slot.refs -= 1;
  if (slot.refs > 0) return;
  state.terminals.delete(paneId);
  slot.gone = true;
  slot.link?.close();
  syncScrollSubscriptions(state);
}

function handleClientFrame(state: SessionState, frame: ClientFrame): void {
  switch (frame.type) {
    case "rpc": {
      if (!(protocolCodecWasm?.isRpcMethod(frame.method) ?? isRpcMethod(frame.method))) {
        state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: "method_not_allowed", message: frame.method }, machine: state.machine });
        return;
      }
      void herdrRpc(frame.method, frame.params ?? {}, { connect: state.endpoint.api, timeoutMs: 20000 })
        .then((result) => {
          state.send({ type: "rpc_result", id: frame.id, ok: true, result, machine: state.machine });
          scheduleSnapshot(state);
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: err.code, message: err.message }, machine: state.machine });
        });
      return;
    }
    case "subscribe_terminal":
      // The client follows with terminal_resize once its grid is measured;
      // input/resize frames queue until the attach resolves.
      ensureTerminal(state, frame.paneId, frame.cols ?? 80, frame.rows ?? 24, frame.takeover === true);
      return;
    case "unsubscribe_terminal":
      releaseTerminal(state, frame.paneId);
      return;
    case "terminal_input": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      const bytes = Buffer.from(frame.data, "base64");
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
    case "terminal_mouse": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      const mouse = () =>
        slot.link?.mouse({
          action: frame.action,
          button: frame.button ?? null,
          column: frame.column,
          row: frame.row,
          modifiers: frame.modifiers ?? 0,
        });
      if (slot.link) mouse();
      else slot.queue.push(mouse);
      return;
    }
    case "terminal_scroll": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      const scroll = () =>
        slot.link?.scroll(frame.direction, frame.lines, frame.column, frame.row, frame.modifiers);
      if (slot.link) scroll();
      else slot.queue.push(scroll);
      return;
    }
    // Machine-management frames are routed by the machine manager before
    // they reach a session; a session never sees them.
    case "list_machines":
    case "machine_connect":
    case "machine_disconnect":
    case "machine_add":
    case "machine_remove":
    case "machine_update":
      return;
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
export function createBridgeSession(
  send: (frame: ServerFrame) => void,
  endpoint: BridgeEndpoint = localEndpoint(),
  machine = "local",
): BridgeSession {
  const state: SessionState = {
    send,
    endpoint,
    machine,
    subscription: null,
    subscribedPaneIds: new Set(),
    scrollSubscribed: new Set(),
    snapshotTimer: null,
    pushTimer: null,
    snapshot: null,
    terminals: new Map(),
  };
  return {
    handleFrame: (frame) => handleClientFrame(state, frame),
    start: () =>
      fetchSnapshot(endpoint)
        .then((snapshot) => {
          state.snapshot = snapshot;
          state.send({ type: "ready", snapshot, machine });
          state.subscription = openSubscription(state, snapshot);
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: "boot", ok: false, error: { code: err.code, message: err.message }, machine });
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
