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
  return { session, frames, apiConns, clientConns, snapshotFetches, subscribeRequests, subscriptionConns, pushEvent, snapshotPushes };
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

  test("pane.scroll_changed subscriptions track only attached panes across attach/detach (issue #569)", async () => {
    const multi: SessionSnapshot = {
      ...SNAPSHOT,
      panes: [pane("p1", "term-1"), pane("p2", "term-2"), pane("p3", "term-3"), pane("p4", "term-4")],
    };
    const { session, apiConns, subscribeRequests, clientConns } =
      makePolicySession([multi]);
    await session.start();
    expect(subscribeRequests()).toBe(1);

    // Scroll-subscription contents of every events.subscribe request the
    // bridge has opened, in order. Hidden panes (no subscribe_terminal)
    // must never appear: the subscription set is the delivery contract for
    // viewport traffic, so it doubles as the visibility scope.
    const scrollCoverage = () =>
      apiConns
        .flatMap((c) => c.requests)
        .filter((r) => r.method === "events.subscribe")
        .flatMap(
          (r) =>
            (r.params?.["subscriptions"] as
              | { type?: string; pane_id?: string }[]
              | undefined) ?? [],
        )
        .filter((s) => s.type === "pane.scroll_changed")
        .map((s) => s.pane_id);
    /** pane_ids covered by the most recently opened subscription. */
    const liveScrollCoverage = () => {
      const subs = apiConns
        .flatMap((c) => c.requests)
        .filter((r) => r.method === "events.subscribe")
        .at(-1)
        ?.params?.["subscriptions"] as
        | { type?: string; pane_id?: string }[]
        | undefined;
      return (subs ?? [])
        .filter((s) => s.type === "pane.scroll_changed")
        .map((s) => s.pane_id)
        .sort();
    };

    // Before any attach, the subscription carries no scroll filters at
    // all — panes in other workspaces/tabs get nothing.
    expect(liveScrollCoverage()).toEqual([]);
    expect(scrollCoverage()).toEqual([]);

    // A workspace switch mounts only the active tab's panes; the client
    // subscribes exactly those. Each attach adds its pane to the scroll set.
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    session.handleFrame({ type: "subscribe_terminal", paneId: "p2", cols: 80, rows: 24 });
    await sleep(400);
    expect(liveScrollCoverage()).toEqual(["p1", "p2"]);
    expect(clientConns).toHaveLength(2);

    // Switching away detaches p1: the reopened subscription must drop its
    // scroll filter while p2 stays covered.
    session.handleFrame({ type: "unsubscribe_terminal", paneId: "p1" });
    await sleep(400);
    expect(liveScrollCoverage()).toEqual(["p2"]);

    // Detaching the last visible pane leaves zero scroll subscriptions —
    // hidden panes get no viewport delivery at all.
    session.handleFrame({ type: "unsubscribe_terminal", paneId: "p2" });
    await sleep(400);
    expect(liveScrollCoverage()).toEqual([]);
    expect(subscribeRequests()).toBe(4);
    session.close();
  });

  test("frames for a never-subscribed pane open no attach and no scroll subscription (issue #569)", async () => {
    const { session, apiConns, frames, clientConns } =
      makePolicySession([SNAPSHOT]);
    await session.start();
    const scrollCount = () =>
      apiConns
        .flatMap((c) => c.requests)
        .filter((r) => r.method === "events.subscribe")
        .flatMap(
          (r) =>
            (r.params?.["subscriptions"] as
              | { type?: string; pane_id?: string }[]
              | undefined) ?? [],
        )
        .filter((s) => s.type === "pane.scroll_changed" && s.pane_id === "p-hidden")
        .length;
    expect(scrollCount()).toBe(0);

    // A hidden pane (different workspace/tab, or simply not mounted) must
    // not acquire an attach slot from stray lifecycle/input frames.
    session.handleFrame({ type: "unsubscribe_terminal", paneId: "p-hidden" });
    session.handleFrame({ type: "terminal_input", paneId: "p-hidden", data: b64("X") });
    session.handleFrame({ type: "terminal_resize", paneId: "p-hidden", cols: 80, rows: 24 });
    session.handleFrame({ type: "terminal_scroll", paneId: "p-hidden", direction: "up" });
    session.handleFrame({ type: "terminal_mouse", paneId: "p-hidden", action: "press", column: 1, row: 1 });
    await sleep(300);

    expect(clientConns).toHaveLength(0);
    expect(scrollCount()).toBe(0);
    expect(frames.some((f) => f.type === "terminal_closed" && f.paneId === "p-hidden")).toBe(false);
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
  test("a second non-takeover client cannot perturb the writable link", async () => {
    const { sessions, clientConns } = makeTaggedSessions(["writable", "observer"], MULTI);
    const [writable, observer] = sessions;
    await writable!.start();
    await observer!.start();

    // Writable client takes the pane; the second client attaches without
    // the takeover flag (post-#571 an absent `writable` flag still means
    // writable AttachTerminal — the #572 contract is about takeover and
    // wire isolation, not the observe mode covered below).
    writable!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, takeover: true });
    observer!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 2, "two attaches");
    const [wConn, oConn] = clientConns;
    wConn!.handlers.data(welcomeFrame());
    oConn!.handlers.data(welcomeFrame());
    await waitFor(() => attachTakeovers(wConn!).length === 1 && attachTakeovers(oConn!).length === 1, "attach frames");

    // The takeover flag is the only size/focus authority the second client
    // could exert: writable=1, observer=0.
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

  test("an ObserveTerminal client (writable:false) cannot perturb a writable attach on the same pane", async () => {
    const { sessions, clientConns } = makeTaggedSessions(["writable", "observer"], MULTI);
    const [writable, observer] = sessions;
    await writable!.start();
    await observer!.start();

    writable!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, takeover: true });
    observer!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 2, "two attaches");
    const [wConn, oConn] = clientConns;
    wConn!.handlers.data(welcomeFrame());
    oConn!.handlers.data(welcomeFrame());
    await sleep(20);

    // Observe link carries variant 7 (ObserveTerminal), writable variant 5.
    expect(frameVariants(oConn!.stream.bytes())).toEqual([0, 7]);
    expect(frameVariants(wConn!.stream.bytes())).toEqual([0, 5]);

    // Observer ops: input/mouse/scroll are dropped at the bridge (#571),
    // resize still flows on the observer's own link only.
    observer!.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("OBSERVE-TYPED") });
    observer!.handleFrame({ type: "terminal_scroll", paneId: "p1", direction: "up", lines: 3 });
    observer!.handleFrame({ type: "terminal_mouse", paneId: "p1", action: "press", column: 1, row: 1 });
    observer!.handleFrame({ type: "terminal_resize", paneId: "p1", cols: 132, rows: 40 });
    await waitFor(
      () => frameVariants(oConn!.stream.bytes()).includes(3),
      "observer resize on its own link",
    );
    await sleep(20);

    // Nothing the observer sent may appear on the writable client's wire.
    const wBytes = wConn!.stream.bytes();
    expect(Buffer.from(wBytes).toString("latin1")).not.toContain("OBSERVE-TYPED");
    const wVariants = clientPayloads(wConn!.stream).map(frameVariant);
    expect(wVariants).not.toContain(3); // Resize
    expect(wVariants).not.toContain(6); // AttachScroll
    const oVariants = clientPayloads(oConn!.stream).map(frameVariant);
    expect(oVariants).toContain(3); // Resize flowed
    expect(oVariants).not.toContain(6); // AttachScroll dropped
    expect(Buffer.from(oConn!.stream.bytes()).toString("latin1")).not.toContain("OBSERVE-TYPED");

    // Observer detach leaves the writable link alive.
    observer!.handleFrame({ type: "unsubscribe_terminal", paneId: "p1" });
    await waitFor(() => oConn!.stream.ended, "observer detach");
    await sleep(20);
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

/* ------------- operator role vs pane focus (issue #584) ----------------- */

/**
 * The GUI now grants the writable attach by input intent, not by focus
 * (docs/migration/contracts/terminal-noninterference.md). These tests pin
 * the bridge half of that contract: in-flight input flushes ahead of a
 * demotion re-attach, and an observe slot never carries input — so the
 * resize lock returns to layout/herdr control without losing a keystroke.
 */
describe("operator role separation (issue #584)", () => {
  test("in-flight input flushes on the writable link ahead of the observe demotion", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "writable connection");
    clientConns[0]!.handlers.data(welcomeFrame());
    await sleep(20);

    // Focus moved away: the client sends input and the demotion subscribe
    // back-to-back. Frame order is the contract — the input must land on
    // the still-writable link before the observe re-attach detaches it.
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("IN-FLIGHT") });
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 2, "observe re-attach connection");
    clientConns[1]!.handlers.data(welcomeFrame());
    await sleep(20);

    const writableLatin = Buffer.from(clientConns[0]!.stream.bytes()).toString("latin1");
    expect(writableLatin).toContain("IN-FLIGHT");
    // The demotion detached the writable link and opened an observe one.
    expect(clientConns[0]!.stream.ended).toBe(true);
    expect(frameVariants(clientConns[1]!.stream.bytes())).toEqual([0, 7]);
    // Post-demotion input is dropped bridge-side, exactly like #571.
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("TOO-LATE") });
    await sleep(20);
    expect(Buffer.from(clientConns[1]!.stream.bytes()).toString("latin1")).not.toContain("TOO-LATE");
    session.close();
  });

  test("promotion then immediate demotion never leaks input into the observe link", async () => {
    const { session, clientConns } = makeSession();
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 1, "observe connection");
    clientConns[0]!.handlers.data(welcomeFrame());
    await sleep(20);

    // Promote and demote before the writable attach resolves: the queued
    // input belongs to the writable epoch and must flush there — or be
    // superseded — never onto the observe link.
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: true });
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("EPOCH") });
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 3, "final observe connection");
    clientConns[2]!.handlers.data(welcomeFrame());
    await sleep(20);

    const allObserve = Buffer.from(clientConns[2]!.stream.bytes()).toString("latin1");
    expect(allObserve).not.toContain("EPOCH");
    // The middle (writable) epoch may or may not have resolved in time;
    // what matters is the surviving observe link stayed clean.
    session.close();
  });
});

/* ------------- assurance coverage (issue #586, program #416/#425/#568) -- */

describe("non-interference contract: observe cannot move the writable link (#586)", () => {
  test("observer ops leave the writable link's size, focus and scroll authority untouched", async () => {
    const { sessions, clientConns, frames } = makeTaggedSessions(["gui", "tui"], MULTI);
    const [gui, tui] = sessions;
    await gui!.start();
    await tui!.start();

    // The GUI holds the writable attach (takeover); the TUI observes the
    // same pane read-only (issue #571 writable:false).
    gui!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, takeover: true });
    tui!.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 2, "two attaches");
    const [wConn, oConn] = clientConns;
    wConn!.handlers.data(welcomeFrame());
    oConn!.handlers.data(welcomeFrame());
    await waitFor(
      () => frameVariants(wConn!.stream.bytes()).join() === "0,5" &&
        frameVariants(oConn!.stream.bytes()).join() === "0,7",
      "attach modes settled",
    );

    const scrollOpsBefore = metricsSnapshot().counters["bridge.terminal.op{op=scroll}"] ?? 0;

    // Everything an observer can send — input, scroll, mouse, resize — plus
    // a second observe subscribe on another pane. None may reach the
    // writable link or change its announced size/focus/scroll authority.
    tui!.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("GUI-STEAL") });
    tui!.handleFrame({ type: "terminal_scroll", paneId: "p1", direction: "up", lines: 4 });
    tui!.handleFrame({ type: "terminal_mouse", paneId: "p1", action: "press", column: 1, row: 1 });
    tui!.handleFrame({ type: "terminal_resize", paneId: "p1", cols: 132, rows: 40 });
    tui!.handleFrame({ type: "subscribe_terminal", paneId: "p2", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 3, "second observe attach");
    clientConns[2]!.handlers.data(welcomeFrame());
    await sleep(30);

    // The writable wire still carries exactly hello+attach: no Resize (3),
    // no Detach (4), no Input (1), no AttachScroll (6), no re-attach.
    expect(new Set(frameVariants(wConn!.stream.bytes()))).toEqual(new Set([0, 5]));
    expect(Buffer.from(wConn!.stream.bytes()).toString("latin1")).not.toContain("GUI-STEAL");

    // The observer's dropped scroll op was still counted at receipt — the
    // op meter sees attempted ops even when the writable gate drops them.
    const scrollOpsAfter = metricsSnapshot().counters["bridge.terminal.op{op=scroll}"] ?? 0;
    expect(scrollOpsAfter - scrollOpsBefore).toBe(1);

    // The writable path is fully functional afterwards: input reaches the
    // pty and delivered bytes still reach this client's frames.
    gui!.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("GUI-TYPED") });
    await waitFor(
      () => Buffer.from(wConn!.stream.bytes()).toString("latin1").includes("GUI-TYPED"),
      "writable input after observer ops",
    );
    wConn!.handlers.data(terminalFrame(encoder.encode("still-live"), 7));
    await waitFor(
      () => frames[0]!.some((f) => f.type === "terminal_data" && f.paneId === "p1"),
      "terminal_data still forwarded",
    );
    gui!.close();
    tui!.close();
  });
});

describe("operator handoff: writable follows focus across panes (#586)", () => {
  test("demote flips the slot to ObserveTerminal, observe-mode input is dropped and counted, re-promote restores writable", async () => {
    const { session, clientConns } = makePolicySession([MULTI]);
    await session.start();
    // Both panes mounted writable. CURRENT merged semantics: the bridge
    // does not arbitrate a single writable pane per machine — the renderer
    // sends `writable` only for the operator pane (issue #584: input
    // intent, not mere focus). These tests pin the per-slot mode
    // contract, which #584 did not change.
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    session.handleFrame({ type: "subscribe_terminal", paneId: "p2", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 2, "two writable attaches");
    const [p1a, p2] = clientConns;
    p1a!.handlers.data(welcomeFrame());
    p2!.handlers.data(welcomeFrame());
    await waitFor(
      () => frameVariants(p1a!.stream.bytes()).join() === "0,5" &&
        frameVariants(p2!.stream.bytes()).join() === "0,5",
      "writable attaches",
    );

    // Focus moves p1 -> p2: the client re-negotiates p1 to observe (#571
    // mode switch = new connection; the slot, refcount and op queue
    // survive the flip).
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24, writable: false });
    await waitFor(() => clientConns.length === 3, "demote re-attach");
    const p1b = clientConns[2]!;
    p1b.handlers.data(welcomeFrame());
    await sleep(30);

    // Demote releases the writable link: the superseded AttachTerminal got
    // Detach (variant 4) and closed; the new link is ObserveTerminal (7).
    // Resize authority over p1 is returned to the pane/herdr side.
    expect(frameVariants(p1a!.stream.bytes())).toContain(4);
    expect(p1a!.stream.ended).toBe(true);
    expect(new Set(frameVariants(p1b.stream.bytes()))).toEqual(new Set([0, 7]));

    // p2's writable link is untouched by the handoff.
    expect(p2!.stream.ended).toBe(false);
    expect(new Set(frameVariants(p2!.stream.bytes()))).toEqual(new Set([0, 5]));

    // Input typed while p1 observes is dropped at the bridge — counted at
    // receipt, never written to any wire. Resize still flows because an
    // observe client renders into the size it announces.
    const inputOpsBefore = metricsSnapshot().counters["bridge.terminal.op{op=input}"] ?? 0;
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("TO-OBSERVE") });
    session.handleFrame({ type: "terminal_resize", paneId: "p1", cols: 100, rows: 30 });
    await waitFor(() => frameVariants(p1b.stream.bytes()).includes(3), "observe resize flows");
    await sleep(20);
    expect(Buffer.from(p1b.stream.bytes()).toString("latin1")).not.toContain("TO-OBSERVE");
    expect((metricsSnapshot().counters["bridge.terminal.op{op=input}"] ?? 0) - inputOpsBefore).toBe(1);

    // Focus returns to p1: writable re-negotiation restores the input path.
    // Input sent while the promotion attach resolves queues and flushes to
    // the new link in order — nothing typed is lost (AGENTS.md §3).
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 4, "re-promote attach");
    const p1c = clientConns[3]!;
    session.handleFrame({ type: "terminal_input", paneId: "p1", data: b64("BACK") });
    p1c.handlers.data(welcomeFrame());
    await waitFor(
      () => Buffer.from(p1c.stream.bytes()).toString("latin1").includes("BACK"),
      "promoted input flush",
    );
    expect(new Set(frameVariants(p1c.stream.bytes()))).toEqual(new Set([0, 5, 1]));
    // The observe link was superseded and detached, not leaked.
    expect(p1b.stream.ended).toBe(true);
    expect(frameVariants(p1b.stream.bytes())).toContain(4);
    session.close();
  });
});

describe("local history scroll is viewport-only (#586)", () => {
  test("scroll paging issues no RPC, no re-attach and no snapshot refetch", async () => {
    const { session, apiConns, clientConns, frames, snapshotFetches, subscribeRequests, pushEvent, snapshotPushes } =
      makePolicySession([MULTI]);
    await session.start();
    session.handleFrame({ type: "subscribe_terminal", paneId: "p1", cols: 80, rows: 24 });
    await waitFor(() => clientConns.length === 1, "attach");
    clientConns[0]!.handlers.data(welcomeFrame());
    await waitFor(() => attachTakeovers(clientConns[0]!).length === 1, "attach resolved");
    await sleep(400); // scroll-subscription resync settles

    const requestCount = () => apiConns.reduce((n, c) => n + c.requests.length, 0);
    const rpcCount = () =>
      apiConns.reduce((n, c) => n + c.requests.filter((r) => r.method !== "events.subscribe").length, 0);
    const deliveryBefore =
      metricsSnapshot().meters["terminal.delivery.bytes{phase=scroll}"]?.total ?? 0;
    const before = {
      requests: requestCount(),
      rpcs: rpcCount(),
      snapshots: snapshotFetches(),
      subscribes: subscribeRequests(),
      pushes: snapshotPushes().length,
      attaches: metricsSnapshot().counters["bridge.terminal.attach"] ?? 0,
      conns: clientConns.length,
    };

    // Page through history and back to the live screen, plus a stray scroll
    // on a never-subscribed pane. Every tick must stay on the existing
    // attach link: viewport paging is AttachScroll wire traffic, nothing
    // more (herdr protocol v22 has no separate history-fetch message).
    for (let i = 0; i < 12; i++) {
      session.handleFrame({
        type: "terminal_scroll",
        paneId: "p1",
        direction: i % 2 === 0 ? "up" : "down",
        lines: 5,
      });
    }
    session.handleFrame({ type: "terminal_scroll", paneId: "p-hidden", direction: "up" });
    await sleep(400);

    // Zero new herdr traffic of any kind: no session.snapshot refetch, no
    // events.subscribe reopen, no RPC, no second attach connection.
    expect(requestCount()).toBe(before.requests);
    expect(rpcCount()).toBe(before.rpcs);
    expect(snapshotFetches()).toBe(before.snapshots);
    expect(subscribeRequests()).toBe(before.subscribes);
    expect(snapshotPushes()).toHaveLength(before.pushes);
    expect(clientConns).toHaveLength(before.conns);
    expect(metricsSnapshot().counters["bridge.terminal.attach"] ?? 0).toBe(before.attaches);

    // Each scroll became exactly one AttachScroll (variant 6) on the wire —
    // 12 issued, 12 forwarded, nothing amplified or dropped.
    const scrollFrames = clientPayloads(clientConns[0]!.stream).filter((p) => frameVariant(p) === 6);
    expect(scrollFrames).toHaveLength(12);

    // A pane.scroll_changed event stays event-only: forwarded to the client
    // but it must not refetch the snapshot (issues #416/#527, #569).
    pushEvent("pane.scroll_changed");
    await sleep(300);
    expect(frames.some((f) => f.type === "event")).toBe(true);
    expect(requestCount()).toBe(before.requests);
    expect(snapshotFetches()).toBe(before.snapshots);

    // Bytes herdr delivers after the scroll count toward the post-scroll
    // delivery phase — the demand-driven signal the RC legs gate on (#572).
    clientConns[0]!.handlers.data(terminalFrame(encoder.encode("history-page"), 9));
    await waitFor(
      () => frames.some((f) => f.type === "terminal_data" && f.paneId === "p1"),
      "terminal_data forward",
    );
    await sleep(20);
    const deliveryAfter =
      metricsSnapshot().meters["terminal.delivery.bytes{phase=scroll}"]?.total ?? 0;
    expect(deliveryAfter - deliveryBefore).toBe(encoder.encode("history-page").length);
    session.close();
  });
});

describe("host scaling: cost tracks visible panes, not total panes (#586)", () => {
  const MACHINES = 3;
  const PANES_PER_MACHINE = 6;
  const VISIBLE_PER_MACHINE = 2;

  interface ScaledApiConn extends ApiConn {
    requests: { id?: string; method?: string; params?: Record<string, unknown> }[];
  }

  /** snapshotApiConnector + request recording (per-machine snapshot). */
  function scaledApiConnector(conns: ScaledApiConn[], snapshot: SessionSnapshot): Connector {
    return (handlers) => {
      const conn: ScaledApiConn = { handlers, stream: new FakeStream(), requests: [] };
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
        conn.requests.push(request);
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

  /** N fake machines, each with its own snapshot of K panes. */
  function scaledSessions() {
    return Array.from({ length: MACHINES }, (_, m) => {
      const machine = `host-${m}`;
      const paneIds = Array.from({ length: PANES_PER_MACHINE }, (_, i) => `${machine}-p${i}`);
      const snapshot: SessionSnapshot = {
        ...SNAPSHOT,
        panes: paneIds.map((id) => pane(id, `term-${id}`)),
      };
      const apiConns: ScaledApiConn[] = [];
      const clientConns: ClientConn[] = [];
      const frames: ServerFrame[] = [];
      const endpoint: BridgeEndpoint = {
        api: scaledApiConnector(apiConns, snapshot),
        client: clientConnector(clientConns),
        label: "fake",
      };
      const session = createBridgeSession((f) => frames.push(f), endpoint, machine);
      return { machine, paneIds, session, apiConns, clientConns, frames };
    });
  }

  const allRequests = (m: { apiConns: ScaledApiConn[] }) => m.apiConns.flatMap((c) => c.requests);
  const snapshotFetches = (m: { apiConns: ScaledApiConn[] }) =>
    allRequests(m).filter((r) => r.method === "session.snapshot").length;
  const subscribeRequests = (m: { apiConns: ScaledApiConn[] }) =>
    allRequests(m).filter((r) => r.method === "events.subscribe");
  /** pane_ids in the most recently opened subscription of this machine. */
  const liveScrollCoverage = (m: { apiConns: ScaledApiConn[] }) => {
    const subs = subscribeRequests(m).at(-1)?.params?.["subscriptions"] as
      | { type?: string; pane_id?: string }[]
      | undefined;
    return (subs ?? [])
      .filter((s) => s.type === "pane.scroll_changed")
      .map((s) => s.pane_id)
      .sort();
  };
  /** pane_ids that ever appeared in any scroll subscription on this machine. */
  const everScrollCovered = (m: { apiConns: ScaledApiConn[] }) =>
    new Set(
      subscribeRequests(m).flatMap(
        (r) =>
          ((r.params?.["subscriptions"] as { type?: string; pane_id?: string }[] | undefined) ?? [])
            .filter((s) => s.type === "pane.scroll_changed")
            .map((s) => s.pane_id),
      ),
    );

  test("N machines x M visible panes: attach/RPC/subscription cost is O(visible), hidden panes cost nothing", async () => {
    const hosts = scaledSessions();
    const visible = hosts.map((h) => h.paneIds.slice(0, VISIBLE_PER_MACHINE));
    const hidden = hosts.map((h) => h.paneIds.slice(VISIBLE_PER_MACHINE));
    for (const h of hosts) await h.session.start();

    // Baseline: one boot snapshot fetch + one events.subscribe per machine —
    // cost scales with machines, never with pane count (18 panes exist).
    for (const h of hosts) {
      expect(snapshotFetches(h)).toBe(1);
      expect(subscribeRequests(h)).toHaveLength(1);
      expect(h.clientConns).toHaveLength(0);
    }

    // Each client mounts only its VISIBLE panes per machine.
    for (const [i, h] of hosts.entries()) {
      for (const paneId of visible[i]!) {
        h.session.handleFrame({ type: "subscribe_terminal", paneId, cols: 80, rows: 24 });
      }
    }
    await sleep(500); // attach batch + debounced scroll-resync settle
    for (const h of hosts) {
      for (const conn of h.clientConns) conn.handlers.data(welcomeFrame());
    }
    await sleep(30);

    // Exactly M attach connections per machine — the other K-M panes per
    // machine (and all panes on machines with no visible surface) opened
    // nothing.
    const totalAttaches = hosts.reduce((n, h) => n + h.clientConns.length, 0);
    expect(totalAttaches).toBe(MACHINES * VISIBLE_PER_MACHINE);
    for (const h of hosts) expect(h.clientConns).toHaveLength(VISIBLE_PER_MACHINE);

    // Scroll subscriptions cover exactly the visible panes; hidden panes
    // never appear in any subscription set.
    for (const [i, h] of hosts.entries()) {
      expect(liveScrollCoverage(h)).toEqual([...visible[i]!].sort());
      for (const paneId of hidden[i]!) expect(everScrollCovered(h).has(paneId)).toBe(false);
    }

    // RPC traffic is still one snapshot fetch per machine: attaches resolve
    // terminal ids from the boot snapshot, so pane count adds zero RPCs.
    for (const h of hosts) {
      expect(snapshotFetches(h)).toBe(1);
      expect(allRequests(h).filter((r) => r.method !== "events.subscribe")).toHaveLength(1);
    }

    // Subscription reopens coalesce per attach batch: 1 boot + 1 resync per
    // machine so far — O(batches), not O(panes).
    for (const h of hosts) expect(subscribeRequests(h)).toHaveLength(2);

    // Growing the visible set grows cost linearly with what is mounted:
    // subscribing the remaining panes adds exactly K-M attaches and one
    // more coalesced reopen per machine.
    for (const [i, h] of hosts.entries()) {
      for (const paneId of hidden[i]!) {
        h.session.handleFrame({ type: "subscribe_terminal", paneId, cols: 80, rows: 24 });
      }
    }
    await sleep(500);
    for (const h of hosts) {
      for (const conn of h.clientConns.slice(-PANES_PER_MACHINE + VISIBLE_PER_MACHINE)) {
        conn.handlers.data(welcomeFrame());
      }
    }
    await sleep(30);
    for (const h of hosts) {
      expect(h.clientConns).toHaveLength(PANES_PER_MACHINE);
      expect(liveScrollCoverage(h)).toEqual([...h.paneIds].sort());
      expect(subscribeRequests(h)).toHaveLength(3);
      expect(snapshotFetches(h)).toBe(1);
    }

    // Detaching everything closes every link and empties the scroll set —
    // hidden state again costs nothing.
    for (const h of hosts) {
      for (const paneId of h.paneIds) {
        h.session.handleFrame({ type: "unsubscribe_terminal", paneId });
      }
    }
    await sleep(500);
    for (const h of hosts) {
      expect(liveScrollCoverage(h)).toEqual([]);
      for (const conn of h.clientConns) expect(conn.stream.ended).toBe(true);
      h.session.close();
    }
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
