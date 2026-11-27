import { describe, expect, test } from "bun:test";
import type { RpcMethod, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { createBridgeSession, type BridgeEndpoint } from "./bridge-core.ts";
import { decodeVarint } from "./client-link.ts";
import { metricsSnapshot } from "./metrics.ts";
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

/* ------------- demand-driven delivery / non-interference (#572) ---------- */

const MULTI: SessionSnapshot = {
  ...SNAPSHOT,
  panes: [pane("p1", "term-1"), pane("p2", "term-2"), pane("p3", "term-3"), pane("p4", "term-4")],
};

/** api connector serving a caller-chosen snapshot (apiConnector is SNAPSHOT-fixed). */
function snapshotApiConnector(conns: ApiConn[], snapshot: SessionSnapshot): Connector {
  return (handlers) => {
    const conn: ApiConn = { handlers, stream: new FakeStream() };
    conns.push(conn);
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
          ? { snapshot }
          : request.method === "events.subscribe"
            ? { type: "subscription_started" }
            : {};
      handlers.data(encoder.encode(`${JSON.stringify({ id, result })}\n`));
    };
    return Promise.resolve(conn.stream);
  };
}

/** One bridge session per `machine` tag sharing the same fake endpoint. */
function makeTaggedSessions(machines: string[], snapshot: SessionSnapshot = MULTI) {
  const apiConns: ApiConn[] = [];
  const clientConns: ClientConn[] = [];
  const frames: ServerFrame[][] = machines.map(() => []);
  const endpoint: BridgeEndpoint = {
    api: snapshotApiConnector(apiConns, snapshot),
    client: clientConnector(clientConns),
    label: "fake",
  };
  const sessions = machines.map((machine, i) =>
    createBridgeSession((frame) => frames[i]!.push(frame), endpoint, machine),
  );
  return { sessions, apiConns, clientConns, frames };
}

/** Split a FakeStream's concatenated [u32 len][payload] frames. */
function clientPayloads(stream: FakeStream): Uint8Array[] {
  const buf = stream.bytes();
  const out: Uint8Array[] = [];
  let offset = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (offset + 4 <= buf.length) {
    const len = view.getUint32(offset, true);
    out.push(buf.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }
  return out;
}

function frameVariant(payload: Uint8Array): number {
  const [v] = decodeVarint(payload, 0);
  return Number(v);
}

/** AttachTerminal payloads on a client conn: variant 5 → takeover flag. */
function attachTakeovers(conn: ClientConn): boolean[] {
  const out: boolean[] = [];
  for (const payload of clientPayloads(conn.stream)) {
    if (frameVariant(payload) !== 5) continue;
    const [, o1] = decodeVarint(payload, 0);
    const [slen, o2] = decodeVarint(payload, o1);
    out.push(payload[o2 + Number(slen)] === 1);
  }
  return out;
}

/** ServerMessage::Terminal frame carrying `bytes`. */
function terminalFrame(bytes: Uint8Array, seq = 1): Uint8Array {
  const payload = [1, ...varint(seq), ...varint(80), ...varint(24), 1, ...varint(bytes.length), ...bytes];
  return serverFrame(payload);
}

describe("demand-driven delivery: visible usage only (#572)", () => {
  test("unsubscribed panes never open a client-protocol connection", async () => {
    const { sessions, clientConns } = makeTaggedSessions(["m"], MULTI);
    const session = sessions[0]!;
    await session.start();
    // Four panes in the snapshot, zero attaches: hidden surfaces cost
    // nothing until a client subscribes.
    expect(clientConns).toHaveLength(0);

    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "one attach for the visible pane");
    expect(clientConns).toHaveLength(1);
    clientConns[0]!.handlers.data(welcomeFrame());
    await waitFor(() => attachTakeovers(clientConns[0]!).length === 1, "attach resolved");

    session.handleFrame({ type: "unsubscribe_terminal", paneId: "p1" });
    await waitFor(() => clientConns[0]!.stream.ended, "detach closes the link");
    session.close();
    for (const s of sessions) s.close();
  });

  test("scroll-up is an AttachScroll on the wire and delivered bytes are metered", async () => {
    const { sessions, clientConns, frames } = makeTaggedSessions(["m"], MULTI);
    const session = sessions[0]!;
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "attach");
    const link = clientConns[0]!;
    link.handlers.data(welcomeFrame());
    await waitFor(() => attachTakeovers(link).length === 1, "attach frame");

    const before = metricsSnapshot().meters["terminal.delivery.bytes{phase=initial}"]?.total ?? 0;
    const scrollBefore = metricsSnapshot().meters["terminal.delivery.bytes{phase=scroll}"]?.total ?? 0;

    // History paging: terminal_scroll up must encode AttachScroll (variant 6).
    session.handleFrame({ type: "terminal_scroll", paneId: "p1", direction: "up", lines: 5 });
    await waitFor(
      () => clientPayloads(link.stream).some((p) => frameVariant(p) === 6),
      "AttachScroll frame",
    );

    // Bytes delivered after the scroll count toward the post-scroll phase.
    link.handlers.data(terminalFrame(encoder.encode("history-page"), 2));
    await waitFor(
      () => frames[0]!.some((f) => f.type === "terminal_data" && f.paneId === "p1"),
      "terminal_data forward",
    );
    await sleep(20);
    const afterInitial = metricsSnapshot().meters["terminal.delivery.bytes{phase=initial}"]?.total ?? 0;
    const afterScroll = metricsSnapshot().meters["terminal.delivery.bytes{phase=scroll}"]?.total ?? 0;
    expect(afterInitial - before).toBe(0);
    expect(afterScroll - scrollBefore).toBe(encoder.encode("history-page").length);
    session.close();
  });
});

describe("multi-client non-interference (#572)", () => {
  test("an observing client attaches without takeover and cannot perturb the writable link", async () => {
    const { sessions, clientConns } = makeTaggedSessions(["writable", "observer"], MULTI);
    const [writable, observer] = sessions;
    await writable!.start();
    await observer!.start();

    // Writable client takes the pane; observer attaches in the default
    // non-takeover (read-only) mode — the #572 contract.
    writable!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, takeover: true });
    observer!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 2, "two attaches");
    const [wConn, oConn] = clientConns;
    wConn!.handlers.data(welcomeFrame());
    oConn!.handlers.data(welcomeFrame());
    await waitFor(() => attachTakeovers(wConn!).length === 1 && attachTakeovers(oConn!).length === 1, "attach frames");

    // The takeover flag is the only size/focus authority the observer could
    // exert: writable=1, observer=0.
    expect(attachTakeovers(wConn!)).toEqual([true]);
    expect(attachTakeovers(oConn!)).toEqual([false]);

    // Observer input/scroll/resize stay on the observer's own link — they
    // must never appear on the writable client's wire.
    observer!.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("OBSERVER-TYPED") });
    observer!.handleFrame({ type: "terminal_resize", paneId: "p1", cols: 132, rows: 40 });
    observer!.handleFrame({ type: "terminal_scroll", paneId: "p1", direction: "up", lines: 3 });
    await waitFor(() => oConn!.stream.contains("OBSERVER-TYPED"), "observer input on its own link");
    await sleep(30);
    expect(wConn!.stream.contains("OBSERVER-TYPED")).toBe(false);
    const wVariants = clientPayloads(wConn!.stream).map(frameVariant);
    expect(wVariants).not.toContain(3); // Resize
    expect(wVariants).not.toContain(6); // AttachScroll

    // Observer detach closes only its own link; the writable link survives.
    observer!.handleFrame({ type: "unsubscribe_terminal", paneId: "p1" });
    await waitFor(() => oConn!.stream.ended, "observer detach");
    await sleep(30);
    expect(wConn!.stream.ended).toBe(false);
    writable!.close();
    observer!.close();
  });

  test("server frames are tagged with their machine id (multi-host isolation)", async () => {
    const { sessions, clientConns, frames } = makeTaggedSessions(["remote-a"], MULTI);
    const session = sessions[0]!;
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "attach");
    clientConns[0]!.handlers.data(welcomeFrame());
    clientConns[0]!.handlers.data(terminalFrame(encoder.encode("remote-bytes"), 3));
    await waitFor(
      () => frames[0]!.some((f) => f.type === "terminal_data" && f.machine === "remote-a"),
      "machine-tagged terminal_data",
    );
    session.close();
  });
});
