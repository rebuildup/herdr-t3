/**
 * TS adapter for the attach codec ops (issue #237). Wraps the current
 * implementation in server/client-link.ts — the same functions the
 * bridge uses — so scenarios observe real behavior, not a re-implementation.
 */
import {
  attachMouse,
  attachScroll,
  clientDetach,
  clientInput,
  clientResize,
  decodeServerMessage,
  decodeVarint,
  encodeVarint,
  msgAttachTerminal,
  terminalHello,
} from "../../../server/client-link.ts";
import type { Adapter, Observation } from "../types.ts";

function hex(bytes: number[] | Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ok(value: unknown): Observation {
  return { ok: true, value };
}

function fail(error: unknown): Observation {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function num(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (typeof v !== "number") throw new Error(`input.${key} must be a number`);
  return v;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`input.${key} must be a string`);
  return v;
}

const OPS = new Set([
  "varint_encode",
  "varint_decode",
  "decode_server_message",
  "encode_terminal_hello",
  "encode_client_input",
  "encode_client_resize",
  "encode_client_detach",
  "encode_attach_terminal",
  "encode_attach_scroll",
  "encode_attach_mouse",
]);

export const codecAdapter: Adapter = {
  name: "ts",
  ops: OPS,
  run(op: string, input: Record<string, unknown>): Observation {
    try {
      switch (op) {
        case "varint_encode": {
          const raw = input["value"];
          const value = typeof raw === "string" ? BigInt(raw) : num(input, "value");
          return ok({ hex: hex(encodeVarint(value)) });
        }
        case "varint_decode": {
          const buf = unhex(str(input, "hex"));
          const offset = typeof input["offset"] === "number" ? input["offset"] : 0;
          const [value, next] = decodeVarint(buf, offset);
          return ok({ value: value.toString(), next });
        }
        case "decode_server_message": {
          const event = decodeServerMessage(unhex(str(input, "hex")));
          const value: Record<string, unknown> = { type: event.type };
          if (event.type === "welcome") {
            value["version"] = event.version;
            value["terminalAnsi"] = event.terminalAnsi;
            value["error"] = event.error;
          } else if (event.type === "terminal") {
            value["seq"] = event.seq;
            value["width"] = event.width;
            value["height"] = event.height;
            value["full"] = event.full;
            value["bytes_hex"] = hex(event.bytes);
          } else if (event.type === "shutdown") {
            value["reason"] = event.reason;
          } else if (event.type === "mouse_capture") {
            value["enabled"] = event.enabled;
            value["sgrPixels"] = event.sgrPixels;
          } else {
            value["variant"] = event.variant;
          }
          return ok(value);
        }
        case "encode_terminal_hello":
          return ok({ hex: hex(terminalHello(num(input, "cols"), num(input, "rows"))) });
        case "encode_client_input":
          return ok({ hex: hex(clientInput(unhex(str(input, "hex")))) });
        case "encode_client_resize":
          return ok({ hex: hex(clientResize(num(input, "cols"), num(input, "rows"))) });
        case "encode_client_detach":
          return ok({ hex: hex(clientDetach()) });
        case "encode_attach_terminal":
          return ok({
            hex: hex(
              msgAttachTerminal(str(input, "terminal_id"), input["takeover"] === true),
            ),
          });
        case "encode_attach_scroll": {
          const direction = str(input, "direction");
          if (direction !== "up" && direction !== "down") {
            throw new Error('input.direction must be "up" or "down"');
          }
          return ok({
            hex: hex(
              attachScroll(
                direction,
                num(input, "lines"),
                typeof input["column"] === "number" ? input["column"] : undefined,
                typeof input["row"] === "number" ? input["row"] : undefined,
                typeof input["modifiers"] === "number" ? input["modifiers"] : 0,
              ),
            ),
          });
        }
        case "encode_attach_mouse": {
          const action = str(input, "action");
          if (action !== "press" && action !== "release" && action !== "motion" && action !== "moved") {
            throw new Error('input.action must be press|release|motion|moved');
          }
          const button = input["button"];
          if (button !== undefined && button !== null && button !== "left" && button !== "middle" && button !== "right") {
            throw new Error('input.button must be left|middle|right|null');
          }
          return ok({
            hex: hex(
              attachMouse(
                action,
                (button as "left" | "middle" | "right" | null | undefined) ?? null,
                num(input, "column"),
                num(input, "row"),
                typeof input["modifiers"] === "number" ? input["modifiers"] : 0,
              ),
            ),
          });
        }
        default:
          return fail(`ts codec adapter: unknown op "${op}"`);
      }
    } catch (error) {
      return fail(error);
    }
  },
};
