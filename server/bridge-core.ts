/**
 * Transport-agnostic bridge session: herdr snapshot/event fan-out, whitelisted
 * RPC dispatch and per-pane terminal attach slots. Consumed by the dev
 * WebSocket server (server/index.ts) and the Electron Main process
 * (desktop/main.ts) over the same ClientFrame/ServerFrame contract.
 */
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { isReadOnlyRpcMethod, isRpcMethod } from "../shared/protocol.ts";
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
import { metricInc } from "./metrics.ts";
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
 * Coalescing window for scroll-subscription set changes (issue #527).
 * Attaches/detaches arrive as a burst during workspace switches (one
 * subscribe_terminal frame per visible pane); reopening once per frame
 * would tear down and recreate the whole events.subscribe connection —
 * every structure/status/scroll filter included — for each pane. Changes
 * are coalesced into a single trailing reopen instead. `pane.scroll_changed`
 * is advisory viewport traffic: the authoritative scroll state also
 * arrives via snapshot pushes and the `pane.scroll` RPC, so a sub-second
 * gap in the subscription cannot lose user data.
 */
const SCROLL_SYNC_DEBOUNCE_MS = 120;

function scrollSetsEqual(state: SessionState): boolean {
  if (state.terminals.size !== state.scrollSubscribed.size) return false;
  for (const id of state.terminals.keys()) {
    if (!state.scrollSubscribed.has(id)) return false;
  }
  return true;
}

/**
 * Reopen the event subscription when the attached-pane set changed since
 * the last open — herdr ignores a second subscribe on a live connection,
 * so the full set (structure + status + scroll) goes out together.
 */
function syncScrollSubscriptions(state: SessionState): void {
  if (!state.snapshot || !state.subscription) return;
  if (scrollSetsEqual(state)) return;
  if (state.scrollSyncTimer !== null) return;
  state.scrollSyncTimer = setTimeout(() => {
    state.scrollSyncTimer = null;
    // Re-check at fire time: the set may have reverted, or a reconcile
    // reopen may already carry the desired subscriptions.
    if (!state.snapshot || !state.subscription || scrollSetsEqual(state)) return;
    state.subscription.close();
    state.subscription = openSubscription(state, state.snapshot);
  }, SCROLL_SYNC_DEBOUNCE_MS);
}

export async function fetchSnapshot(endpoint?: BridgeEndpoint): Promise<SessionSnapshot> {
  const result = await herdrRpc<{ snapshot: SessionSnapshot }>(
    "session.snapshot",
    {},
    endpoint ? { connect: endpoint.api, timeoutMs: 20000 } : {},
  );
  return result.snapshot;
}

/**
 * Bounds on ops queued while a terminal attach resolves (issue #499). The
 * queue normally drains in milliseconds; if the attach hangs (socket stall,
 * handshake never answered) every keystroke/mouse/scroll frame would
 * otherwise pile up closures — and for input, the decoded Buffer — for the
 * life of the slot. Past the cap the attach is failed safe instead.
 */
const SLOT_QUEUE_MAX_OPS = 512;
const SLOT_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

interface TerminalSlot {
  refs: number;
  link: TerminalLink | null;
  /** Operations queued until the attach resolves. */
  queue: (() => void)[];
  /** Payload bytes currently held by `queue` (input buffers dominate). */
  queueBytes: number;
  gone: boolean;
  /**
   * Desired attach mode (issue #571): true = writable AttachTerminal
   * (resize authority + input), false = read-only ObserveTerminal. Set at
   * subscribe time and updated by a mode-negotiation subscribe; input,
   * mouse and scroll frames are dropped while false — the server would
   * ignore them anyway — while terminal_resize still flows because an
   * observe client renders into the size it announces.
   */
  writable: boolean;
  /** Bumped on every (re)attach; a late-resolving link from an older epoch is closed, not installed. */
  epoch: number;
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
  /** Pending coalesced scroll-subscription reopen (issue #527). */
  scrollSyncTimer: ReturnType<typeof setTimeout> | null;
  /** True while a pushSnapshot fetch is in flight; a queued refetch runs after it. */
  fetchingSnapshot: boolean;
  /** Set when scheduleSnapshot fires while a fetch is in flight. */
  snapshotQueued: boolean;
  snapshot: SessionSnapshot | null;
  /** JSON of the last snapshot actually sent to this client (issue #423 dedup). */
  lastPushedSnapshotJson: string | null;
  terminals: Map<string, TerminalSlot>;
}

/**
 * Deliver a fetched snapshot to this client, suppressing pushes whose
 * content is identical to the last one sent (issue #423). `state.snapshot`
 * always tracks the freshest fetch regardless.
 */
function deliverSnapshot(state: SessionState, snapshot: SessionSnapshot): void {
  state.snapshot = snapshot;
  const json = JSON.stringify(snapshot);
  if (json === state.lastPushedSnapshotJson) {
    metricInc("bridge.snapshot.push.unchanged");
    return;
  }
  state.lastPushedSnapshotJson = json;
  metricInc("bridge.snapshot.push");
  state.send({ type: "snapshot", snapshot, machine: state.machine });
}

function pushSnapshot(state: SessionState): void {
  // Single-flight: events arriving mid-fetch queue one trailing refetch
  // instead of overlapping session.snapshot calls (issue #423).
  if (state.fetchingSnapshot) {
    state.snapshotQueued = true;
    return;
  }
  state.fetchingSnapshot = true;
  void fetchSnapshot(state.endpoint)
    .then((snapshot) => {
      deliverSnapshot(state, snapshot);
      reconcileSubscriptions(state, snapshot);
    })
    .catch((error: unknown) => {
      /* herdr unreachable; surface it so diagnostics and the client can tell
         "offline" apart from "empty session". Renderers ignore unknown ids. */
      metricInc("bridge.snapshot.push.error");
      const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
      state.send({
        type: "rpc_result",
        id: "bridge-health",
        ok: false,
        error: { code: err.code, message: err.message },
        machine: state.machine,
      });
    })
    .finally(() => {
      state.fetchingSnapshot = false;
      if (state.snapshotQueued) {
        state.snapshotQueued = false;
        scheduleSnapshot(state, "queued");
      }
    });
}

function reconcileSubscriptions(state: SessionState, snapshot: SessionSnapshot): void {
  const ids = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const same =
    state.subscribedPaneIds.size === ids.size && [...ids].every((id) => state.subscribedPaneIds.has(id));
  // A missing subscription must reopen even when the pane set is empty or
  // unchanged — e.g. drop recovery on an empty session, where `same` would
  // otherwise leave the session without any event stream (issue #527).
  if (same && state.subscription) return;
  // A second subscribe on a live connection is ignored: reopen with the full set.
  state.subscription?.close();
  state.subscription = openSubscription(state, snapshot);
}

function openSubscription(state: SessionState, snapshot: SessionSnapshot): Subscription {
  state.subscribedPaneIds = new Set(snapshot.panes.map((pane) => pane.pane_id));
  metricInc("bridge.subscription.open");
  state.scrollSubscribed = new Set(state.terminals.keys());
  // `sub` is assigned synchronously by subscribeEvents; handlers only run
  // later, so the identity check below is always settled by then.
  let sub: Subscription;
  sub = subscribeEvents(
    [
      ...STRUCTURE_SUBSCRIPTIONS,
      ...statusSubscriptions(snapshot),
      ...scrollSubscriptions(state),
    ],
    {
      onEvent: (frame: EventFrame) => {
        state.send({ type: "event", event: frame, machine: state.machine });
        // pane.scroll_changed is high-frequency viewport traffic and cannot
        // alter session structure: clients consume it from the forwarded
        // event frame itself (PaneTerminal re-projects selection). Refetching
        // session.snapshot for it turned every scroll burst into a full
        // snapshot fetch — and, because pane.scroll is part of the snapshot,
        // a full snapshot push to every client (issues #416/#527).
        if (frame.event === "pane.scroll_changed") {
          metricInc("bridge.snapshot.schedule.skip", { reason: "scroll_event" });
        } else {
          scheduleSnapshot(state, "event");
        }
      },
      onError: () => {
        // A replaced subscription's late socket error must not schedule
        // work for the live one (issue #527).
        if (state.subscription !== sub) return;
        scheduleSnapshot(state, "subscription_error");
      },
      onClose: () => {
        // Same guard: only the live subscription may trigger recovery.
        // Without it a stale drop nulls state.subscription while a healthy
        // replacement streams on, and the reopen timer leaks connections.
        if (state.subscription !== sub) return;
        state.subscription = null;
        state.subscribedPaneIds = new Set();
        metricInc("bridge.subscription.close");
        scheduleSnapshot(state, "subscription_close");
        // Retry the subscription itself; the snapshot push above already ran once.
        state.pushTimer = setTimeout(() => {
          state.pushTimer = null;
          // The debounced snapshot push restores the subscription via
          // reconcileSubscriptions whenever its fetch succeeds. Only when
          // it did not (herdr unreachable) is a second fetch+reopen needed —
          // reopening unconditionally here used to install a second live
          // subscription on top of the recovered one, leaking its socket
          // and doubling every forwarded event (issue #527).
          if (state.subscription) return;
          metricInc("bridge.subscription.reopen");
          void fetchSnapshot(state.endpoint)
            .then((snapshot) => {
              deliverSnapshot(state, snapshot);
              reconcileSubscriptions(state, snapshot);
            })
            .catch(() => {});
        }, 2000);
      },
    },
    state.endpoint.api,
  );
  return sub;
}

function scheduleSnapshot(state: SessionState, cause: string): void {
  metricInc("bridge.snapshot.schedule", { cause });
  if (state.snapshotTimer !== null) return;
  state.snapshotTimer = setTimeout(() => {
    state.snapshotTimer = null;
    pushSnapshot(state);
  }, 120);
}

function dropTerminal(state: SessionState, paneId: string, slot: TerminalSlot, reason: string): void {
  if (slot.gone) return;
  slot.gone = true;
  metricInc("bridge.terminal.detach");
  if (state.terminals.get(paneId) === slot) state.terminals.delete(paneId);
  state.send({ type: "terminal_closed", paneId, reason, machine: state.machine });
}

/**
 * Resolve the pane's terminal id (refreshing the snapshot once for panes
 * newer than the last fetch) and open the attach link for `slot`.
 */
function attachSlot(
  state: SessionState,
  slot: TerminalSlot,
  paneId: string,
  cols: number,
  rows: number,
  takeover: boolean,
): void {
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
    return;
  }
  attachTerminal(state, slot, paneId, terminalId, cols, rows, takeover);
}

function ensureTerminal(
  state: SessionState,
  paneId: string,
  cols: number,
  rows: number,
  takeover: boolean,
  writable: boolean,
): TerminalSlot {
  const existing = state.terminals.get(paneId);
  if (existing) {
    if (existing.writable !== writable) {
      // Mode negotiation (issue #571): herdr accepts the attach-mode message
      // only while the client is TerminalPending, so a mode change is a new
      // connection — but the slot, its refcount and its op queue survive, so
      // input typed during the switch still flushes to the new link in
      // order. This subscribe does not take a reference: the client pairs
      // it with the single unsubscribe it already sends.
      existing.writable = writable;
      // Supersede the old link before closing it: its detach/close
      // callbacks must already read as stale (issue #571).
      existing.epoch += 1;
      existing.link?.close();
      existing.link = null;
      attachSlot(state, existing, paneId, cols, rows, takeover);
      return existing;
    }
    existing.refs += 1;
    return existing;
  }
  const slot: TerminalSlot = { refs: 1, link: null, queue: [], queueBytes: 0, gone: false, writable, epoch: 0 };
  state.terminals.set(paneId, slot);
  syncScrollSubscriptions(state);
  attachSlot(state, slot, paneId, cols, rows, takeover);
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
  // the client explicitly asked for it after an attach refusal. `writable`
  // false opens a read-only ObserveTerminal stream instead (issue #571).
  // Each attach attempt gets its own epoch: a mode switch or a second
  // in-flight attempt (snapshot-retry path) supersedes every earlier one,
  // so only the newest resolved link is ever installed (issue #571).
  slot.epoch += 1;
  const epoch = slot.epoch;
  // Counted per link-open attempt (issue #572): a #571 mode switch closes
  // the old link and re-enters here, so it counts as a second attach while
  // the slot — and therefore bridge.terminal.detach — stays single. Pair
  // with terminal.link.open/close for the socket-level view.
  metricInc("bridge.terminal.attach");
  openTerminalLink(terminalId, { cols, rows, connect: state.endpoint.client, takeover, writable: slot.writable }, {
    onEvent: (event) => {
      // A superseded link (mode switch, newer attach attempt) must not feed
      // the client or tear the slot down (issue #571).
      if (slot.gone || slot.epoch !== epoch) return;
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
      if (slot.gone || slot.epoch !== epoch) return;
      dropTerminal(state, paneId, slot, reason);
    },
  }).then((link) => {
    // A mode switch or slot teardown while this attach was in flight makes
    // the resolved link stale: close it instead of installing it over the
    // newer link (issue #571).
    if (slot.gone || slot.epoch !== epoch) {
      link.close();
      return;
    }
    slot.link = link;
    for (const op of slot.queue.splice(0)) op();
    slot.queueBytes = 0;
  }).catch((error: unknown) => {
    // Same staleness rule as the resolve path: a superseded attach's failure
    // must not tear down the slot's newer link.
    if (slot.gone || slot.epoch !== epoch) return;
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
  metricInc("bridge.terminal.detach");
  slot.link?.close();
  syncScrollSubscriptions(state);
}

/**
 * Queue one op until the attach resolves, bounded by count and payload
 * bytes; overflow fails the attach so a stalled link cannot grow memory
 * without limit (issue #499).
 */
function enqueueSlotOp(
  state: SessionState,
  slot: TerminalSlot,
  paneId: string,
  bytes: number,
  op: () => void,
): void {
  if (slot.gone) return;
  if (slot.queue.length >= SLOT_QUEUE_MAX_OPS || slot.queueBytes + bytes > SLOT_QUEUE_MAX_BYTES) {
    dropTerminal(state, paneId, slot, "attach_overrun");
    return;
  }
  slot.queue.push(op);
  slot.queueBytes += bytes;
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
          // Read-only RPCs cannot change the snapshot; refreshing after them
          // amplified read traffic into session.snapshot fetches (#423).
          if (!isReadOnlyRpcMethod(frame.method)) scheduleSnapshot(state, "rpc");
        })
        .catch((error: unknown) => {
          const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
          state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: err.code, message: err.message }, machine: state.machine });
        });
      return;
    }
    case "subscribe_terminal":
      // The client follows with terminal_resize once its grid is measured;
      // input/resize frames queue until the attach resolves. `writable`
      // false requests the read-only ObserveTerminal stream (issue #571);
      // absent means writable, the pre-#571 behavior.
      ensureTerminal(state, frame.paneId, frame.cols ?? 80, frame.rows ?? 24, frame.takeover === true, frame.writable !== false);
      return;
    case "unsubscribe_terminal":
      releaseTerminal(state, frame.paneId);
      return;
    case "terminal_input": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      // Counted at slot receipt (issue #572): observe-mode input is
      // received-then-dropped by the #571 gate below, so op counts include
      // deliberately dropped frames — compare with client.frame to see them.
      metricInc("bridge.terminal.op", { op: "input" });
      // Observe-mode links cannot carry input (herdr routes ClientInput only
      // for TerminalAttach); drop it here instead of shipping bytes the
      // server silently ignores (issue #571).
      if (!slot.writable) return;
      const bytes = Buffer.from(frame.data, "base64");
      const write = () => slot.link?.write(bytes);
      if (slot.link) write();
      else enqueueSlotOp(state, slot, frame.paneId, bytes.length, write);
      return;
    }
    case "terminal_resize": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      metricInc("bridge.terminal.op", { op: "resize" });
      const resize = () => slot.link?.resize(frame.cols, frame.rows);
      if (slot.link) resize();
      else enqueueSlotOp(state, slot, frame.paneId, 0, resize);
      return;
    }
    case "terminal_mouse": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      metricInc("bridge.terminal.op", { op: "mouse" });
      if (!slot.writable) return;
      const mouse = () =>
        slot.link?.mouse({
          action: frame.action,
          button: frame.button ?? null,
          column: frame.column,
          row: frame.row,
          modifiers: frame.modifiers ?? 0,
        });
      if (slot.link) mouse();
      else enqueueSlotOp(state, slot, frame.paneId, 0, mouse);
      return;
    }
    case "terminal_scroll": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone) return;
      metricInc("bridge.terminal.op", { op: "scroll" });
      if (!slot.writable) return;
      const scroll = () =>
        slot.link?.scroll(frame.direction, frame.lines, frame.column, frame.row, frame.modifiers);
      if (slot.link) scroll();
      else enqueueSlotOp(state, slot, frame.paneId, 0, scroll);
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
    scrollSyncTimer: null,
    fetchingSnapshot: false,
    snapshotQueued: false,
    snapshot: null,
    lastPushedSnapshotJson: null,
    terminals: new Map(),
  };
  return {
    handleFrame: (frame) => handleClientFrame(state, frame),
    start: () =>
      fetchSnapshot(endpoint)
        .then((snapshot) => {
          state.snapshot = snapshot;
          // `ready` already carried this snapshot to the client; seed the
          // dedup key so an identical first refetch is not re-pushed (#423).
          state.lastPushedSnapshotJson = JSON.stringify(snapshot);
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
      if (state.scrollSyncTimer) clearTimeout(state.scrollSyncTimer);
      for (const [paneId, slot] of state.terminals) {
        slot.gone = true;
        slot.link?.close();
        state.terminals.delete(paneId);
      }
    },
  };
}
