import { describe, expect, test } from "bun:test";
import { makeLineReader } from "./herdr.ts";

describe("makeLineReader", () => {
  test("splits JSON lines across chunk boundaries", () => {
    const lines: string[] = [];
    const read = makeLineReader(1024, (line) => lines.push(line), () => {});
    const encoder = new TextEncoder();
    const payload = encoder.encode('{"a":1}\n{"b":2}\n');
    read(payload.subarray(0, 5));
    read(payload.subarray(5, 9));
    read(payload.subarray(9));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reports overflow once and stops", () => {
    const lines: string[] = [];
    let overflows = 0;
    const read = makeLineReader(4, (line) => lines.push(line), () => overflows++);
    read(new TextEncoder().encode("12345\n"));
    read(new TextEncoder().encode("6\n"));
    expect(overflows).toBe(1);
    expect(lines).toEqual([]);
  });

  test("handles a line exactly at the limit", () => {
    const lines: string[] = [];
    const read = makeLineReader(5, (line) => lines.push(line), () => {});
    read(new TextEncoder().encode("12345\n"));
    expect(lines).toEqual(["12345"]);
  });
});
