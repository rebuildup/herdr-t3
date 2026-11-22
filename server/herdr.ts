/**
 * Minimal herdr RPC client.
 *
 * Wire protocol (herdr API schema, protocol 22 — see docs/upstream.md):
 * newline-delimited JSON over a unix socket (Windows: named pipe behind the
 * `herdr.sock` marker file). One request per connection; herdr closes the
 * socket after each answer. `events.subscribe` is the only long-lived call.
 *
 * Semantics are reimplemented from the proven Ovis bridge
 * (server/herdr/client.ts @ e16802a2f); see THIRD_PARTY_NOTICES.md.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { connectSocket } from "./socket.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Per-line ceilings. herdr sets no finite max; these bound what we accept. */
export const LARGE_REPLY_BYTES = 64 * 1024 * 1024;
export const LINE_BYTES = 16 * 1024 * 1024;
const LARGE_REPLY_METHODS = new Set(["pane.read", "pane.selection.read", "session.snapshot"]);

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/** herdr's default socket: ~/.config/herdr on Unix, %APPDATA%\herdr on Windows. */
export function herdrSocketPath(env: Record<string, string | undefined> = process.env): string {
  if (env["HERDR_SOCKET"]) return env["HERDR_SOCKET"];
  if (process.platform === "win32") return `${env["APPDATA"] ?? ""}\\herdr\\herdr.sock`;
  return join(env["HOME"] ?? homedir(), ".config", "herdr", "herdr.sock");
}

/**
 * On Windows herdr.sock is a marker file (`pid:start`) and the server listens
 * on a named pipe of the same name: \\.\pipe\C:\Users\…\herdr.sock.
 */
export function socketAddress(socketPath: string): string {
  return process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\")
    ? `\\\\.\\pipe\\${socketPath}`
    : socketPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `ht3-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Split a stream of bytes into JSON lines, enforcing a per-line byte ceiling.
 * `onLine` gets the decoded line and its byte length; `onOverflow` fires once
 * and ends the stream.
 */
export function makeLineReader(
  maxBytes: number,
  onLine: (line: string, bytes: number) => void,
  onOverflow: (bytes: number) => void,
): (chunk: Uint8Array) => void {
  let pending = new Uint8Array(0);
  let lineStart = 0;
  let overflowed = false;
  return (chunk) => {
    if (overflowed) return;
    const merged = new Uint8Array(pending.length - lineStart + chunk.length);
    merged.set(pending.subarray(lineStart));
    merged.set(chunk, pending.length - lineStart);
    pending = merged;
    lineStart = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, lineStart);
      if (nl === -1) break;
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

type Reply = { result: unknown } | { error: { code: string; message: string } };

/**
 * The reply to request `id` in a parsed line, or why the line is not one.
 * Envelope: object with string `id`, exactly one of `result`/`error`.
 * herdr 0.9.0/0.9.1 answered errors with an empty id or `<id>:sub:<n>:probe`;
 * one connection carries one request, so such an error can only answer it.
 */
function readReply(frame: unknown, id: string): Reply | string {
  if (!isRecord(frame)) return "not an object";
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  const replyId = frame["id"];
  const olderErrorId =
    hasError && !hasResult &&
    (replyId === "" || (typeof replyId === "string" && replyId.startsWith(`${id}:sub:`)));
  if (replyId !== id && !olderErrorId) return "reply to another request";
  if (hasResult === hasError) return hasResult ? "both result and error" : "neither result nor error";
  if (hasResult) return { result: frame["result"] };
  const error = frame["error"];
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
    return "malformed error";
  }
  return { error: { code: error["code"], message: error["message"] } };
}

export interface RpcOptions {
  timeoutMs?: number;
  socketPath?: string;
}

/**
 * One RPC call: open a connection, write one request line, read until the
 * matching reply, close. herdr closes the socket after each answer, so the
 * connection is never reused.
 */
export function herdrRpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  options: RpcOptions = {},
): Promise<T> {
  const socketPath = options.socketPath ?? herdrSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = nextId();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let socket: Socket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.end();
      } catch {
        /* already closed */
      }
      fn();
    };

    timer = setTimeout(
      () => finish(() => reject(new HerdrError("timeout", `herdr ${method} timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    const invalid = (reason: string, bytes: number) =>
      finish(() => reject(new HerdrError("bad_frame", `herdr sent an invalid reply to ${method} (${reason}, ${bytes} bytes)`)));

    const limit = LARGE_REPLY_METHODS.has(method) ? LARGE_REPLY_BYTES : LINE_BYTES;
    const onData = makeLineReader(limit, (line, _bytes) => {
      if (settled) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        invalid("unparseable frame", line.length);
        return;
      }
      const reply = readReply(frame, id);
      if (typeof reply === "string") invalid(reply, Buffer.byteLength(line));
      else if ("error" in reply) finish(() => reject(new HerdrError(reply.error.code, reply.error.message)));
      else finish(() => resolve(reply.result as T));
    }, (bytes) => invalid(`over the ${limit}-byte line limit`, bytes));

    const request = `${JSON.stringify({ id, method, params })}\n`;
    connectSocket(socketAddress(socketPath), {
      data: (chunk) => onData(chunk),
      error: (err) => {
        finish(() => reject(new HerdrError("socket_error", err.message)));
      },
      close: () => {
        finish(() => reject(new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
      },
    }).then((sock) => {
      socket = sock;
      if (settled) {
        try {
          sock.end();
        } catch {
          /* already closed */
        }
        return;
      }
      try {
        sock.write(request);
      } catch (error) {
        finish(() => reject(new HerdrError("socket_error", (error as Error)?.message ?? "herdr socket error")));
      }
    }, (err: Error) =>
      finish(() => reject(new HerdrError("connect_failed", `cannot reach herdr at ${socketPath}: ${err.message}`))));
  });
}

export interface EventFrame {
  event?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SubscribeHandlers {
  onEvent: (frame: EventFrame) => void;
  onStarted?: () => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface Subscription {
  close: () => void;
}

/**
 * Long-lived `events.subscribe` connection. Streams `{event, data}` frames
 * until closed. Reopen with the full subscription set after a drop — a second
 * subscribe on the same connection is ignored by herdr.
 */
export function subscribeEvents(
  subscriptions: Record<string, unknown>[],
  handlers: SubscribeHandlers,
  socketPath: string = herdrSocketPath(),
): Subscription {
  let closed = false;
  let socket: Socket | null = null;
  let started = false;
  const id = nextId();

  const invalid = (reason: string, bytes: number) => {
    if (closed) return;
    closed = true;
    try {
      handlers.onError?.(new HerdrError("bad_frame", `herdr sent an invalid events.subscribe frame (${reason}, ${bytes} bytes)`));
    } finally {
      try {
        socket?.end();
      } catch {
        /* already closed */
      }
      handlers.onClose?.();
    }
  };

  const onData = makeLineReader(LINE_BYTES, (line, bytes) => {
    if (closed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      invalid("unparseable frame", bytes);
      return;
    }
    // Before `started`, frames are the subscribe reply; after, a string
    // `event` marks an event frame whatever else it carries.
    const isEvent = started && isRecord(frame) && typeof frame["event"] === "string";
    if (!started || (!isEvent && isRecord(frame) && Object.hasOwn(frame, "error"))) {
      const reply = readReply(frame, id);
      if (typeof reply === "string") invalid(reply, bytes);
      else if ("error" in reply) handlers.onError?.(new HerdrError(reply.error.code, reply.error.message));
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
    handlers.onEvent(frame as EventFrame);
  }, (bytes) => invalid(`over the ${LINE_BYTES}-byte line limit`, bytes));

  connectSocket(socketAddress(socketPath), {
    data: (chunk) => onData(chunk),
    error: (err) => {
      if (!closed) handlers.onError?.(new HerdrError("socket_error", err.message));
    },
    close: () => {
      if (!closed) {
        closed = true;
        handlers.onClose?.();
      }
    },
  })
    .then((sock) => {
      socket = sock;
      if (closed) {
        try {
          sock.end();
        } catch {
          /* already closed */
        }
        return;
      }
      sock.write(
        new TextEncoder().encode(
          `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
        ),
      );
    })
    .catch((err: Error) => {
      handlers.onError?.(new HerdrError("connect_failed", err.message));
      if (!closed) {
        closed = true;
        handlers.onClose?.();
      }
    });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        socket?.end();
      } catch {
        /* already closed */
      }
    },
  };
}
