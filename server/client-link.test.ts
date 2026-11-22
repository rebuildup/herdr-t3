import { describe, expect, test } from "bun:test";
import { decodeServerMessage, encodeVarint } from "./client-link.ts";

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

  test("skips unhandled variants without decoding their payload", () => {
    // variant 8 (MouseCapture) with arbitrary trailing bytes
    expect(decodeServerMessage(new Uint8Array([8, 1, 0, 0xde, 0xad]))).toEqual({ type: "other", variant: 8 });
  });

  test("rejects truncated frames", () => {
    expect(() => decodeServerMessage(new Uint8Array([1, 1, 100, 30, 1, 200, 1, 65]))).toThrow(/truncated/);
  });
});
