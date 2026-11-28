import type {
  ClientFrame,
  HealthResponse,
  MachineInfo,
  PluginCallResult,
  PluginListResult,
  RpcMethod,
  ServerFrame,
  SessionResponse,
  SessionSnapshot,
} from "../../shared/protocol.ts";
import { isReadOnlyRpcMethod } from "../../shared/protocol.ts";

export class ApiError extends Error {
  readonly code: string;
  /**
   * Bounded structured extras from a plugin contract error (issue #257):
   * the plugin's own non-secret `error.*` siblings, already capped
   * server-side. Undefined for non-plugin or older-server failures.
   */
  readonly fields?: Record<string, unknown>;
  constructor(code: string, message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (fields !== undefined) this.fields = fields;
  }
}

/** Endpoint id used when a frame carries no `machine` tag. */
export const LOCAL_MACHINE = "local";

export async function fetchHealth(): Promise<HealthResponse> {
  const ipc = desktopBridge();
  if (ipc) return (await ipc.health()) as HealthResponse;
  const res = await fetch("/api/health");
  if (!res.ok) throw new ApiError("http", `health ${res.status}`);
  return (await res.json()) as HealthResponse;
}

/** Bridge performance counters (issue #425); shape is server-owned JSON. */
export async function fetchMetrics(): Promise<unknown> {
  const ipc = desktopBridge();
  if (ipc?.metrics) return ipc.metrics();
  const res = await fetch("/api/metrics");
  if (!res.ok) throw new ApiError("http", `metrics ${res.status}`);
  return res.json();
}

/**
 * In the desktop app the preload bridge (`window.herdrT3`) carries the same
 * ClientFrame/ServerFrame contract over IPC; the WebSocket path is the dev
 * browser fallback.
 */
interface DesktopBridge {
  sendFrame(frame: ClientFrame): void;
  onFrame(listener: (frame: ServerFrame) => void): () => void;
  health(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  metrics?(): Promise<unknown>;
  loginItem?(): Promise<unknown>;
  setLoginItem?(openAtLogin: boolean): Promise<unknown>;
  onMemoryPressure?(listener: (push: MemoryPressurePush) => void): () => void;
}

/** Main-process memory watchdog push (issue #499). */
export interface MemoryPressurePush {
  level: "ok" | "warn" | "critical" | "breach";
  totalMb?: number;
  baselineMb?: number;
}

function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { herdrT3?: DesktopBridge }).herdrT3;
  return candidate ?? null;
}

/** Resolve with the next full-detail snapshot pushed for `machine` (30s ceiling). */
function waitForPushedSnapshot(machine: string): Promise<SessionSnapshot> {
  return new Promise<SessionSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new ApiError("timeout", `no snapshot for machine ${machine}`));
    }, 30_000);
    const off = onSnapshot((snapshot, m, probe, detail) => {
      // Probe pushes are list data and summary pushes (issue #585) are
      // stripped — neither satisfies a caller that asked for a live,
      // full-detail session.
      if (m !== machine || probe || detail === "summary") return;
      clearTimeout(timer);
      off();
      resolve(snapshot);
    });
  });
}

export async function fetchSession(machine: string = LOCAL_MACHINE): Promise<SessionSnapshot> {
  const ipc = desktopBridge();
  // /api/session only knows the local endpoint; remote machines (and the
  // desktop app, which has no REST) must wait for the pushed snapshot so a
  // remote id can never be filled with local data.
  if (!ipc && machine === LOCAL_MACHINE) {
    const res = await fetch("/api/session");
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(body?.error?.code ?? "http", body?.error?.message ?? `session ${res.status}`);
    }
    return ((await res.json()) as SessionResponse).snapshot;
  }
  if (ipc && machine === LOCAL_MACHINE) {
    // No REST endpoint in the desktop app: ask the main process for the
    // snapshot its bridge session already holds (covers renderer reloads).
    const res = (await ipc.snapshot()) as {
      ok?: boolean;
      snapshot?: SessionSnapshot;
      error?: { code?: string; message?: string };
    } | null;
    if (res?.ok && res.snapshot) return res.snapshot;
    if (res && res.ok === false) {
      throw new ApiError(res.error?.code ?? "herdr", res.error?.message ?? "herdr unreachable");
    }
    // Fall back to the next pushed frame if the reply was malformed.
    return waitForPushedSnapshot(LOCAL_MACHINE);
  }
  return waitForPushedSnapshot(machine);
}

export type SnapshotListener = (
  snapshot: SessionSnapshot,
  machine: string,
  probe?: boolean,
  /** `"summary"` when the session pushed a stripped snapshot (issue #585). */
  detail?: "summary",
) => void;
export type StatusListener = (state: "connecting" | "open" | "closed") => void;
export type TerminalDataListener = (machine: string, paneId: string, dataBase64: string) => void;
export type TerminalClosedListener = (machine: string, paneId: string, reason: string | undefined) => void;
export type TerminalMouseCaptureListener = (machine: string, paneId: string, enabled: boolean) => void;
export type MachinesListener = (machines: MachineInfo[]) => void;
export type MachineStatusListener = (machine: MachineInfo) => void;
/** Raw herdr `events.subscribe` frame (`{event, data}`), already machine-tagged by the bridge. */
export type HerdrEventListener = (event: { event?: string; data?: Record<string, unknown> }, machine: string) => void;

let ws: WebSocket | null = null;
let ipcOff: (() => void) | null = null;
let wsListeners = new Set<SnapshotListener>();
let statusListeners = new Set<StatusListener>();
let terminalDataListeners = new Set<TerminalDataListener>();
let terminalClosedListeners = new Set<TerminalClosedListener>();
let terminalMouseCaptureListeners = new Set<TerminalMouseCaptureListener>();
let machinesListeners = new Set<MachinesListener>();
let machineStatusListeners = new Set<MachineStatusListener>();
let herdrEventListeners = new Set<HerdrEventListener>();
let rpcWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let rpcCounter = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closed = false;

function notifyStatus(state: "connecting" | "open" | "closed"): void {
  for (const listener of statusListeners) listener(state);
}

function handleFrame(frame: ServerFrame): void {
  switch (frame.type) {
    case "ready":
    case "snapshot": {
      const machine = frame.machine ?? LOCAL_MACHINE;
      // A pushed local snapshot proves the local bridge reached herdr again.
      if (desktopBridge() && machine === LOCAL_MACHINE) notifyStatus("open");
      // Probe snapshots (issue #212) are display data for machines without a
      // live session; fetchSession callers waiting for a real session must
      // not resolve on them.
      const probe = frame.type === "snapshot" && frame.probe === true;
      const detail = frame.detail === "summary" ? ("summary" as const) : undefined;
      for (const listener of wsListeners) listener(frame.snapshot, machine, probe || undefined, detail);
      return;
    }
    case "rpc_result": {
      const waiter = rpcWaiters.get(frame.id);
      if (!waiter) return;
      rpcWaiters.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.result);
      else
        waiter.reject(
          new ApiError(
            frame.error?.code ?? "rpc",
            frame.error?.message ?? "rpc failed",
            frame.error?.fields,
          ),
        );
      return;
    }
    case "terminal_data":
      for (const listener of terminalDataListeners) listener(frame.machine, frame.paneId, frame.data);
      return;
    case "terminal_closed":
      for (const listener of terminalClosedListeners) listener(frame.machine, frame.paneId, frame.reason);
      return;
    case "terminal_mouse_capture":
      for (const listener of terminalMouseCaptureListeners) listener(frame.machine, frame.paneId, frame.enabled);
      return;
    case "machines":
      for (const listener of machinesListeners) listener(frame.machines);
      return;
    case "machine_status":
      for (const listener of machineStatusListeners) listener(frame.machine);
      return;
    case "event":
      if (frame.event !== null && typeof frame.event === "object" && !Array.isArray(frame.event)) {
        for (const listener of herdrEventListeners) {
          listener(frame.event as { event?: string; data?: Record<string, unknown> }, frame.machine);
        }
      }
      return;
  }
}

function connect(): void {
  if (closed) return;
  const ipc = desktopBridge();
  if (ipc) {
    // Desktop: the main process owns the sessions; IPC is always "connected".
    // herdr reachability is reported separately through health/machines.
    notifyStatus("open");
    ipcOff = ipc.onFrame(handleFrame) ?? null;
    void ipc
      .health()
      .then((h) => {
        const reachable = (h as { herdr?: { reachable?: boolean } } | null)?.herdr?.reachable;
        if (reachable === false) notifyStatus("closed");
      })
      .catch(() => {});
    sendFrame({ type: "list_machines" });
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  notifyStatus("connecting");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    notifyStatus("open");
    socket.send(JSON.stringify({ type: "list_machines" }));
  };
  socket.onmessage = (msg) => {
    try {
      handleFrame(JSON.parse(String(msg.data)) as ServerFrame);
    } catch {
      /* malformed frame */
    }
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    notifyStatus("closed");
    for (const waiter of rpcWaiters.values()) waiter.reject(new ApiError("disconnected", "bridge connection closed"));
    rpcWaiters.clear();
    if (!closed) {
      reconnectTimer = setTimeout(connect, 1500);
    }
  };
  socket.onerror = () => socket.close();
}

export function connectBridge(): () => void {
  closed = false;
  connect();
  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
    ipcOff?.();
    ipcOff = null;
  };
}

export function onSnapshot(listener: SnapshotListener): () => void {
  wsListeners.add(listener);
  return () => wsListeners.delete(listener);
}

export function onStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function onTerminalData(listener: TerminalDataListener): () => void {
  terminalDataListeners.add(listener);
  return () => terminalDataListeners.delete(listener);
}

export function onTerminalClosed(listener: TerminalClosedListener): () => void {
  terminalClosedListeners.add(listener);
  return () => terminalClosedListeners.delete(listener);
}

export function onTerminalMouseCapture(listener: TerminalMouseCaptureListener): () => void {
  terminalMouseCaptureListeners.add(listener);
  return () => terminalMouseCaptureListeners.delete(listener);
}

export function onMachines(listener: MachinesListener): () => void {
  machinesListeners.add(listener);
  return () => machinesListeners.delete(listener);
}

export function onMachineStatus(listener: MachineStatusListener): () => void {
  machineStatusListeners.add(listener);
  return () => machineStatusListeners.delete(listener);
}

/** Main-process memory watchdog pushes (issue #499); no-op on the WS dev path. */
export function onMemoryPressure(listener: (push: MemoryPressurePush) => void): () => void {
  const ipc = desktopBridge();
  if (!ipc?.onMemoryPressure) return () => {};
  return ipc.onMemoryPressure(listener);
}

/** Subscribed herdr events (`pane.scroll_changed`, structure changes, …) the bridge forwards. */
export function onHerdrEvent(listener: HerdrEventListener): () => void {
  herdrEventListeners.add(listener);
  return () => herdrEventListeners.delete(listener);
}

function sendFrame(frame: ClientFrame): void {
  const ipc = desktopBridge();
  if (ipc) {
    ipc.sendFrame(frame);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export function subscribeTerminal(
  machine: string,
  paneId: string,
  cols: number,
  rows: number,
  takeover = false,
  writable = true,
): void {
  sendFrame({ type: "subscribe_terminal", machine, paneId, cols, rows, takeover, writable });
}

export function unsubscribeTerminal(machine: string, paneId: string): void {
  sendFrame({ type: "unsubscribe_terminal", machine, paneId });
}

/** `data` is base64 bytes: encoded input and terminal replies are arbitrary bytes, not necessarily UTF-8. */
export function terminalInput(machine: string, paneId: string, data: Uint8Array): void {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  sendFrame({ type: "terminal_input", machine, paneId, data: btoa(binary) });
}

export function terminalResize(machine: string, paneId: string, cols: number, rows: number): void {
  sendFrame({ type: "terminal_resize", machine, paneId, cols, rows });
}

/** Structured pointer event; the bridge forwards it as herdr AttachMouse (SGR reports only when the pane enabled mouse mode). */
export function terminalMouse(
  machine: string,
  paneId: string,
  event: {
    action: "press" | "motion" | "release" | "moved";
    button?: "left" | "middle" | "right" | null;
    column: number;
    row: number;
    modifiers?: number;
  },
): void {
  sendFrame({ type: "terminal_mouse", machine, paneId, ...event });
}

/** Wheel scroll; the bridge forwards it as herdr AttachScroll which arbitrates mouse-report vs scrollback server-side. */
export function terminalScroll(
  machine: string,
  paneId: string,
  event: { direction: "up" | "down"; lines?: number; column?: number; row?: number; modifiers?: number },
): void {
  sendFrame({ type: "terminal_scroll", machine, paneId, ...event });
}

/*
 * Single-flight for identical concurrent read-only RPCs (issue #527).
 * Every mounted pane issues `session.snapshot` on attach to seed its
 * scroll offset, so a workspace switch with K panes used to fan out into
 * K identical large-reply herdr RPCs. Concurrent identical read-only
 * calls now share one bridge round-trip; entries are removed on settle —
 * nothing is cached, so sequential calls still fetch fresh data.
 */
const readRpcInflight = new Map<string, Promise<unknown>>();

function readRpcKey(method: RpcMethod, params: Record<string, unknown>, machine: string): string {
  return `${machine} ${method} ${JSON.stringify(params)}`;
}

/** Call a whitelisted herdr RPC through the bridge, on the given machine. */
export function rpc<T = unknown>(
  method: RpcMethod,
  params: Record<string, unknown> = {},
  machine: string = LOCAL_MACHINE,
): Promise<T> {
  if (isReadOnlyRpcMethod(method)) {
    const key = readRpcKey(method, params, machine);
    const existing = readRpcInflight.get(key);
    if (existing) return existing as Promise<T>;
    const pending = rpcOnce<T>(method, params, machine);
    readRpcInflight.set(key, pending);
    const cleanup = () => readRpcInflight.delete(key);
    pending.then(cleanup, cleanup);
    return pending;
  }
  return rpcOnce(method, params, machine);
}

function rpcOnce<T = unknown>(
  method: RpcMethod,
  params: Record<string, unknown> = {},
  machine: string = LOCAL_MACHINE,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ipc = desktopBridge();
    if (!ipc && (!ws || ws.readyState !== WebSocket.OPEN)) {
      reject(new ApiError("disconnected", "bridge not connected"));
      return;
    }
    const id = `c${++rpcCounter}`;
    rpcWaiters.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const frame: ClientFrame = { type: "rpc", id, method, params, machine };
    if (ipc) ipc.sendFrame(frame);
    else ws?.send(JSON.stringify(frame));
  });
}

export function machineConnect(machine: string): void {
  sendFrame({ type: "machine_connect", machine });
}

export function machineDisconnect(machine: string): void {
  sendFrame({ type: "machine_disconnect", machine });
}

/**
 * Declare the machine whose session detail the client is viewing
 * (issue #585): it upgrades to full detail (layouts, scroll state,
 * terminal attach) while every other connected machine drops to summary
 * mode. Sent on workspace-route changes; idempotent server-side.
 */
export function machineSelect(machine: string): void {
  sendFrame({ type: "machine_select", machine });
}

/** Machine-registry mutations correlate through the same rpc_result channel. */
function machineCommand(frame: ClientFrame): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ipc = desktopBridge();
    if (!ipc && (!ws || ws.readyState !== WebSocket.OPEN)) {
      reject(new ApiError("disconnected", "bridge not connected"));
      return;
    }
    const id = `m${++rpcCounter}`;
    rpcWaiters.set(id, { resolve, reject });
    // machine_* frames carry their own correlation id.
    (frame as { id: string }).id = id;
    if (ipc) ipc.sendFrame(frame);
    else ws?.send(JSON.stringify(frame));
  });
}

export function machineAdd(input: { label: string; target: string; session?: string | undefined }): Promise<unknown> {
  return machineCommand({
    type: "machine_add",
    id: "",
    label: input.label,
    target: input.target,
    ...(input.session !== undefined ? { session: input.session } : {}),
  });
}

export function machineRemove(machine: string): Promise<unknown> {
  return machineCommand({ type: "machine_remove", id: "", machine });
}

export function machineUpdate(
  machine: string,
  update: { label?: string; enabled?: boolean },
): Promise<unknown> {
  return machineCommand({ type: "machine_update", id: "", machine, ...update });
}

/* ------------------------- plugin contract calls ---------------------- */

/**
 * Single-flight for plugin discovery (issue #424): `plugin_list` is a pure
 * read, so identical concurrent calls share one bridge round-trip. Entries
 * are removed on settle — nothing is cached. `plugin_call` coalescing is
 * contract-driven server-side (`capability.mutation_commands`), not here.
 */
const pluginListInflight = new Map<string, Promise<PluginListResult>>();

/** Installed-plugin discovery on one host (ADR-0011); always read-only. */
export function pluginList(machine: string): Promise<PluginListResult> {
  const existing = pluginListInflight.get(machine);
  if (existing) return existing;
  const pending = machineCommand({ type: "plugin_list", id: "", machine }) as Promise<PluginListResult>;
  pluginListInflight.set(machine, pending);
  const cleanup = () => pluginListInflight.delete(machine);
  pending.then(cleanup, cleanup);
  return pending;
}

/** One plugin contract command on one host; result is the plugin's JSON document. */
export function pluginCall(
  machine: string,
  request: { plugin: string; command: string; args?: string[]; timeout_ms?: number },
): Promise<PluginCallResult> {
  return machineCommand({
    type: "plugin_call",
    id: "",
    machine,
    plugin: request.plugin,
    command: request.command,
    ...(request.args !== undefined ? { args: request.args } : {}),
    ...(request.timeout_ms !== undefined ? { timeout_ms: request.timeout_ms } : {}),
  }) as Promise<PluginCallResult>;
}

/** Launch-at-login state; only the desktop preload exposes these. */
export interface LoginItemState {
  supported: boolean;
  openAtLogin: boolean;
}

export function getLoginItem(): Promise<LoginItemState | null> {
  const ipc = desktopBridge();
  return (ipc?.loginItem ? ipc.loginItem() : Promise.resolve(null)) as Promise<LoginItemState | null>;
}

export function setLoginItem(openAtLogin: boolean): Promise<LoginItemState | null> {
  const ipc = desktopBridge();
  return (ipc?.setLoginItem ? ipc.setLoginItem(openAtLogin) : Promise.resolve(null)) as Promise<
    LoginItemState | null
  >;
}
