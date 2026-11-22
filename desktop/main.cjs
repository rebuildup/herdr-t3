// desktop/main.ts
var import_electron = require("electron");
var import_node_path2 = require("node:path");
var import_node_url = require("node:url");

// shared/protocol.ts
var RPC_METHODS = [
  "session.snapshot",
  "workspace.create",
  "workspace.focus",
  "workspace.close",
  "workspace.rename",
  "workspace.move",
  "tab.create",
  "tab.focus",
  "tab.close",
  "tab.rename",
  "tab.move",
  "pane.split",
  "pane.close",
  "pane.focus",
  "pane.rename",
  "pane.zoom",
  "pane.resize",
  "pane.move",
  "pane.swap",
  "pane.scroll",
  "pane.clear",
  "layout.set_split_ratio",
  "pane.send_text",
  "pane.send_keys",
  "agent.get",
  "agent.prompt",
  "agent.rename",
  "agent.start"
];
function isRpcMethod(method) {
  return RPC_METHODS.includes(method);
}

// server/herdr.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var DEFAULT_TIMEOUT_MS = 1e4;
var LARGE_REPLY_BYTES = 64 * 1024 * 1024;
var LINE_BYTES = 16 * 1024 * 1024;
var LARGE_REPLY_METHODS = new Set(["pane.read", "pane.selection.read", "session.snapshot"]);

class HerdrError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}
function herdrSocketPath(env = process.env) {
  if (env["HERDR_SOCKET"])
    return env["HERDR_SOCKET"];
  if (process.platform === "win32")
    return `${env["APPDATA"] ?? ""}\\herdr\\herdr.sock`;
  return import_node_path.join(env["HOME"] ?? import_node_os.homedir(), ".config", "herdr", "herdr.sock");
}
function socketAddress(socketPath) {
  return process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var requestCounter = 0;
function nextId() {
  requestCounter += 1;
  return `ht3-${Date.now().toString(36)}-${requestCounter}`;
}
function makeLineReader(maxBytes, onLine, onOverflow) {
  let pending = new Uint8Array(0);
  let lineStart = 0;
  let overflowed = false;
  return (chunk) => {
    if (overflowed)
      return;
    const merged = new Uint8Array(pending.length - lineStart + chunk.length);
    merged.set(pending.subarray(lineStart));
    merged.set(chunk, pending.length - lineStart);
    pending = merged;
    lineStart = 0;
    for (;; ) {
      const nl = pending.indexOf(10, lineStart);
      if (nl === -1)
        break;
      const lineBytes = nl - lineStart;
      if (lineBytes > maxBytes) {
        overflowed = true;
        onOverflow(lineBytes);
        return;
      }
      const line = new TextDecoder().decode(pending.subarray(lineStart, nl));
      onLine(line, lineBytes);
      lineStart = nl + 1;
    }
    if (lineStart > 0 && lineStart === pending.length) {
      pending = new Uint8Array(0);
      lineStart = 0;
    } else if (lineStart > 64 * 1024) {
      pending = pending.slice(lineStart);
      lineStart = 0;
    }
    const buffered = pending.length - lineStart;
    if (buffered > maxBytes) {
      overflowed = true;
      onOverflow(buffered);
    }
  };
}
function readReply(frame, id) {
  if (!isRecord(frame))
    return "not an object";
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  const replyId = frame["id"];
  const olderErrorId = hasError && !hasResult && (replyId === "" || typeof replyId === "string" && replyId.startsWith(`${id}:sub:`));
  if (replyId !== id && !olderErrorId)
    return "reply to another request";
  if (hasResult === hasError)
    return hasResult ? "both result and error" : "neither result nor error";
  if (hasResult)
    return { result: frame["result"] };
  const error = frame["error"];
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
    return "malformed error";
  }
  return { error: { code: error["code"], message: error["message"] } };
}
function herdrRpc(method, params, options = {}) {
  const socketPath = options.socketPath ?? herdrSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = nextId();
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const finish = (fn) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      try {
        socket?.end();
      } catch {}
      fn();
    };
    timer = setTimeout(() => finish(() => reject(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`))), timeoutMs);
    const invalid = (reason, bytes) => finish(() => reject(new HerdrError("bad_frame", `herdr sent an invalid reply to ${method} (${reason}, ${bytes} bytes)`)));
    const limit = LARGE_REPLY_METHODS.has(method) ? LARGE_REPLY_BYTES : LINE_BYTES;
    const onData = makeLineReader(limit, (line, _bytes) => {
      if (settled)
        return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        invalid("unparseable frame", line.length);
        return;
      }
      const reply = readReply(frame, id);
      if (typeof reply === "string")
        invalid(reply, Buffer.byteLength(line));
      else if ("error" in reply)
        finish(() => reject(new HerdrError(reply.error.code, reply.error.message)));
      else
        finish(() => resolve(reply.result));
    }, (bytes) => invalid(`over the ${limit}-byte line limit`, bytes));
    Bun.connect({
      unix: socketAddress(socketPath),
      socket: {
        data(_sock, chunk) {
          onData(chunk);
        },
        drain() {
          writeRequest();
        },
        error(_sock, err) {
          finish(() => reject(new HerdrError("socket_error", err?.message ?? "herdr socket error")));
        },
        close() {
          finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
        }
      }
    }).then((sock) => {
      socket = sock;
      if (settled) {
        try {
          sock.end();
        } catch {}
        return;
      }
      writeRequest();
    }, (err) => finish(() => reject(new HerdrError("connect_failed", `cannot reach herdr at ${socketPath}: ${err.message}`))));
    function writeRequest() {
      if (settled || socket === null)
        return;
      try {
        const accepted = socket.write(new TextEncoder().encode(`${JSON.stringify({ id, method, params })}
`));
        if (accepted === -1) {
          finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
        }
      } catch (error) {
        finish(() => reject(new HerdrError("socket_error", error?.message ?? "herdr socket error")));
      }
    }
  });
}
function subscribeEvents(subscriptions, handlers, socketPath = herdrSocketPath()) {
  let closed = false;
  let socket = null;
  let started = false;
  const id = nextId();
  const invalid = (reason, bytes) => {
    if (closed)
      return;
    closed = true;
    try {
      handlers.onError?.(new HerdrError("bad_frame", `herdr sent an invalid events.subscribe frame (${reason}, ${bytes} bytes)`));
    } finally {
      try {
        socket?.end();
      } catch {}
      handlers.onClose?.();
    }
  };
  const onData = makeLineReader(LINE_BYTES, (line, bytes) => {
    if (closed)
      return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      invalid("unparseable frame", bytes);
      return;
    }
    const isEvent = started && isRecord(frame) && typeof frame["event"] === "string";
    if (!started || !isEvent && isRecord(frame) && Object.hasOwn(frame, "error")) {
      const reply = readReply(frame, id);
      if (typeof reply === "string")
        invalid(reply, bytes);
      else if ("error" in reply)
        handlers.onError?.(new HerdrError(reply.error.code, reply.error.message));
      else if (started || !isRecord(reply.result) || reply.result["type"] !== "subscription_started") {
        invalid("unexpected acknowledgement", bytes);
      } else {
        started = true;
        handlers.onStarted?.();
      }
      return;
    }
    if (!isRecord(frame) || typeof frame["event"] !== "string" || !isRecord(frame["data"])) {
      invalid("malformed event", bytes);
      return;
    }
    handlers.onEvent(frame);
  }, (bytes) => invalid(`over the ${LINE_BYTES}-byte line limit`, bytes));
  Bun.connect({
    unix: socketAddress(socketPath),
    socket: {
      data(_sock, chunk) {
        onData(chunk);
      },
      error(_sock, err) {
        if (!closed)
          handlers.onError?.(new HerdrError("socket_error", err?.message ?? "herdr socket error"));
      },
      close() {
        if (!closed) {
          closed = true;
          handlers.onClose?.();
        }
      }
    }
  }).then((sock) => {
    socket = sock;
    if (closed) {
      try {
        sock.end();
      } catch {}
      return;
    }
    sock.write(new TextEncoder().encode(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}
`));
  }).catch((err) => {
    handlers.onError?.(new HerdrError("connect_failed", err.message));
    if (!closed) {
      closed = true;
      handlers.onClose?.();
    }
  });
  return {
    close() {
      if (closed)
        return;
      closed = true;
      try {
        socket?.end();
      } catch {}
    }
  };
}

// server/client-link.ts
var CLIENT_PROTOCOL_VERSION = 22;
var MAX_FRAME_SIZE = 2 * 1024 * 1024;
var MAX_SERVER_FRAME_SIZE = 32 * 1024 * 1024;
function encodeVarint(value) {
  const v = BigInt(value);
  if (v <= 250n)
    return [Number(v)];
  if (v <= 0xffffn)
    return [251, Number(v & 0xffn), Number(v >> 8n & 0xffn)];
  if (v <= 0xffffffffn)
    return [252, ...u32le(Number(v))];
  return [253, ...u64le(v)];
}
function u32le(n) {
  return [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
}
function u64le(v) {
  const out = [];
  for (let i = 0n;i < 8n; i++)
    out.push(Number(v >> i * 8n & 0xffn));
  return out;
}
function decodeVarint(buf, offset) {
  const tag = buf[offset];
  if (tag === undefined)
    throw new Error("truncated varint");
  if (tag <= 250)
    return [BigInt(tag), offset + 1];
  const width = tag === 251 ? 2 : tag === 252 ? 4 : tag === 253 ? 8 : tag === 254 ? 16 : 0;
  if (width === 0)
    throw new Error(`unknown varint tag ${tag}`);
  if (offset + 1 + width > buf.length)
    throw new Error("truncated varint payload");
  let value = 0n;
  for (let i = 0;i < width; i++)
    value |= BigInt(buf[offset + 1 + i]) << BigInt(i * 8);
  return [value, offset + 1 + width];
}
var vi = encodeVarint;
var vb = (b) => [...vi(b.length), ...b];
var vs = (s) => vb(new TextEncoder().encode(s));
var vu8 = (b) => [b ? 1 : 0];
function terminalHello(cols, rows) {
  return [
    ...vi(0),
    ...vi(CLIENT_PROTOCOL_VERSION),
    ...vi(cols),
    ...vi(rows),
    ...vi(0),
    ...vi(0),
    ...vu8(false)
  ];
}
function clientInput(data) {
  return [...vi(1), ...vb(data)];
}
function clientResize(cols, rows) {
  return [
    ...vi(3),
    ...vi(cols),
    ...vi(rows),
    ...vi(0),
    ...vi(0),
    ...vu8(false)
  ];
}
function clientDetach() {
  return [...vi(4)];
}
function msgAttachTerminal(terminalId, takeover) {
  return [...vi(5), ...vs(terminalId), ...vu8(takeover)];
}
function attachScroll(direction, lines) {
  return [
    ...vi(6),
    ...vi(0),
    ...vi(direction === "up" ? 0 : 1),
    ...vi(lines),
    0,
    0,
    ...vi(0)
  ];
}
function frame(payload) {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}
function readOptionString(buf, offset) {
  const tag = buf[offset];
  if (tag === undefined)
    throw new Error("truncated option");
  if (tag === 0)
    return [null, offset + 1];
  const [value, next] = readString(buf, offset + 1);
  return [value, next];
}
function readString(buf, offset) {
  const [len, after] = decodeVarint(buf, offset);
  const end = after + Number(len);
  if (end > buf.length)
    throw new Error("truncated string");
  return [new TextDecoder().decode(buf.subarray(after, end)), end];
}
function decodeServerMessage(payload) {
  const [variant, offset] = decodeVarint(payload, 0);
  const v = Number(variant);
  try {
    switch (v) {
      case 0: {
        let o = offset;
        const [version, o1] = decodeVarint(payload, o);
        o = o1;
        const [encoding, o2] = decodeVarint(payload, o);
        o = o2;
        const [error, o3] = readOptionString(payload, o);
        return { type: "welcome", version: Number(version), terminalAnsi: Number(encoding) === 1, error };
      }
      case 1: {
        let o = offset;
        const [seq, o1] = decodeVarint(payload, o);
        o = o1;
        const [width, o2] = decodeVarint(payload, o);
        o = o2;
        const [height, o3] = decodeVarint(payload, o);
        o = o3;
        const full = payload[o] === 1;
        o += 1;
        const [len, o4] = decodeVarint(payload, o);
        o = o4;
        const end = o + Number(len);
        if (end > payload.length)
          throw new Error("truncated terminal bytes");
        return { type: "terminal", seq: Number(seq), width: Number(width), height: Number(height), full, bytes: payload.slice(o, end) };
      }
      case 3: {
        const [reason] = readOptionString(payload, offset);
        return { type: "shutdown", reason };
      }
      default:
        return { type: "other", variant: v };
    }
  } catch (error) {
    throw new Error(`bad server frame (variant ${v}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
function clientSocketPath(env = process.env) {
  if (env["HERDR_CLIENT_SOCKET_PATH"])
    return env["HERDR_CLIENT_SOCKET_PATH"];
  const api = herdrSocketPath(env);
  const slash = Math.max(api.lastIndexOf("/"), api.lastIndexOf("\\"));
  const dir = slash === -1 ? "" : api.slice(0, slash + 1);
  const base = slash === -1 ? api : api.slice(slash + 1);
  const stem = base.replace(/\.sock$/i, "");
  return `${dir}${stem}-client.sock`;
}
function openTerminalLink(terminalId, options, handlers) {
  const socketPath = options.socketPath ?? clientSocketPath();
  return new Promise((resolve, reject) => {
    let settled = false;
    let welcomed = false;
    let sock = null;
    let buffer = new Uint8Array(0);
    let closed = false;
    const finish = (fn) => {
      if (settled)
        return;
      settled = true;
      fn();
    };
    const send = (payload) => {
      try {
        sock?.write(frame(payload));
      } catch {}
    };
    const pump = () => {
      for (;; ) {
        if (buffer.length < 4)
          return;
        const len = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true);
        if (len > MAX_SERVER_FRAME_SIZE) {
          handlers.onClose("frame too large");
          try {
            sock?.end();
          } catch {}
          return;
        }
        if (buffer.length < 4 + len)
          return;
        const payload = buffer.subarray(4, 4 + len);
        buffer = buffer.slice(4 + len);
        let event;
        try {
          event = decodeServerMessage(payload);
        } catch (error) {
          handlers.onClose(error instanceof Error ? error.message : String(error));
          try {
            sock?.end();
          } catch {}
          return;
        }
        if (!welcomed) {
          if (event.type !== "welcome") {
            handlers.onClose("expected Welcome");
            try {
              sock?.end();
            } catch {}
            return;
          }
          welcomed = true;
          if (event.error !== null) {
            finish(() => reject(new Error(`herdr refused the client handshake: ${event.error}`)));
            try {
              sock?.end();
            } catch {}
            return;
          }
          if (!event.terminalAnsi) {
            finish(() => reject(new Error("herdr did not select TerminalAnsi encoding for this client")));
            try {
              sock?.end();
            } catch {}
            return;
          }
          send(msgAttachTerminal(terminalId, options.takeover ?? false));
          const link = {
            terminalId,
            write: (data) => send(clientInput(data)),
            resize: (cols, rows) => send(clientResize(cols, rows)),
            scroll: (direction, lines = 3) => send(attachScroll(direction, lines)),
            close: () => {
              if (closed)
                return;
              closed = true;
              send(clientDetach());
              try {
                sock?.end();
              } catch {}
            }
          };
          finish(() => resolve(link));
          continue;
        }
        if (closed)
          continue;
        handlers.onEvent(event);
      }
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        data(_sock, chunk) {
          const merged = new Uint8Array(buffer.length + chunk.length);
          merged.set(buffer);
          merged.set(chunk, buffer.length);
          buffer = merged;
          pump();
        },
        error(_sock, err) {
          if (!welcomed)
            finish(() => reject(new Error(`herdr client socket error: ${err?.message ?? "unknown"}`)));
          else if (!closed)
            handlers.onClose(err?.message ?? "socket error");
        },
        close() {
          if (!welcomed)
            finish(() => reject(new Error("herdr closed the client socket during handshake")));
          else if (!closed)
            handlers.onClose("socket closed");
        }
      }
    }).then((s) => {
      sock = s;
      if (settled || closed) {
        try {
          s.end();
        } catch {}
        return;
      }
      send(terminalHello(options.cols, options.rows));
    }, (err) => {
      finish(() => reject(new Error(`cannot reach herdr client socket at ${socketPath}: ${err.message}`)));
    });
  });
}

// server/bridge-core.ts
var STRUCTURE_SUBSCRIPTIONS = [
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
  { type: "layout.updated" }
];
function statusSubscriptions(snapshot) {
  return snapshot.panes.map((pane) => ({ type: "pane.agent_status_changed", pane_id: pane.pane_id }));
}
async function fetchSnapshot() {
  const result = await herdrRpc("session.snapshot", {});
  return result.snapshot;
}
function pushSnapshot(state) {
  fetchSnapshot().then((snapshot) => {
    state.snapshot = snapshot;
    state.send({ type: "snapshot", snapshot });
    reconcileSubscriptions(state, snapshot);
  }).catch(() => {});
}
function reconcileSubscriptions(state, snapshot) {
  const ids = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const same = state.subscribedPaneIds.size === ids.size && [...ids].every((id) => state.subscribedPaneIds.has(id));
  if (same)
    return;
  state.subscription?.close();
  state.subscription = openSubscription(state, snapshot);
}
function openSubscription(state, snapshot) {
  state.subscribedPaneIds = new Set(snapshot.panes.map((pane) => pane.pane_id));
  return subscribeEvents([...STRUCTURE_SUBSCRIPTIONS, ...statusSubscriptions(snapshot)], {
    onEvent: (frame) => {
      state.send({ type: "event", event: frame });
      scheduleSnapshot(state);
    },
    onError: () => scheduleSnapshot(state),
    onClose: () => {
      state.subscription = null;
      state.subscribedPaneIds = new Set;
      scheduleSnapshot(state);
      state.pushTimer = setTimeout(() => {
        state.pushTimer = null;
        fetchSnapshot().then((snapshot) => {
          state.send({ type: "snapshot", snapshot });
          state.subscription = openSubscription(state, snapshot);
        }).catch(() => {});
      }, 2000);
    }
  });
}
function scheduleSnapshot(state) {
  if (state.snapshotTimer !== null)
    return;
  state.snapshotTimer = setTimeout(() => {
    state.snapshotTimer = null;
    pushSnapshot(state);
  }, 120);
}
function dropTerminal(state, paneId, slot, reason) {
  if (slot.gone)
    return;
  slot.gone = true;
  if (state.terminals.get(paneId) === slot)
    state.terminals.delete(paneId);
  state.send({ type: "terminal_closed", paneId, reason });
}
function ensureTerminal(state, paneId, cols, rows) {
  const existing = state.terminals.get(paneId);
  if (existing) {
    existing.refs += 1;
    return existing;
  }
  const slot = { refs: 1, link: null, queue: [], gone: false };
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
      if (slot.gone)
        return;
      if (event.type === "terminal") {
        state.send({ type: "terminal_data", paneId, data: Buffer.from(event.bytes).toString("base64") });
      } else if (event.type === "shutdown") {
        dropTerminal(state, paneId, slot, event.reason ?? "herdr_shutdown");
        slot.link?.close();
      }
    },
    onClose: (reason) => {
      dropTerminal(state, paneId, slot, reason);
    }
  }).then((link) => {
    if (slot.gone) {
      link.close();
      return;
    }
    slot.link = link;
    for (const op of slot.queue.splice(0))
      op();
  }).catch((error) => {
    dropTerminal(state, paneId, slot, error instanceof Error ? error.message : String(error));
  });
  return slot;
}
function releaseTerminal(state, paneId) {
  const slot = state.terminals.get(paneId);
  if (!slot)
    return;
  slot.refs -= 1;
  if (slot.refs > 0)
    return;
  state.terminals.delete(paneId);
  slot.gone = true;
  slot.link?.close();
}
function handleClientFrame(state, frame) {
  switch (frame.type) {
    case "rpc": {
      if (!isRpcMethod(frame.method)) {
        state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: "method_not_allowed", message: frame.method } });
        return;
      }
      herdrRpc(frame.method, frame.params ?? {}).then((result) => {
        state.send({ type: "rpc_result", id: frame.id, ok: true, result });
        scheduleSnapshot(state);
      }).catch((error) => {
        const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
        state.send({ type: "rpc_result", id: frame.id, ok: false, error: { code: err.code, message: err.message } });
      });
      return;
    }
    case "subscribe_terminal":
      ensureTerminal(state, frame.paneId, frame.cols ?? 80, frame.rows ?? 24);
      return;
    case "unsubscribe_terminal":
      releaseTerminal(state, frame.paneId);
      return;
    case "terminal_input": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone)
        return;
      const bytes = new TextEncoder().encode(frame.data);
      const write = () => slot.link?.write(bytes);
      if (slot.link)
        write();
      else
        slot.queue.push(write);
      return;
    }
    case "terminal_resize": {
      const slot = state.terminals.get(frame.paneId);
      if (!slot || slot.gone)
        return;
      const resize = () => slot.link?.resize(frame.cols, frame.rows);
      if (slot.link)
        resize();
      else
        slot.queue.push(resize);
      return;
    }
  }
}
function createBridgeSession(send) {
  const state = {
    send,
    subscription: null,
    subscribedPaneIds: new Set,
    snapshotTimer: null,
    pushTimer: null,
    snapshot: null,
    terminals: new Map
  };
  return {
    handleFrame: (frame) => handleClientFrame(state, frame),
    start: () => fetchSnapshot().then((snapshot) => {
      state.snapshot = snapshot;
      state.send({ type: "ready", snapshot });
      state.subscription = openSubscription(state, snapshot);
    }).catch((error) => {
      const err = error instanceof HerdrError ? error : new HerdrError("bridge_error", String(error));
      state.send({ type: "rpc_result", id: "boot", ok: false, error: { code: err.code, message: err.message } });
    }),
    close: () => {
      state.subscription?.close();
      if (state.snapshotTimer)
        clearTimeout(state.snapshotTimer);
      if (state.pushTimer)
        clearTimeout(state.pushTimer);
      for (const [paneId, slot] of state.terminals) {
        slot.gone = true;
        slot.link?.close();
        state.terminals.delete(paneId);
      }
    }
  };
}

// desktop/main.ts
var DEV_URL = process.env["HERDR_T3_DEV_URL"];
var IS_DEV = Boolean(DEV_URL) || !import_electron.app.isPackaged;
if (process.env["HERDR_T3_PROFILE"] === "dev") {
  import_electron.app.setPath("userData", import_node_path2.join(import_electron.app.getPath("appData"), "herdr-t3-dev"));
}
var win = null;
var session = null;
function send(frame) {
  win?.webContents.send("herdr-t3:frame", frame);
}
function createWindow() {
  win = new import_electron.BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "herdr-t3",
    backgroundColor: "#000000",
    webPreferences: {
      preload: import_node_path2.join("/Users/rebui/work/herdr-t3/desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    import_electron.shell.openExternal(url);
    return { action: "deny" };
  });
  const target = DEV_URL ?? import_node_url.pathToFileURL(import_node_path2.join("/Users/rebui/work/herdr-t3/desktop", "..", "dist", "index.html")).toString();
  win.loadURL(target);
}
import_electron.app.whenReady().then(() => {
  session = createBridgeSession(send);
  session.start();
  import_electron.ipcMain.on("herdr-t3:frame", (_event, frame) => {
    session?.handleFrame(frame);
  });
  import_electron.ipcMain.handle("herdr-t3:health", async () => {
    const socket = herdrSocketPath();
    let reachable = false;
    let version;
    let protocol;
    try {
      const snapshot = await fetchSnapshot();
      reachable = true;
      version = snapshot.version;
      protocol = snapshot.protocol;
    } catch (error) {
      reachable = false;
      if (error instanceof HerdrError) {
        return { ok: true, version: "0.1.0", commit: "unknown", herdr: { reachable, socket: socketAddress(socket), error: `${error.code}: ${error.message}` } };
      }
    }
    return {
      ok: true,
      version: "0.1.0",
      commit: process.env["HERDR_T3_COMMIT"] ?? "unknown",
      herdr: { reachable, socket: socketAddress(socket), ...version ? { version } : {}, ...protocol ? { protocol } : {} }
    };
  });
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0)
      createWindow();
  });
});
import_electron.app.on("window-all-closed", () => {
  session?.close();
  session = null;
  if (process.platform !== "darwin")
    import_electron.app.quit();
});
import_electron.app.on("before-quit", () => {
  session?.close();
});
