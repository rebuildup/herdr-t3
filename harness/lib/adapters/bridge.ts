/**
 * TS adapter for bridge attach-session ops (issue #600, H-NI-6).
 *
 * Drives the real `createBridgeSession` (server/bridge-core.ts) over fake
 * transports — the same JSON-lines api connector and bincode client
 * connector the bridge-core contract tests use — so scenarios observe the
 * production attach/mode-negotiation/delivery code, not a re-implementation.
 *
 * One adapter instance = one scenario run = one shared fake herdr (api
 * side: all sessions' RPC + events.subscribe requests land in one ordered
 * log) plus one client-protocol connector per named bridge session. This
 * models "several GUI clients, one herdr": session names are the clients.
 *
 * Ops are deliberately language-neutral (JSON in, normalized JSON out —
 * wire variant numbers, decoded ClientInput texts, frame types, herdr
 * request methods). `crates/herdr-bridge` implements the same op family
 * against its session state machine so the scenario files under
 * harness/scenarios/bridge/ run differentially; see harness/README.md.
 */
import type { ClientFrame, ServerFrame, SessionSnapshot } from "../../../shared/protocol.ts";
import { createBridgeSession, type BridgeEndpoint, type BridgeSession, type SnapshotDetail } from "../../../server/bridge-core.ts";
import { decodeVarint } from "../../../server/client-link.ts";
import { metricsSnapshot } from "../../../server/metrics.ts";
import type { ByteStream, Connector, SocketHandlers } from "../../../server/socket.ts";
import type { Adapter, Observation } from "../types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ fake streams ---------------------------- */

class FakeStream implements ByteStream {
  readonly chunks: Uint8Array[] = [];
  ended = false;
  write(data: string | Uint8Array): void {
    this.chunks.push(typeof data === "string" ? encoder.encode(data) : data);
  }
  end(): void {
    this.ended = true;
  }
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
}

/* ------------------------------ fake herdr ------------------------------- */

interface ApiConn {
  handlers: SocketHandlers;
  stream: FakeStream;
  requests: { id?: string; method?: string; params?: Record<string, unknown> }[];
}

interface ClientConn {
  handlers: SocketHandlers;
  stream: FakeStream;
}

/**
 * Shared fake herdr api endpoint: records every JSON-lines request in
 * order and answers session.snapshot / events.subscribe immediately.
 * `snapshot` is the single fixture every session sees (scenarios that
 * need per-session snapshots are out of scope — the corpus pins attach
 * semantics, not snapshot fan-out).
 */
function apiConnector(apiConns: ApiConn[], snapshot: SessionSnapshot): Connector {
  return (handlers) => {
    const conn: ApiConn = { handlers, stream: new FakeStream(), requests: [] };
    apiConns.push(conn);
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

/* --------------------------- wire frame decoding ------------------------ */

const varint = (value: number): number[] =>
  value <= 250 ? [value] : [251, value & 0xff, (value >> 8) & 0xff];

function serverFrame(payload: number[]): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

/** ServerMessage::Welcome { version: 22, encoding: TerminalAnsi(1), error: None }. */
function welcomeFrame(version = 22): Uint8Array {
  return serverFrame([...varint(0), ...varint(version), ...varint(1), 0]);
}

/** ServerMessage::Terminal frame carrying `text` (UTF-8 bytes). */
function terminalFrame(text: string, seq = 1): Uint8Array {
  const bytes = encoder.encode(text);
  const payload = [1, ...varint(seq), ...varint(80), ...varint(24), 1, ...varint(bytes.length), ...bytes];
  return serverFrame(payload);
}

/** ServerMessage::ServerShutdown { reason: None }. */
function shutdownFrame(): Uint8Array {
  return serverFrame([...varint(3), 0]);
}

/** Split a FakeStream's concatenated [u32 len][payload] frames. */
function clientPayloads(stream: FakeStream): Uint8Array[] {
  const buf = stream.bytes();
  const out: Uint8Array[] = [];
  let offset = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (offset + 4 <= buf.length) {
    const len = view.getUint32(offset, true);
    if (offset + 4 + len > buf.length) break;
    out.push(buf.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }
  return out;
}

function frameVariant(payload: Uint8Array): number {
  const [v] = decodeVarint(payload, 0);
  return Number(v);
}

/** Decoded ClientInput (variant 1) payloads as UTF-8 text, in wire order. */
function clientInputs(stream: FakeStream): string[] {
  const out: string[] = [];
  for (const payload of clientPayloads(stream)) {
    if (frameVariant(payload) !== 1) continue;
    const [, o1] = decodeVarint(payload, 0);
    const [len, o2] = decodeVarint(payload, o1);
    out.push(decoder.decode(payload.subarray(o2, o2 + Number(len))));
  }
  return out;
}

/** Takeover flag of every AttachTerminal (variant 5) payload, in order. */
function attachTakeovers(stream: FakeStream): boolean[] {
  const out: boolean[] = [];
  for (const payload of clientPayloads(stream)) {
    if (frameVariant(payload) !== 5) continue;
    const [, o1] = decodeVarint(payload, 0);
    const [slen, o2] = decodeVarint(payload, o1);
    out.push(payload[o2 + Number(slen)] === 1);
  }
  return out;
}

/** Attach mode a connection ended in, from the mode message it carried. */
function connMode(variants: number[]): string {
  if (variants.includes(5)) return "writable";
  if (variants.includes(7)) return "observe";
  if (variants.includes(8)) return "control";
  return "pending";
}

/* ------------------------------ default snapshot ------------------------ */

function pane(pane_id: string, terminal_id: string) {
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

const DEFAULT_SNAPSHOT = {
  agents: [],
  layouts: [],
  panes: [pane("p1", "term-1"), pane("p2", "term-2"), pane("p3", "term-3"), pane("p4", "term-4")],
  protocol: 22,
  tabs: [],
  version: "harness",
  workspaces: [
    {
      active_tab_id: "t1",
      agent_status: "idle",
      focused: true,
      label: "w",
      number: 1,
      pane_count: 4,
      tab_count: 1,
      workspace_id: "w1",
    },
  ],
} as unknown as SessionSnapshot;

/* --------------------------------- adapter ------------------------------- */

interface SessionEntry {
  name: string;
  session: BridgeSession;
  clientConns: ClientConn[];
  frames: ServerFrame[];
}

const BRIDGE_OPS = new Set([
  "bridge_new",
  "bridge_close",
  "subscribe_terminal",
  "unsubscribe_terminal",
  "terminal_input",
  "terminal_resize",
  "terminal_scroll",
  "terminal_mouse",
  "rpc",
  "deliver_welcome",
  "deliver_terminal",
  "deliver_shutdown",
  "close_client_conn",
  "inject_event",
  "set_detail",
  "sleep",
  "bridge_state",
]);

export function createBridgeAdapter(): Adapter {
  // Metrics baseline at adapter creation: every observation reports deltas
  // since the scenario started, immune to earlier scenarios in the process.
  const metricBase = metricsSnapshot();
  const meterBase = (name: string) =>
    Object.entries(metricBase.meters ?? {})
      .filter(([k]) => k === name || k.startsWith(`${name}{`))
      .reduce((n, [, m]) => n + m.total, 0);
  const counterBase = (name: string) =>
    Object.entries(metricBase.counters)
      .filter(([k]) => k === name || k.startsWith(`${name}{`))
      .reduce((n, [, v]) => n + v, 0);

  const apiConns: ApiConn[] = [];
  const sessions = new Map<string, SessionEntry>();
  let snapshot: SessionSnapshot = DEFAULT_SNAPSHOT;

  const requireSession = (input: Record<string, unknown>): SessionEntry => {
    const name = String(input["session"] ?? "");
    const entry = sessions.get(name);
    if (!entry) throw new Error(`bridge adapter: unknown session "${name}"`);
    return entry;
  };

  const str = (input: Record<string, unknown>, key: string, dflt = ""): string =>
    typeof input[key] === "string" ? (input[key] as string) : dflt;
  const num = (input: Record<string, unknown>, key: string, dflt: number): number =>
    typeof input[key] === "number" ? (input[key] as number) : dflt;
  const bool = (input: Record<string, unknown>, key: string): boolean | undefined =>
    typeof input[key] === "boolean" ? (input[key] as boolean) : undefined;

  /** Let connector promises, link resolution and debounce timers settle. */
  const settle = () => sleep(20);

  const ops: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
    async bridge_new(input) {
      const name = str(input, "name");
      if (!name) throw new Error("bridge_new needs a name");
      if (sessions.has(name)) throw new Error(`bridge_new: session "${name}" already exists`);
      if (input["snapshot"] !== undefined) snapshot = input["snapshot"] as SessionSnapshot;
      const detail = (str(input, "detail", "full") || "full") as SnapshotDetail;
      const entry: SessionEntry = {
        name,
        session: undefined as unknown as BridgeSession,
        clientConns: [],
        frames: [],
      };
      // Per-session client connector: each session's attach links are its
      // own connections to the shared fake herdr client socket.
      const client: Connector = (handlers) => {
        const conn: ClientConn = { handlers, stream: new FakeStream() };
        entry.clientConns.push(conn);
        return Promise.resolve(conn.stream);
      };
      const endpoint: BridgeEndpoint = { api: apiConnector(apiConns, snapshot), client, label: "harness" };
      entry.session = createBridgeSession(
        (frame) => entry.frames.push(frame),
        endpoint,
        name,
        detail,
      );
      sessions.set(name, entry);
      await entry.session.start();
      await settle();
      return { name, detail };
    },

    async bridge_close(input) {
      const entry = requireSession(input);
      entry.session.close();
      await settle();
      return { closed: entry.name };
    },

    async subscribe_terminal(input) {
      const entry = requireSession(input);
      const frame: Extract<ClientFrame, { type: "subscribe_terminal" }> = {
        type: "subscribe_terminal",
        paneId: str(input, "pane"),
        cols: num(input, "cols", 80),
        rows: num(input, "rows", 24),
      };
      const takeover = bool(input, "takeover");
      if (takeover !== undefined) frame.takeover = takeover;
      const writable = bool(input, "writable");
      if (writable !== undefined) frame.writable = writable;
      entry.session.handleFrame(frame);
      await settle();
      return { conns: entry.clientConns.length };
    },

    async unsubscribe_terminal(input) {
      const entry = requireSession(input);
      entry.session.handleFrame({ type: "unsubscribe_terminal", paneId: str(input, "pane") });
      await settle();
      return { pane: str(input, "pane") };
    },

    async terminal_input(input) {
      const entry = requireSession(input);
      const text = str(input, "text");
      entry.session.handleFrame({
        type: "terminal_input",
        paneId: str(input, "pane"),
        data: Buffer.from(text, "utf8").toString("base64"),
      });
      await settle();
      return { pane: str(input, "pane") };
    },

    async terminal_resize(input) {
      const entry = requireSession(input);
      entry.session.handleFrame({
        type: "terminal_resize",
        paneId: str(input, "pane"),
        cols: num(input, "cols", 80),
        rows: num(input, "rows", 24),
      });
      await settle();
      return { pane: str(input, "pane") };
    },

    async terminal_scroll(input) {
      const entry = requireSession(input);
      entry.session.handleFrame({
        type: "terminal_scroll",
        paneId: str(input, "pane"),
        direction: str(input, "direction", "up") === "down" ? "down" : "up",
        ...(input["lines"] !== undefined ? { lines: num(input, "lines", 3) } : {}),
      });
      await settle();
      return { pane: str(input, "pane") };
    },

    async terminal_mouse(input) {
      const entry = requireSession(input);
      const action = str(input, "action", "press");
      entry.session.handleFrame({
        type: "terminal_mouse",
        paneId: str(input, "pane"),
        action: (["press", "motion", "release", "moved"].includes(action) ? action : "press") as
          | "press" | "motion" | "release" | "moved",
        button: (["left", "middle", "right"].includes(str(input, "button")) ? str(input, "button") : null) as
          | "left" | "middle" | "right" | null,
        column: num(input, "column", 1),
        row: num(input, "row", 1),
      });
      await settle();
      return { pane: str(input, "pane") };
    },

    async rpc(input) {
      const entry = requireSession(input);
      const id = str(input, "id", `harness-${Math.random().toString(36).slice(2)}`);
      entry.session.handleFrame({
        type: "rpc",
        id,
        method: str(input, "method") as never,
        params: (input["params"] ?? {}) as Record<string, unknown>,
      });
      await settle();
      return { id };
    },

    async deliver_welcome(input) {
      const conn = requireSession(input).clientConns[num(input, "conn", 0)];
      if (!conn) throw new Error(`deliver_welcome: no client conn ${num(input, "conn", 0)}`);
      conn.handlers.data(welcomeFrame(num(input, "version", 22)));
      await settle();
      return { welcomed: true };
    },

    async deliver_terminal(input) {
      const conn = requireSession(input).clientConns[num(input, "conn", 0)];
      if (!conn) throw new Error(`deliver_terminal: no client conn ${num(input, "conn", 0)}`);
      conn.handlers.data(terminalFrame(str(input, "text"), num(input, "seq", 1)));
      await settle();
      return { delivered: true };
    },

    async deliver_shutdown(input) {
      const conn = requireSession(input).clientConns[num(input, "conn", 0)];
      if (!conn) throw new Error(`deliver_shutdown: no client conn ${num(input, "conn", 0)}`);
      conn.handlers.data(shutdownFrame());
      await settle();
      return { shutdown: true };
    },

    async close_client_conn(input) {
      const conn = requireSession(input).clientConns[num(input, "conn", 0)];
      if (!conn) throw new Error(`close_client_conn: no client conn ${num(input, "conn", 0)}`);
      // Peer-side drop: the socket is gone, so the stream is ended too —
      // the link cannot send a Detach afterwards (matches a real reset).
      conn.handlers.close?.();
      conn.stream.end();
      await settle();
      return { closed: true };
    },

    async inject_event(input) {
      // Deliver one events.subscribe event line on the most recently opened
      // subscription connection — the live one herdr would push on.
      const subs = apiConns.filter((c) => c.requests.some((r) => r.method === "events.subscribe"));
      const conn = subs.at(-1);
      if (!conn) throw new Error("inject_event: no events.subscribe connection");
      conn.handlers.data(
        encoder.encode(
          `${JSON.stringify({ event: str(input, "event", "pane.updated"), data: input["data"] ?? {} })}\n`,
        ),
      );
      await sleep(200); // past the 120 ms snapshot debounce
      return { injected: str(input, "event", "pane.updated") };
    },

    async set_detail(input) {
      const entry = requireSession(input);
      entry.session.setDetail(str(input, "detail", "full") as SnapshotDetail);
      await sleep(200);
      return { detail: str(input, "detail") };
    },

    async sleep(input) {
      await sleep(num(input, "ms", 50));
      return { slept: num(input, "ms", 50) };
    },

    async bridge_state() {
      const now = metricsSnapshot();
      const meterDelta = (name: string) => {
        const cur = Object.entries(now.meters ?? {})
          .filter(([k]) => k === name || k.startsWith(`${name}{`))
          .reduce((n, [, m]) => n + m.total, 0);
        return Math.round((cur - meterBase(name)) * 100) / 100;
      };
      const counterDelta = (name: string) => {
        const cur = Object.entries(now.counters)
          .filter(([k]) => k === name || k.startsWith(`${name}{`))
          .reduce((n, [, v]) => n + v, 0);
        return cur - counterBase(name);
      };
      const allRequests = apiConns.flatMap((c) => c.requests);
      const subscribeRequests = allRequests.filter((r) => r.method === "events.subscribe");
      const scrollFilters = (req: { params?: Record<string, unknown> } | undefined) =>
        (((req?.params?.["subscriptions"] as { type?: string; pane_id?: string }[] | undefined) ?? [])
          .filter((s) => s.type === "pane.scroll_changed")
          .map((s) => s.pane_id)
          .sort());
      return {
        sessions: Object.fromEntries(
          [...sessions.entries()].map(([name, entry]) => [
            name,
            {
              conns: entry.clientConns.map((conn, index) => {
                const variants = clientPayloads(conn.stream).map(frameVariant);
                return {
                  index,
                  mode: connMode(variants),
                  variants,
                  inputs: clientInputs(conn.stream),
                  takeovers: attachTakeovers(conn.stream),
                  detached: variants.includes(4),
                  ended: conn.stream.ended,
                };
              }),
              frames: entry.frames.map((f) => f.type),
              // Detail marker + stripped-payload evidence per ready/snapshot
              // push, in order: summary mode must deliver structure/agent
              // status with layouts and pane scroll state removed (#585).
              push_details: entry.frames
                .filter((f) => f.type === "ready" || f.type === "snapshot")
                .map((f) => {
                  if (f.type !== "ready" && f.type !== "snapshot") return { detail: "full", layouts: 0, scroll_panes: 0 };
                  return {
                    detail: f.detail ?? "full",
                    layouts: f.snapshot.layouts.length,
                    scroll_panes: f.snapshot.panes.filter((p) => p.scroll !== undefined).length,
                  };
                }),
            },
          ]),
        ),
        api: {
          methods: allRequests.map((r) => r.method ?? "?"),
          counts: allRequests.reduce<Record<string, number>>((acc, r) => {
            const m = r.method ?? "?";
            acc[m] = (acc[m] ?? 0) + 1;
            return acc;
          }, {}),
          subscribe_requests: subscribeRequests.length,
          // pane.scroll_changed coverage of the LIVE (latest) subscription —
          // the delivery contract for viewport traffic (issues #569/#585).
          scroll_filters: scrollFilters(subscribeRequests.at(-1)),
          scroll_filters_ever: [
            ...new Set(subscribeRequests.flatMap((r) => scrollFilters(r))),
          ].sort(),
        },
        metrics: {
          delivery_bytes: meterDelta("terminal.delivery.bytes"),
          attach: counterDelta("bridge.terminal.attach"),
          detach: counterDelta("bridge.terminal.detach"),
          op_input: counterDelta("bridge.terminal.op{op=input}"),
          op_scroll: counterDelta("bridge.terminal.op{op=scroll}"),
          op_resize: counterDelta("bridge.terminal.op{op=resize}"),
          op_mouse: counterDelta("bridge.terminal.op{op=mouse}"),
          subscription_open: counterDelta("bridge.subscription.open"),
          snapshot_push: counterDelta("bridge.snapshot.push"),
        },
      };
    },
  };

  return {
    name: "ts",
    ops: BRIDGE_OPS,
    async run(op, input) {
      const fn = ops[op];
      if (!fn) return { ok: false, error: `bridge adapter: unknown op "${op}"` };
      try {
        return { ok: true, value: await fn(input) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
