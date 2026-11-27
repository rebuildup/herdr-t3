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

  test("ops past the queue cap fail the attach instead of growing forever (issue #499)", async () => {
    const { session, clientConns, frames } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "client attach connection");
    const link = clientConns[0]!;

    // The attach never resolves (no Welcome): ops must stop queueing at the
    // cap and the slot must fail safe with a terminal_closed frame.
    for (let i = 0; i < 600; i++) {
      session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64(`k${i}`) });
    }
    await waitFor(
      () => frames.some((f) => f.type === "terminal_closed" && f.paneId === "p1" && f.reason === "attach_overrun"),
      "attach_overrun terminal_closed",
    );
    // The abandoned attach still resolves later; its link is closed on arrival.
    link.handlers.data(welcomeFrame());
    await sleep(30);
    expect(link.stream.contains("k599")).toBe(false);
    session.close();
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

function pane(pane_id: string, terminal_id: string): SessionSnapshot["panes"][number] {
  return {
    agent_status: "idle",
    focused: false,
    pane_id,
    revision: 1,
    tab_id: "t1",
    terminal_id,
    workspace_id: "w1",
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
  const subscribeRequests = () =>
    apiConns.reduce((n, c) => n + c.requests.filter((r) => r.method === "events.subscribe").length, 0);
  /** api connections that carry an events.subscribe request (one per open). */
  const subscriptionConns = () =>
    apiConns.filter((c) => c.requests.some((r) => r.method === "events.subscribe"));
  const pushEvent = (event = "pane.updated") => {
    // The live subscription is the most recently opened one; earlier conns
    // are closed and ignore data anyway.
    const sub = subscriptionConns().at(-1);
    sub?.handlers.data(
      encoder.encode(`${JSON.stringify({ event, data: {} })}\n`),
    );
  };
  const snapshotPushes = () => frames.filter((f) => f.type === "snapshot");
  return { session, frames, apiConns, snapshotFetches, subscribeRequests, subscriptionConns, pushEvent, snapshotPushes };
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

/* ------------------- subscription lifecycle (issue #527) ------------------ */

describe("subscription lifecycle (issue #527)", () => {
  test("a dropped subscription is recovered once: one refetch, one reopen, no leak", async () => {
    const { session, snapshotFetches, subscribeRequests, subscriptionConns } =
      makePolicySession([SNAPSHOT]);
    await session.start();
    expect(subscriptionConns()).toHaveLength(1);

    // The events.subscribe socket dies: recovery must fetch the snapshot
    // once and reopen the subscription once — the old code also fired the
    // 2 s retry unconditionally, installing a second live subscription on
    // top of the recovered one (leaked socket + duplicated events).
    subscriptionConns()[0]!.handlers.close?.();
    await waitFor(() => subscribeRequests() === 2, "subscription reopen");
    await sleep(300);
    expect(snapshotFetches()).toBe(2);
    expect(subscriptionConns()).toHaveLength(2);

    // Past the retry window: the restored subscription must not be
    // replaced again — exactly one recovery total.
    await sleep(2200);
    expect(subscribeRequests()).toBe(2);
    expect(snapshotFetches()).toBe(2);
    session.close();
  });

  test("a burst of terminal attaches coalesces scroll-subscription reopens", async () => {
    const multi: SessionSnapshot = {
      ...SNAPSHOT,
      panes: [pane("p1", "term-1"), pane("p2", "term-2"), pane("p3", "term-3"), pane("p4", "term-4")],
    };
    const { session, subscribeRequests } = makePolicySession([multi]);
    await session.start();
    expect(subscribeRequests()).toBe(1);

    // A workspace switch attaches every visible pane in one burst; each
    // attach used to synchronously close+reopen the whole subscription.
    for (const id of ["p1", "p2", "p3", "p4"]) {
      session.handleFrame({ type: "subscribe_terminal", paneId: id, cols: 80, rows: 24 });
    }
    await sleep(400);
    expect(subscribeRequests()).toBe(2);

    // Same for the detach burst on switch-away.
    for (const id of ["p1", "p2", "p3", "p4"]) {
      session.handleFrame({ type: "unsubscribe_terminal", paneId: id });
    }
    await sleep(400);
    expect(subscribeRequests()).toBe(3);
    session.close();
  });

  test("pane.scroll_changed events are forwarded but never refetch the snapshot", async () => {
    const { session, frames, snapshotFetches, pushEvent, snapshotPushes } =
      makePolicySession([SNAPSHOT]);
    await session.start();
    expect(snapshotFetches()).toBe(1);

    // Scroll bursts used to schedule a full session.snapshot fetch — and,
    // because pane.scroll is part of the snapshot, a full snapshot push —
    // per debounce window (issues #416/#527). The event itself is the
    // delivery channel clients consume.
    pushEvent("pane.scroll_changed");
    pushEvent("pane.scroll_changed");
    await sleep(300);
    expect(snapshotFetches()).toBe(1);
    expect(snapshotPushes()).toHaveLength(0);
    expect(frames.some((f) => f.type === "event")).toBe(true);

    // Structure/status events still refetch as before.
    pushEvent("pane.updated");
    await sleep(300);
    expect(snapshotFetches()).toBe(2);
    session.close();
  });
});

/* ------------- observe/writable coexistence (issue #571) ----------------- */

/**
 * Multi-client non-interference contract: a pane subscribed with
 * `writable: false` must hold an ObserveTerminal link — no resize lock, no
 * input path — while a writable attach on the same or another pane keeps
 * working, and a mode-negotiation subscribe flips the live slot without
 * dropping queued input.
 */
describe("observe/writable attach modes (issue #571)", () => {
  test("observe subscribe opens ObserveTerminal; input/scroll/mouse are dropped, resize flows", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 1, "observe connection");
    const link = clientConns[0]!;
    link.handlers.data(welcomeFrame());
    await sleep(20);

    // Input-class frames must never reach an observe link.
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("TYPED") });
    session.handleFrame({ type: "terminal_scroll", paneId: "p1", direction: "up" });
    session.handleFrame({ type: "terminal_mouse", paneId: "p1", action: "press", column: 1, row: 1 });
    // Resize still flows: an observe client renders into the size it announces.
    session.handleFrame({ type: "terminal_resize", paneId: "p1", cols: 100, rows: 30 });
    await sleep(30);

    const latin = Buffer.from(link.stream.bytes()).toString("latin1");
    expect(latin).not.toContain("TYPED");
    // variants: 0 TerminalHello, 7 ObserveTerminal, 3 Resize — nothing else.
    const variants = frameVariants(link.stream.bytes());
    expect(variants).toEqual([0, 7, 3]);
    session.close();
  });

  test("mode-negotiation subscribe promotes observe to writable on a new link, queue intact", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 1, "observe connection");
    clientConns[0]!.handlers.data(welcomeFrame());
    await sleep(20);

    // Promote: same paneId, writable flips — the bridge re-attaches without
    // an unsubscribe, so the slot (and its op queue) survives.
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: true });
    await waitFor(() => clientConns.length === 2, "writable re-attach connection");
    const writable = clientConns[1]!;
    // Input typed while the promotion attach is still resolving queues and
    // flushes to the new link in order — nothing typed is lost (AGENTS.md §3).
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("PROMOTED") });
    writable.handlers.data(welcomeFrame());
    await waitFor(() => Buffer.from(writable.stream.bytes()).toString("latin1").includes("PROMOTED"), "promoted input flush");

    // The superseded observe link was detached, not leaked.
    expect(clientConns[0]!.stream.ended).toBe(true);
    expect(frameVariants(clientConns[0]!.stream.bytes())).toContain(4); // Detach

    // Demote back to observe: a third connection, input dropped again.
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 3, "observe re-attach connection");
    clientConns[2]!.handlers.data(welcomeFrame());
    await sleep(20);
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("DROPPED") });
    await sleep(20);
    expect(Buffer.from(clientConns[2]!.stream.bytes()).toString("latin1")).not.toContain("DROPPED");

    // One unsubscribe still releases the whole slot: no fourth connection,
    // and the final link detaches.
    session.handleFrame({ type: "unsubscribe_terminal", paneId: "p1" });
    await sleep(30);
    expect(clientConns).toHaveLength(3);
    expect(clientConns[2]!.stream.ended).toBe(true);
    session.close();
  });

  test("observe and writable attaches coexist on different panes without cross-talk", async () => {
    const multi: SessionSnapshot = {
      ...SNAPSHOT,
      panes: [pane("p1", "term-1"), pane("p2", "term-2")],
    };
    const apiConns: PolicyApiConn[] = [];
    const clientConns: ClientConn[] = [];
    const frames: ServerFrame[] = [];
    const endpoint: BridgeEndpoint = {
      api: policyApiConnector(apiConns, [multi]),
      client: clientConnector(clientConns),
      label: "fake",
    };
    const session = createBridgeSession((f) => frames.push(f), endpoint, "m");
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    session.handleFrame({ type: "subscribe_terminal", paneId: "p2", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 2, "two attach connections");
    clientConns[0]!.handlers.data(welcomeFrame());
    clientConns[1]!.handlers.data(welcomeFrame());
    await sleep(20);

    // p1 observes (variant 7), p2 attaches writable (variant 5).
    expect(frameVariants(clientConns[0]!.stream.bytes())).toEqual([0, 7]);
    expect(frameVariants(clientConns[1]!.stream.bytes())).toEqual([0, 5]);

    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("NO") });
    session.handleFrame({ type: "terminal_input", paneId: "p2", data: b64("YES") });
    await sleep(20);
    expect(Buffer.from(clientConns[0]!.stream.bytes()).toString("latin1")).not.toContain("NO");
    expect(Buffer.from(clientConns[1]!.stream.bytes()).toString("latin1")).toContain("YES");
    session.close();
  });

  test("absent writable flag keeps the writable AttachTerminal default", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "default attach connection");
    clientConns[0]!.handlers.data(welcomeFrame());
    await sleep(20);
    expect(frameVariants(clientConns[0]!.stream.bytes())).toEqual([0, 5]);
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("OK") });
    await waitFor(() => Buffer.from(clientConns[0]!.stream.bytes()).toString("latin1").includes("OK"), "writable input");
    session.close();
  });
});

/** Variant discriminants (first payload byte) of every complete bincode frame. */
function frameVariants(bytes: Uint8Array): number[] {
  const out: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = view.getUint32(offset, true);
    if (offset + 4 + len > bytes.length) break;
    out.push(bytes[offset + 4]!);
    offset += 4 + len;
  }
  return out;
}
