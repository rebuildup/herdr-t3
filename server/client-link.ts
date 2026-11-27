/**
 * Client for herdr's private client protocol — the same binary protocol the
 * herdr TUI speaks on `herdr-client.sock`. This is the only path that gives a
 * real terminal attach (the JSON socket API has `pane.read` snapshots but no
 * byte stream).
 *
 * Wire format (herdr src/protocol/wire.rs, PROTOCOL_VERSION 22):
 * `[u32 LE length][bincode-2 "standard" payload]`. Integers are varints,
 * strings/vecs are varint-length-prefixed, enum discriminants are u32 varints,
 * bools are one byte, Option is a one-byte tag (0 none / 1 some + value).
 *
 * Only the direct-terminal subset is implemented: TerminalHello, Input,
 * Resize, Detach, AttachTerminal, AttachScroll out; Welcome, Terminal,
 * ServerShutdown and friends in. The client-shell/surface protocol the TUI
 * uses for its own chrome is out of scope — the bridge only needs panes.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { herdrSocketPath, socketAddress } from "./herdr.ts";
import { socketConnector, type Connector, type SocketHandlers } from "./socket.ts";

export const CLIENT_PROTOCOL_VERSION = 22;
const MAX_FRAME_SIZE = 2 * 1024 * 1024;
/** Kitty graphics bulk frames may be larger; we never decode them but must skip them. */
const MAX_SERVER_FRAME_SIZE = 32 * 1024 * 1024;

/* ------------------------- varint / primitives ------------------------- */

/**
 * bincode 2 "standard" varint: values 0–250 are one literal byte; 251/252/253/254
 * tag a fixed-width little-endian u16/u32/u64/u128 that follows.
 */
export function encodeVarint(value: number | bigint): number[] {
  const v = BigInt(value);
  if (v <= 250n) return [Number(v)];
  if (v <= 0xffffn) return [251, Number(v & 0xffn), Number((v >> 8n) & 0xffn)];
  if (v <= 0xffffffffn) return [252, ...u32le(Number(v))];
  return [253, ...u64le(v)];
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (i * 8n)) & 0xffn));
  return out;
}

export function decodeVarint(buf: Uint8Array, offset: number): [bigint, number] {
  const tag = buf[offset];
  if (tag === undefined) throw new Error("truncated varint");
  if (tag <= 250) return [BigInt(tag), offset + 1];
  const width = tag === 251 ? 2 : tag === 252 ? 4 : tag === 253 ? 8 : tag === 254 ? 16 : 0;
  if (width === 0) throw new Error(`unknown varint tag ${tag}`);
  if (offset + 1 + width > buf.length) throw new Error("truncated varint payload");
  let value = 0n;
  for (let i = 0; i < width; i++) value |= BigInt(buf[offset + 1 + i]!) << BigInt(i * 8);
  return [value, offset + 1 + width];
}

const vi = encodeVarint;
const vb = (b: Uint8Array | number[]) => [...vi(b.length), ...b];
const vs = (s: string) => vb(new TextEncoder().encode(s));
const vu8 = (b: boolean) => [b ? 1 : 0];

/* --------------------------- message codecs ---------------------------- */
// ClientMessage variant order (src/protocol/wire.rs):
// 0 TerminalHello, 1 Input, 2 ClipboardImage, 3 Resize, 4 Detach,
// 5 AttachTerminal, 6 AttachScroll, 7 ObserveTerminal, 8 ControlTerminal, ...
// 20 EndpointControl

export function terminalHello(cols: number, rows: number): number[] {
  return [
    ...vi(0), ...vi(CLIENT_PROTOCOL_VERSION), ...vi(cols), ...vi(rows),
    ...vi(0), ...vi(0), // cell size px: unknown to a browser; 0 disables pixel mouse
    ...vu8(false),
  ];
}

export function clientInput(data: Uint8Array): number[] {
  return [...vi(1), ...vb(data)];
}

export function clientResize(cols: number, rows: number): number[] {
  return [
    ...vi(3), ...vi(cols), ...vi(rows),
    ...vi(0), ...vi(0), ...vu8(false),
  ];
}

export function clientDetach(): number[] {
  return [...vi(4)];
}

export function msgAttachTerminal(terminalId: string, takeover: boolean): number[] {
  return [...vi(5), ...vs(terminalId), ...vu8(takeover)];
}

/**
 * ClientMessage::ObserveTerminal (variant 7): read-only stream of the
 * terminal. The server renders into the client's announced cols/rows but
 * never calls runtime.resize and never takes direct_attach_resize_locks;
 * ClientInput/AttachScroll/AttachMouse are routed only for TerminalAttach
 * mode, so an observe link must not carry them (headless.rs @ e8d7d97).
 * `target` accepts a pane, terminal or agent id; the terminal id resolves.
 */
export function msgObserveTerminal(target: string): number[] {
  return [...vi(7), ...vs(target)];
}

/** AttachScrollSource::Wheel = 0, AttachScrollDirection::Up = 0 / Down = 1. */
export function attachScroll(
  direction: "up" | "down",
  lines: number,
  column?: number,
  row?: number,
  modifiers = 0,
): number[] {
  return [
    ...vi(6),
    ...vi(0), // source Wheel
    ...vi(direction === "up" ? 0 : 1),
    ...vi(lines),
    ...(column === undefined ? [0] : [1, ...vi(column)]), // column: Option<u16>
    ...(row === undefined ? [0] : [1, ...vi(row)]), // row: Option<u16>
    ...vi(modifiers),
  ];
}

/* --------------------------- AttachMouse -------------------------------- */
// ClientMessage::AttachMouse is variant 16 (wire.rs). The server encodes SGR
// reports only when the pane enabled the matching mouse mode; pane mode
// state arrives separately as ServerMessage::MouseCapture (variant 8).

export type AttachMouseAction = "press" | "motion" | "release" | "moved";
export type AttachMouseButton = "left" | "middle" | "right";

// ClientMouseKind: Down = 0, Up = 1, Drag = 2 (all carry a button),
// Moved = 3 (buttonless), Scroll* = 4..7 (unused here; wheel goes via AttachScroll).
const MOUSE_KIND: Record<AttachMouseAction, number> = { press: 0, release: 1, motion: 2, moved: 3 };
// ClientMouseButton: Left = 0, Right = 1, Middle = 2 (wire.rs order).
const MOUSE_BUTTON: Record<AttachMouseButton, number> = { left: 0, right: 1, middle: 2 };

/** crossterm KeyModifiers bits: SHIFT = 1, ALT = 2, CONTROL = 4. */
export function mouseModifiers(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): number {
  return (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4 : 0);
}

export function attachMouse(
  action: AttachMouseAction,
  button: AttachMouseButton | null,
  column: number,
  row: number,
  modifiers: number,
): number[] {
  const kind = MOUSE_KIND[action];
  const kindBytes =
    kind === 3 ? [...vi(kind)] : [...vi(kind), ...vi(MOUSE_BUTTON[button ?? "left"])];
  return [
    ...vi(16), // ClientMessage::AttachMouse
    ...kindBytes, // ClientMouseKind (Down/Up/Drag carry a ClientMouseButton)
    ...vi(0), ...vi(column), ...vi(row), // ClientMousePosition::Cell
    0, // geometry: Option<ClientMouseGeometry> None (cell metrics unknown)
    ...vi(modifiers),
    ...vi(1), // lines (wheel clicks; unused for button events)
  ];
}

/* ----------------------------- framing --------------------------------- */

function frame(payload: number[]): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

export type ServerEvent =
  | { type: "welcome"; version: number; terminalAnsi: boolean; error: string | null }
  | { type: "terminal"; seq: number; width: number; height: number; full: boolean; bytes: Uint8Array }
  | { type: "shutdown"; reason: string | null }
  | { type: "mouse_capture"; enabled: boolean; sgrPixels: boolean }
  | { type: "other"; variant: number };

function readOptionString(buf: Uint8Array, offset: number): [string | null, number] {
  const tag = buf[offset];
  if (tag === undefined) throw new Error("truncated option");
  if (tag === 0) return [null, offset + 1];
  const [value, next] = readString(buf, offset + 1);
  return [value, next];
}

function readString(buf: Uint8Array, offset: number): [string, number] {
  const [len, after] = decodeVarint(buf, offset);
  const end = after + Number(len);
  if (end > buf.length) throw new Error("truncated string");
  return [new TextDecoder().decode(buf.subarray(after, end)), end];
}

/** Decode one ServerMessage payload (without its length prefix). */
export function decodeServerMessage(payload: Uint8Array): ServerEvent {
  const [variant, offset] = decodeVarint(payload, 0);
  const v = Number(variant);
  try {
    switch (v) {
      case 0: {
        // Welcome { version: u32, encoding: RenderEncoding, error: Option<String> }
        let o = offset;
        const [version, o1] = decodeVarint(payload, o); o = o1;
        const [encoding, o2] = decodeVarint(payload, o); o = o2;
        const [error, o3] = readOptionString(payload, o);
        void o3;
        return { type: "welcome", version: Number(version), terminalAnsi: Number(encoding) === 1, error };
      }
      case 1: {
        // Terminal(TerminalFrame { seq: u64, width: u16, height: u16, full: bool, bytes: Vec<u8> })
        let o = offset;
        const [seq, o1] = decodeVarint(payload, o); o = o1;
        const [width, o2] = decodeVarint(payload, o); o = o2;
        const [height, o3] = decodeVarint(payload, o); o = o3;
        const full = payload[o] === 1; o += 1;
        const [len, o4] = decodeVarint(payload, o); o = o4;
        const end = o + Number(len);
        if (end > payload.length) throw new Error("truncated terminal bytes");
        return { type: "terminal", seq: Number(seq), width: Number(width), height: Number(height), full, bytes: payload.slice(o, end) };
      }
      case 3: {
        // ServerShutdown { reason: Option<String> }
        const [reason] = readOptionString(payload, offset);
        return { type: "shutdown", reason };
      }
      case 8: {
        // MouseCapture { enabled: bool, sgr_pixels: bool } — pushed to
        // writable TerminalAttach clients on attach and on change since
        // herdr 0.9.0 (wire.rs ServerMessage). `enabled` is the attached
        // pane's mouse_reporting_enabled(); the server still gates every
        // AttachMouse/AttachScroll report against the pane's modes.
        if (offset + 2 > payload.length) throw new Error("truncated mouse capture");
        return {
          type: "mouse_capture",
          enabled: payload[offset] === 1,
          sgrPixels: payload[offset + 1] === 1,
        };
      }
      default:
        return { type: "other", variant: v };
    }
  } catch (error) {
    throw new Error(`bad server frame (variant ${v}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------ socket --------------------------------- */

export interface LinkHandlers {
  onEvent: (event: ServerEvent) => void;
  onClose: (reason: string) => void;
}

export interface TerminalMouseEvent {
  action: AttachMouseAction;
  button?: AttachMouseButton | null;
  column: number;
  row: number;
  modifiers?: number;
}

export interface TerminalLink {
  readonly terminalId: string;
  /** True when the link holds writable AttachTerminal mode; false for ObserveTerminal. */
  readonly writable: boolean;
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  scroll: (direction: "up" | "down", lines?: number, column?: number, row?: number, modifiers?: number) => void;
  mouse: (event: TerminalMouseEvent) => void;
  close: () => void;
}

/**
 * Derive the client socket from the API socket path, mirroring herdr's
 * `derive_client_socket_from_api_socket`: `herdr.sock` -> `herdr-client.sock`
 * in the same directory (named sessions included). HERDR_CLIENT_SOCKET_PATH
 * overrides, as in herdr itself.
 */
export function clientSocketPath(env: Record<string, string | undefined> = process.env): string {
  if (env["HERDR_CLIENT_SOCKET_PATH"]) return env["HERDR_CLIENT_SOCKET_PATH"];
  const api = herdrSocketPath(env);
  const slash = Math.max(api.lastIndexOf("/"), api.lastIndexOf("\\"));
  const dir = slash === -1 ? "" : api.slice(0, slash + 1);
  const base = slash === -1 ? api : api.slice(slash + 1);
  const stem = base.replace(/\.sock$/i, "");
  return `${dir}${stem}-client.sock`;
}

/**
 * Open a client-protocol connection and attach to `terminalId`. Resolves once
 * the mode message (AttachTerminal, or ObserveTerminal when `writable` is
 * false) is sent after the handshake; the first Terminal frame follows.
 * Rejects on handshake refusal, attach failure or socket loss before welcome.
 */
export function openTerminalLink(
  terminalId: string,
  options: { cols: number; rows: number; socketPath?: string; connect?: Connector; takeover?: boolean; writable?: boolean },
  handlers: LinkHandlers,
): Promise<TerminalLink> {
  const connect =
    options.connect ?? socketConnector(socketAddress(options.socketPath ?? clientSocketPath()));
  return new Promise<TerminalLink>((resolve, reject) => {
    let settled = false;
    let welcomed = false;
    let sock: { write(data: string | Uint8Array): unknown; end(): unknown } | null = null;
    let buffer = new Uint8Array(0);
    let closed = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const send = (payload: number[]) => {
      try {
        sock?.write(frame(payload));
      } catch {
        /* the close handler reports it */
      }
    };

    const pump = () => {
      for (;;) {
        if (buffer.length < 4) return;
        const len = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true);
        if (len > MAX_SERVER_FRAME_SIZE) {
          handlers.onClose("frame too large");
          try { sock?.end(); } catch { /* gone */ }
          return;
        }
        if (buffer.length < 4 + len) return;
        const payload = buffer.subarray(4, 4 + len);
        buffer = buffer.slice(4 + len);
        let event: ServerEvent;
        try {
          event = decodeServerMessage(payload);
        } catch (error) {
          handlers.onClose(error instanceof Error ? error.message : String(error));
          try { sock?.end(); } catch { /* gone */ }
          return;
        }
        if (!welcomed) {
          if (event.type !== "welcome") {
            handlers.onClose("expected Welcome");
            try { sock?.end(); } catch { /* gone */ }
            return;
          }
          welcomed = true;
          if (event.error !== null) {
            finish(() => reject(new Error(`herdr refused the client handshake: ${event.error}`)));
            try { sock?.end(); } catch { /* gone */ }
            return;
          }
          if (!event.terminalAnsi) {
            finish(() => reject(new Error("herdr did not select TerminalAnsi encoding for this client")));
            try { sock?.end(); } catch { /* gone */ }
            return;
          }
          // Pick the attach mode before any frame flows: writable
          // AttachTerminal takes the pane's resize authority; ObserveTerminal
          // streams read-only with no size or input effect (issue #571).
          // Mode is fixed for the life of the connection — herdr only
          // accepts the mode message while the client is TerminalPending —
          // so switching modes means a new connection (a new subscribe).
          const writable = options.writable ?? true;
          send(writable ? msgAttachTerminal(terminalId, options.takeover ?? false) : msgObserveTerminal(terminalId));
          const link: TerminalLink = {
            terminalId,
            writable,
            write: (data) => send(clientInput(data)),
            resize: (cols, rows) => send(clientResize(cols, rows)),
            scroll: (direction, lines = 3, column, row, modifiers) =>
              send(attachScroll(direction, lines, column, row, modifiers)),
            mouse: (event) =>
              send(attachMouse(event.action, event.button ?? null, event.column, event.row, event.modifiers ?? 0)),
            close: () => {
              if (closed) return;
              closed = true;
              send(clientDetach());
              try { sock?.end(); } catch { /* gone */ }
            },
          };
          finish(() => resolve(link));
          continue;
        }
        if (closed) continue;
        handlers.onEvent(event);
      }
    };

    const sockHandlers: SocketHandlers = {
      data: (chunk) => {
        const merged = new Uint8Array(buffer.length + chunk.length);
        merged.set(buffer);
        merged.set(chunk, buffer.length);
        buffer = merged;
        pump();
      },
      error: (err) => {
        if (!welcomed) finish(() => reject(new Error(`herdr client socket error: ${err.message}`)));
        else if (!closed) handlers.onClose(err.message);
      },
      close: () => {
        if (!welcomed) finish(() => reject(new Error("herdr closed the client socket during handshake")));
        else if (!closed) handlers.onClose("socket closed");
      },
    };
    connect(sockHandlers).then((s) => {
      sock = s;
      if (settled || closed) {
        try { s.end(); } catch { /* gone */ }
        return;
      }
      send(terminalHello(options.cols, options.rows));
    }, (err: Error) => {
      finish(() => reject(new Error(`cannot reach herdr client transport: ${err.message}`)));
    });
  });
}
