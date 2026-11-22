import type {
  ClientFrame,
  HealthResponse,
  RpcMethod,
  ServerFrame,
  SessionResponse,
  SessionSnapshot,
} from "../../shared/protocol.ts";

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new ApiError("http", `health ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export async function fetchSession(): Promise<SessionSnapshot> {
  const res = await fetch("/api/session");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(body?.error?.code ?? "http", body?.error?.message ?? `session ${res.status}`);
  }
  return ((await res.json()) as SessionResponse).snapshot;
}

export type SnapshotListener = (snapshot: SessionSnapshot) => void;
export type StatusListener = (state: "connecting" | "open" | "closed") => void;
export type TerminalDataListener = (paneId: string, dataBase64: string) => void;
export type TerminalClosedListener = (paneId: string, reason: string | undefined) => void;

let ws: WebSocket | null = null;
let wsListeners = new Set<SnapshotListener>();
let statusListeners = new Set<StatusListener>();
let terminalDataListeners = new Set<TerminalDataListener>();
let terminalClosedListeners = new Set<TerminalClosedListener>();
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
    case "snapshot":
      for (const listener of wsListeners) listener(frame.snapshot);
      return;
    case "rpc_result": {
      const waiter = rpcWaiters.get(frame.id);
      if (!waiter) return;
      rpcWaiters.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.result);
      else waiter.reject(new ApiError(frame.error?.code ?? "rpc", frame.error?.message ?? "rpc failed"));
      return;
    }
    case "terminal_data":
      for (const listener of terminalDataListeners) listener(frame.paneId, frame.data);
      return;
    case "terminal_closed":
      for (const listener of terminalClosedListeners) listener(frame.paneId, frame.reason);
      return;
  }
}

function connect(): void {
  if (closed) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  notifyStatus("connecting");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws`);
  ws = socket;
  socket.onopen = () => notifyStatus("open");
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

function sendFrame(frame: ClientFrame): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export function subscribeTerminal(paneId: string, cols: number, rows: number): void {
  sendFrame({ type: "subscribe_terminal", paneId, cols, rows });
}

export function unsubscribeTerminal(paneId: string): void {
  sendFrame({ type: "unsubscribe_terminal", paneId });
}

export function terminalInput(paneId: string, data: string): void {
  sendFrame({ type: "terminal_input", paneId, data });
}

export function terminalResize(paneId: string, cols: number, rows: number): void {
  sendFrame({ type: "terminal_resize", paneId, cols, rows });
}

/** Call a whitelisted herdr RPC through the bridge. */
export function rpc<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new ApiError("disconnected", "bridge not connected"));
      return;
    }
    const id = `c${++rpcCounter}`;
    rpcWaiters.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const frame: ClientFrame = { type: "rpc", id, method, params };
    ws.send(JSON.stringify(frame));
  });
}
