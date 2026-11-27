import { describe, expect, test } from "bun:test";
import type { RpcMethod, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { createBridgeSession, type BridgeEndpoint } from "./bridge-core.ts";
import type { ByteStream, Connector, SocketHandlers } from "./socket.ts";

/*
 * Attach-queue contract tests (issue #356 follow-up).
 *
 * These pin the exact semantics of TerminalSlot.queue in bridge-core.ts:
 * operations received while a terminal attach is still resolving are held
 * and flushed, in order, when the attach link comes up — and are abandoned
 * (never delivered) when the attach fails or the session/slot dies first.
 *
 * The draft invariant (AGENTS.md §3) is about input surviving a
 * *disconnect*: nothing typed before or during a disconnect can reach this
 * queue, because client frames drop while the transport is down and every
 * disconnect path (WS close, machine disconnect, session rebuild, link
 * loss) destroys the slot the queue belongs to. What the queue can hold is
 * only input typed after the transport recovered, while the attach for the
 * current subscribe is still in flight — the same window as a first attach.
 *
 * The fakes below speak just enough of the two transports: the api
 * connector answers herdrRpc/subscribesEvents JSON-lines, and the client
 * connector completes (or stalls/fails) the bincode TerminalHello ->
 * Welcome handshake on demand.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeStream implements ByteStream {
  readonly chunks: Uint8Array[] = [];
  ended = false;
  write(data: string | Uint8Array): void {
    this.chunks.push(typeof data === "string" ? encoder.encode(data) : data);
  }
  end(): void {
    this.ended = true;
  }
  /** All bytes written so far, concatenated. */
  bytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
  text(): string {
    return decoder.decode(this.bytes());
  }
  contains(needle: string): boolean {
    return this.text().includes(needle);
  }
}

const SNAPSHOT: SessionSnapshot = {
  agents: [],
  layouts: [],
  panes: [
    {
      agent_status: "idle",
      focused: true,
      pane_id: "p1",
      revision: 1,
      tab_id: "t1",
      terminal_id: "term-1",
      workspace_id: "w1",
    },
  ],
  protocol: 22,
  tabs: [],
  version: "test",
  workspaces: [
    {
      active_tab_id: "t1",
      agent_status: "idle",
      focused: true,
      label: "w",
      number: 1,
      pane_count: 1,
      tab_count: 1,
      workspace_id: "w1",
    },
  ],
};

/* ------------------------------ api connector --------------------------- */

interface ApiConn {
  handlers: SocketHandlers;
  stream: FakeStream;
}

function apiConnector(conns: ApiConn[]): Connector {
  return (handlers) => {
    const conn: ApiConn = { handlers, stream: new FakeStream() };
    conns.push(conn);
    // herdrRpc / subscribeEvents write one JSON-lines request, then read
    // reply lines. Answer immediately on write.
    const rawWrite = conn.stream.write.bind(conn.stream);
    conn.stream.write = (data) => {
      rawWrite(data);
      const line = typeof data === "string" ? data : decoder.decode(data);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let request: { id?: string; method?: string };
      try {
        request = JSON.parse(trimmed);
      } catch {
        return;
      }
      const id = request.id ?? "";
      const result =
        request.method === "session.snapshot"
          ? { snapshot: SNAPSHOT }
          : request.method === "events.subscribe"
            ? { type: "subscription_started" }
            : {};
      handlers.data(encoder.encode(`${JSON.stringify({ id, result })}\n`));
    };
    return Promise.resolve(conn.stream);
  };
}

/* ---------------------------- client connector -------------------------- */

interface ClientConn {
  handlers: SocketHandlers;
  stream: FakeStream;
}

function clientConnector(conns: ClientConn[]): Connector {
  return (handlers) => {
    const conn: ClientConn = { handlers, stream: new FakeStream() };
    conns.push(conn);
    return Promise.resolve(conn.stream);
  };
}

const varint = (value: number): number[] =>
  value <= 250 ? [value] : [251, value & 0xff, (value >> 8) & 0xff];

function serverFrame(payload: number[]): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

/** ServerMessage::Welcome { version, encoding: TerminalAnsi(1), error: None }. */
function welcomeFrame(): Uint8Array {
  return serverFrame([...varint(0), ...varint(22), ...varint(1), 0]);
}

/* --------------------------------- harness ------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makeSession() {
  const apiConns: ApiConn[] = [];
  const clientConns: ClientConn[] = [];
  const frames: ServerFrame[] = [];
  const endpoint: BridgeEndpoint = {
    api: apiConnector(apiConns),
    client: clientConnector(clientConns),
    label: "fake",
  };
  const session = createBridgeSession((frame) => frames.push(frame), endpoint, "m");
  return { session, apiConns, clientConns, frames };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("terminal attach queue (slot.queue)", () => {
  test("input received while the attach resolves is held, then flushed in order", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "client attach connection");
    const link = clientConns[0]!;
    // The TerminalHello write is the only byte on the wire so far.
    await waitFor(() => link.stream.chunks.length > 0, "terminal hello");

    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("FIRST") });
    session.handleFrame({ type: "terminal_resize", paneId: "p1", cols: 100, rows: 30 });
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("SECOND") });
    await sleep(20);

    // Nothing the client sent has reached the pty yet: the attach is still
    // waiting for herdr's Welcome.
    expect(link.stream.contains("FIRST")).toBe(false);
    expect(link.stream.contains("SECOND")).toBe(false);

    // Attach resolves -> the queue flushes in order. Frame payloads are
    // binary, so search the raw bytes as latin1.
    link.handlers.data(welcomeFrame());
    await waitFor(() => link.stream.contains("SECOND"), "queued input flush");

    const latin = Buffer.from(link.stream.bytes()).toString("latin1");
    expect(latin.indexOf("FIRST")).toBeGreaterThanOrEqual(0);
    expect(latin.indexOf("SECOND")).toBeGreaterThan(latin.indexOf("FIRST"));
    session.close();
  });

  test("input for a pane with no subscription is dropped, never queued", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("ORPHAN") });
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "client attach connection");
    const link = clientConns[0]!;
    link.handlers.data(welcomeFrame());
    await sleep(30);
    // The pre-subscription frame was dropped at receipt; only frames sent
    // during THIS attach attempt can flush.
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("LIVE") });
    await waitFor(() => link.stream.contains("LIVE"), "post-attach input");
    expect(link.stream.contains("ORPHAN")).toBe(false);
    session.close();
  });

  test("queued input is abandoned when the attach fails", async () => {
    const { session, clientConns, frames } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "client attach connection");
    const link = clientConns[0]!;
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("DOOMED") });
    await sleep(10);
    expect(link.stream.contains("DOOMED")).toBe(false);

    // herdr drops the socket during the handshake: the attach rejects and
    // the queued write must never be delivered.
    link.handlers.close?.();
    await waitFor(
      () => frames.some((f) => f.type === "terminal_closed" && f.paneId === "p1"),
      "terminal_closed",
    );
    await sleep(20);
    expect(link.stream.contains("DOOMED")).toBe(false);
    session.close();
  });

  test("queued input is abandoned when the session closes mid-attach", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "client attach connection");
    const link = clientConns[0]!;
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("GHOST") });
    await sleep(10);

    // Session teardown (WS close / machine disconnect / session rebuild):
    // the slot is gone, so a late Welcome resolves a link that is closed
    // immediately and the queue never runs.
    session.close();
    link.handlers.data(welcomeFrame());
    await sleep(30);
    expect(link.stream.contains("GHOST")).toBe(false);
  });
});

/* --------------------- snapshot push policy (issue #423) ------------------ */

interface PolicyApiConn extends ApiConn {
  requests: { id?: string; method?: string; params?: Record<string, unknown> }[];
}

/** True for bridge-internal session.snapshot fetches, not client RPCs. */
function isSnapshotFetch(r: { method?: string; params?: Record<string, unknown> }): boolean {
  return r.method === "session.snapshot" && r.params?.["client"] !== true;
}

/** api connector that counts requests and serves a queued snapshot list. */
function policyApiConnector(conns: PolicyApiConn[], snapshots: SessionSnapshot[]) {
  return (handlers: SocketHandlers) => {
    const conn: PolicyApiConn = { handlers, stream: new FakeStream(), requests: [] };
    conns.push(conn);
    const rawWrite = conn.stream.write.bind(conn.stream);
    conn.stream.write = (data) => {
      rawWrite(data);
      const line = typeof data === "string" ? data : decoder.decode(data);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let request: { id?: string; method?: string; params?: Record<string, unknown> };
      try {
        request = JSON.parse(trimmed);
      } catch {
        return;
      }
      const id = request.id ?? "";
      let result: unknown = {};
      if (request.method === "session.snapshot") {
        // Count prior internal snapshot fetches before recording this one.
        const calls = conns.reduce((n, c) => n + c.requests.filter(isSnapshotFetch).length, 0);
        conn.requests.push(request);
        result = { snapshot: snapshots[Math.min(calls, snapshots.length - 1)] };
      } else {
        conn.requests.push(request);
        if (request.method === "events.subscribe") {
          result = { type: "subscription_started" };
        }
      }
      handlers.data(encoder.encode(`${JSON.stringify({ id, result })}\n`));
    };
    return Promise.resolve(conn.stream);
  };
}

const SNAPSHOT_CHANGED: SessionSnapshot = { ...SNAPSHOT, version: "test-2" };

function makePolicySession(snapshots: SessionSnapshot[]) {
  const apiConns: PolicyApiConn[] = [];
  const clientConns: ClientConn[] = [];
  const frames: ServerFrame[] = [];
  const endpoint: BridgeEndpoint = {
    api: policyApiConnector(apiConns, snapshots),
    client: clientConnector(clientConns),
    label: "fake",
  };
  const session = createBridgeSession((frame) => frames.push(frame), endpoint, "m");
  const snapshotFetches = () =>
    apiConns.reduce((n, c) => n + c.requests.filter(isSnapshotFetch).length, 0);
  const pushEvent = () => {
    const sub = apiConns.find((c) => c.requests.some((r) => r.method === "events.subscribe"));
    sub?.handlers.data(
      encoder.encode(`${JSON.stringify({ event: "pane.updated", data: {} })}\n`),
    );
  };
  const snapshotPushes = () => frames.filter((f) => f.type === "snapshot");
  return { session, frames, snapshotFetches, pushEvent, snapshotPushes };
}

describe("snapshot push policy (issue #423)", () => {
  test("read-only RPCs never schedule a snapshot refetch", async () => {
    const { session, frames, snapshotFetches } = makePolicySession([SNAPSHOT]);
    await session.start();
    expect(snapshotFetches()).toBe(1);

    const methods = ["worktree.list", "session.snapshot", "agent.get", "pane.process_info"] as const;
    for (const [i, method] of methods.entries()) {
      session.handleFrame({ type: "rpc", id: `r${i}`, method: method as RpcMethod, params: { client: true } });
    }
    await waitFor(
      () => frames.filter((f) => f.type === "rpc_result").length === 4,
      "rpc_results",
    );
    await sleep(300);
    expect(snapshotFetches()).toBe(1);
    session.close();
  });

  test("mutating RPC refetches but an identical snapshot is not re-pushed", async () => {
    const { session, frames, snapshotFetches, snapshotPushes } = makePolicySession([SNAPSHOT]);
    await session.start();
    session.handleFrame({ type: "rpc", id: "m1", method: "workspace.rename", params: {} });
    await waitFor(
      () => frames.some((f) => f.type === "rpc_result" && f.id === "m1"),
      "rpc_result",
    );
    await sleep(300);
    expect(snapshotFetches()).toBe(2);
    // The refetch ran, but its content matched `ready`: no snapshot frame.
    expect(snapshotPushes()).toHaveLength(0);
    session.close();
  });

  test("event refetch dedups identical snapshots and pushes changed ones", async () => {
    const { session, snapshotFetches, pushEvent, snapshotPushes } = makePolicySession([
      SNAPSHOT,
      SNAPSHOT,
      SNAPSHOT_CHANGED,
    ]);
    await session.start();

    pushEvent();
    await sleep(300);
    expect(snapshotFetches()).toBe(2);
    expect(snapshotPushes()).toHaveLength(0);

    pushEvent();
    await sleep(300);
    expect(snapshotFetches()).toBe(3);
    expect(snapshotPushes()).toHaveLength(1);
    session.close();
  });
});
