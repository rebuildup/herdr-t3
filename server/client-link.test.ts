import { describe, expect, test } from "bun:test";
import {
  attachMouse,
  decodeServerMessage,
  encodeVarint,
  msgAttachTerminal,
  msgObserveTerminal,
  openTerminalLink,
} from "./client-link.ts";
import type { ByteStream, SocketHandlers } from "./socket.ts";

describe("encodeVarint (bincode 2 standard)", () => {
  test("values up to 250 are a single literal byte", () => {
    expect(encodeVarint(0)).toEqual([0]);
    expect(encodeVarint(22)).toEqual([22]);
    expect(encodeVarint(250)).toEqual([250]);
  });

  test("larger values use the tagged fixed-width forms", () => {
    expect(encodeVarint(251)).toEqual([251, 251, 0]);
    expect(encodeVarint(65535)).toEqual([251, 255, 255]);
    expect(encodeVarint(65536)).toEqual([252, 0, 0, 1, 0]);
    expect(encodeVarint(0x0102030405)).toEqual([253, 5, 4, 3, 2, 1, 0, 0, 0]);
  });
});

describe("attachMouse (ClientMessage::AttachMouse, variant 16)", () => {
  test("press encodes Down(Left) at a cell position", () => {
    // [16, kind=Down(0)+button=Left(0), position=Cell(0)+col+row, geometry=None, modifiers, lines]
    expect(attachMouse("press", "left", 10, 5, 0)).toEqual([
      16, 0, 0, 0, 10, 5, 0, 0, 1,
    ]);
  });

  test("release encodes Up(Right)", () => {
    expect(attachMouse("release", "right", 1, 2, 4)).toEqual([
      16, 1, 1, 0, 1, 2, 0, 4, 1,
    ]);
  });

  test("motion encodes Drag(Middle); moved is buttonless", () => {
    expect(attachMouse("motion", "middle", 3, 4, 0)).toEqual([
      16, 2, 2, 0, 3, 4, 0, 0, 1,
    ]);
    expect(attachMouse("moved", null, 3, 4, 0)).toEqual([
      16, 3, 0, 3, 4, 0, 0, 1,
    ]);
  });
});

describe("observe mode (issue #571)", () => {
  test("msgObserveTerminal encodes ClientMessage variant 7 with a string target", () => {
    // [7, len=6, "term-1"]
    expect(msgObserveTerminal("term-1")).toEqual([7, 6, 116, 101, 114, 109, 45, 49]);
    expect(msgAttachTerminal("term-1", false)[0]).toBe(5);
  });

  class FakeStream implements ByteStream {
    readonly chunks: Uint8Array[] = [];
    ended = false;
    write(data: string | Uint8Array): void {
      this.chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
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
    /** Variant discriminants of every complete frame written so far. */
    variants(): number[] {
      const buf = this.bytes();
      const out: number[] = [];
      let offset = 0;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      while (offset + 4 <= buf.length) {
        const len = view.getUint32(offset, true);
        if (offset + 4 + len > buf.length) break;
        out.push(buf[offset + 4]!);
        offset += 4 + len;
      }
      return out;
    }
  }

  function welcome(): Uint8Array {
    // ServerMessage::Welcome { version: 22, encoding: TerminalAnsi(1), error: None }
    const payload = new Uint8Array([0, 22, 1, 0]);
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, payload.length, true);
    frame.set(payload, 4);
    return frame;
  }

  function openLink(writable: boolean) {
    const stream = new FakeStream();
    let handlers: SocketHandlers | null = null;
    const linkPromise = openTerminalLink(
      "term-1",
      { cols: 80, rows: 24, writable, connect: (h) => { handlers = h; return Promise.resolve(stream); } },
      { onEvent: () => {}, onClose: () => {} },
    );
    return { stream, linkPromise, handlers: () => handlers! };
  }

  test("writable:false attaches with ObserveTerminal, not AttachTerminal", async () => {
    const { stream, linkPromise, handlers } = openLink(false);
    // TerminalHello goes out on connect; the mode message follows Welcome.
    await new Promise((r) => setTimeout(r, 10));
    expect(stream.variants()).toEqual([0]);
    handlers().data(welcome());
    const link = await linkPromise;
    expect(link.writable).toBe(false);
    expect(stream.variants()).toEqual([0, 7]);
    link.close();
    expect(stream.ended).toBe(true);
  });

  test("default attach stays writable AttachTerminal", async () => {
    const { stream, linkPromise, handlers } = openLink(true);
    await new Promise((r) => setTimeout(r, 10));
    handlers().data(welcome());
    const link = await linkPromise;
    expect(link.writable).toBe(true);
    expect(stream.variants()).toEqual([0, 5]);
    link.close();
  });
});

describe("decodeServerMessage", () => {
  test("decodes Welcome with TerminalAnsi encoding", () => {
    // Captured from herdr 0.9.5: Welcome { version: 22, encoding: TerminalAnsi, error: None }
    expect(decodeServerMessage(new Uint8Array([0, 22, 1, 0]))).toEqual({
      type: "welcome",
      version: 22,
      terminalAnsi: true,
      error: null,
    });
  });

  test("decodes Welcome with SemanticFrame encoding", () => {
    expect(decodeServerMessage(new Uint8Array([0, 22, 0, 0]))).toMatchObject({
      type: "welcome",
      terminalAnsi: false,
    });
  });

  test("decodes a Terminal frame", () => {
    // variant 1, seq 7, 80x24, full, bytes "hi"
    const payload = new Uint8Array([1, 7, 80, 24, 1, 2, 104, 105]);
    expect(decodeServerMessage(payload)).toEqual({
      type: "terminal",
      seq: 7,
      width: 80,
      height: 24,
      full: true,
      bytes: new Uint8Array([104, 105]),
    });
  });

  test("decodes a Terminal frame with a tagged varint length", () => {
    // bytes length 300 -> varint tag 251 + u16 LE
    const bytes = new Uint8Array(300).fill(0x61);
    const payload = new Uint8Array([1, 1, 100, 30, 0, 251, 44, 1, ...bytes]);
    const event = decodeServerMessage(payload);
    expect(event).toMatchObject({ type: "terminal", seq: 1, width: 100, height: 30, full: false });
    if (event.type === "terminal") expect(event.bytes.length).toBe(300);
  });

  test("decodes ServerShutdown with a reason", () => {
    // variant 3, Option::Some("bye")
    const payload = new Uint8Array([3, 1, 3, 98, 121, 101]);
    expect(decodeServerMessage(payload)).toEqual({ type: "shutdown", reason: "bye" });
  });

  test("decodes MouseCapture (variant 8) with both flags", () => {
    // MouseCapture { enabled: bool, sgr_pixels: bool }
    expect(decodeServerMessage(new Uint8Array([8, 1, 0]))).toEqual({
      type: "mouse_capture",
      enabled: true,
      sgrPixels: false,
    });
    expect(decodeServerMessage(new Uint8Array([8, 1, 1]))).toEqual({
      type: "mouse_capture",
      enabled: true,
      sgrPixels: true,
    });
    expect(decodeServerMessage(new Uint8Array([8, 0, 0]))).toEqual({
      type: "mouse_capture",
      enabled: false,
      sgrPixels: false,
    });
  });

  test("skips unhandled variants without decoding their payload", () => {
    // variant 9 (TerminalBell) with arbitrary trailing bytes
    expect(decodeServerMessage(new Uint8Array([9, 1, 0, 0xde, 0xad]))).toEqual({ type: "other", variant: 9 });
  });

  test("rejects truncated frames", () => {
    expect(() => decodeServerMessage(new Uint8Array([1, 1, 100, 30, 1, 200, 1, 65]))).toThrow(/truncated/);
  });
});
