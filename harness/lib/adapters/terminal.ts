/**
 * TS adapter for terminal-engine ops (issue #237). Wraps
 * GhosttySession — the same per-pane emulator the product uses — so
 * scenarios observe the real engine, including its WASM trap isolation.
 * State (sessions, collected replies/effects) lives in the adapter
 * instance for the duration of a scenario run.
 */
import { join } from "node:path";
import {
  createGhosttySessionWith,
  GhosttySession,
} from "../../../src/lib/ghostty/session.ts";
import type { EngineKey, EngineMouse } from "../../../shared/ghostty/engine.ts";
import type { Adapter, Observation } from "../types.ts";

const WASM = join(import.meta.dir, "../../../shared/ghostty/ghostty-vt.wasm");

interface SessionState {
  session: GhosttySession;
  replies: string[];
  effects: Record<string, unknown>[];
}

function hex(bytes: Uint8Array): string {
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

const OPS = new Set([
  "session_new",
  "write",
  "resize",
  "screen",
  "cursor",
  "modes",
  "encode_key",
  "encode_mouse",
  "encode_paste",
  "scroll",
  "drain_replies",
  "drain_effects",
  "dispose",
]);

export function createTerminalAdapter(): Adapter {
  const sessions = new Map<string, SessionState>();
  let nextHandle = 0;
  let compiled: Promise<WebAssembly.Module> | null = null;
  const module = () => {
    compiled ??= Bun.file(WASM).arrayBuffer().then((b) => WebAssembly.compile(b));
    return compiled;
  };

  function state(input: Record<string, unknown>): SessionState {
    const handle = input["handle"];
    if (typeof handle !== "string") throw new Error('input.handle must be a string');
    const s = sessions.get(handle);
    if (!s) throw new Error(`unknown session handle "${handle}"`);
    return s;
  }

  return {
    name: "ts",
    ops: OPS,
    async run(op: string, input: Record<string, unknown>): Promise<Observation> {
      try {
        switch (op) {
          case "session_new": {
            const cols = num(input, "cols");
            const rows = num(input, "rows");
            const handle = `s${++nextHandle}`;
            const replies: string[] = [];
            const effects: Record<string, unknown>[] = [];
            const session = await createGhosttySessionWith(await module(), {
              cols,
              rows,
              ...(typeof input["scrollback"] === "number" ? { scrollbackLines: input["scrollback"] } : {}),
              ...(typeof input["cellW"] === "number" ? { cellW: input["cellW"] } : {}),
              ...(typeof input["cellH"] === "number" ? { cellH: input["cellH"] } : {}),
              onReply: (bytes) => replies.push(hex(bytes)),
              onBell: () => effects.push({ type: "bell" }),
              onClipboardWrite: (effect) =>
                effects.push({
                  type: "clipboardWrite",
                  location: effect.location,
                  mime: effect.contents.map((c) => c.mime),
                  data_hex: effect.contents.map((c) => hex(c.data)),
                }),
            });
            sessions.set(handle, { session, replies, effects });
            return ok({ handle });
          }
          case "write": {
            const s = state(input);
            const data = typeof input["data"] === "string" ? input["data"] : unhex(String(input["hex"] ?? ""));
            s.session.write(data);
            return ok(null);
          }
          case "resize": {
            const s = state(input);
            s.session.resize(num(input, "cols"), num(input, "rows"), num(input, "cellW") || 0, num(input, "cellH") || 0);
            return ok(null);
          }
          case "screen": {
            const s = state(input);
            const rows: unknown[] = [];
            s.session.frameAll((y, runs) => {
              rows.push({
                y,
                runs: runs.map((run) => ({
                  x: run.x,
                  cells: run.cells,
                  fg: run.fg,
                  bg: run.bg,
                  flags: run.flags,
                })),
              });
            });
            return ok({ rows });
          }
          case "cursor":
            return ok(state(input).session.cursorState());
          case "modes":
            return ok(state(input).session.modes());
          case "encode_key": {
            const s = state(input);
            const key = input["key"];
            if (key === null || typeof key !== "object") throw new Error("input.key must be an EngineKey object");
            return ok({ hex: hex(s.session.encodeKey(key as EngineKey)) });
          }
          case "encode_mouse": {
            const s = state(input);
            const mouse = input["mouse"];
            if (mouse === null || typeof mouse !== "object") throw new Error("input.mouse must be an EngineMouse object");
            return ok({ hex: hex(s.session.encodeMouse(mouse as EngineMouse)) });
          }
          case "encode_paste": {
            const s = state(input);
            const text = input["text"];
            if (typeof text !== "string") throw new Error("input.text must be a string");
            return ok({ hex: hex(s.session.encodePaste(text)) });
          }
          case "scroll": {
            const s = state(input);
            s.session.scrollFromBottom(num(input, "rows"));
            return ok(null);
          }
          case "drain_replies": {
            const s = state(input);
            return ok({ replies: s.replies.splice(0) });
          }
          case "drain_effects": {
            const s = state(input);
            return ok({ effects: s.effects.splice(0) });
          }
          case "dispose": {
            const s = state(input);
            s.session.dispose();
            sessions.delete(String(input["handle"]));
            return ok(null);
          }
          default:
            return fail(`ts terminal adapter: unknown op "${op}"`);
        }
      } catch (error) {
        return fail(error);
      }
    },
  };
}
