/**
 * Loader for the terminal-input wasm consumer artifact (ADR-0025, issue
 * #319). `terminal-input.wasm` is `crates/terminal-input` compiled to
 * wasm32-unknown-unknown — a data artifact like ghostty-vt.wasm, vendored
 * beside this file and rebuilt by scripts/terminal-input/build-wasm.sh.
 *
 * The module exports `terminal_input_eval(ptr, len)` taking a JSON
 * `{"op","input"}` request (the contract `terminal-input@1` op vocabulary)
 * and answering `{"ok","value"|"error"}`; buffers cross via
 * `terminal_input_alloc`/`terminal_input_dealloc`, results via
 * `terminal_input_result_ptr`/`terminal_input_eval`'s return length.
 */
import wasmUrl from "./terminal-input.wasm?url";
import { wasmAssetBytes } from "../wasmAsset.ts";

export interface TerminalInputExports {
  memory: WebAssembly.Memory;
  terminal_input_alloc(len: number): number;
  terminal_input_dealloc(ptr: number, len: number): void;
  terminal_input_eval(ptr: number, len: number): number;
  terminal_input_result_ptr(): number;
}

export interface TerminalInputInstance {
  exports: TerminalInputExports;
  /** One JSON op round-trip; throws on transport-level failure only —
   *  op errors come back as `{ ok: false, error }`. `trackerId` selects
   *  the per-pane CompositionTracker inside the module (default 0). */
  eval(
    op: string,
    input: Record<string, unknown>,
    trackerId?: number,
  ): { ok: boolean; value?: unknown; error?: string };
}

/** Fetch/decode the artifact bytes — same shapes as session.ts's loader. */
export async function terminalInputBytes(): Promise<Uint8Array> {
  return wasmAssetBytes(wasmUrl);
}

export async function instantiateTerminalInput(
  bytes?: Uint8Array,
): Promise<TerminalInputInstance> {
  const module = await WebAssembly.compile(bytes ?? (await terminalInputBytes()));
  const instance = new WebAssembly.Instance(module, {}) as unknown as {
    exports: TerminalInputExports;
  };
  const { exports } = instance;
  for (const name of [
    "memory",
    "terminal_input_alloc",
    "terminal_input_dealloc",
    "terminal_input_eval",
    "terminal_input_result_ptr",
  ] as const) {
    if (exports[name] === undefined) {
      throw new Error(`terminal-input: wasm export ${name} missing`);
    }
  }
  const text = new TextDecoder();
  const textEncoder = new TextEncoder();
  return {
    exports,
    eval(op, input, trackerId) {
      const request = textEncoder.encode(
        JSON.stringify({ op, input, ...(trackerId === undefined ? {} : { tracker: trackerId }) }),
      );
      const ptr = exports.terminal_input_alloc(request.length);
      if (ptr === 0) throw new Error("terminal-input: alloc failed");
      try {
        new Uint8Array(exports.memory.buffer, ptr, request.length).set(request);
        const outLen = exports.terminal_input_eval(ptr, request.length);
        // eval may have grown memory — re-read the buffer after the call.
        const outPtr = exports.terminal_input_result_ptr();
        const out = text.decode(
          new Uint8Array(exports.memory.buffer, outPtr, outLen),
        );
        return JSON.parse(out) as { ok: boolean; value?: unknown; error?: string };
      } finally {
        exports.terminal_input_dealloc(ptr, request.length);
      }
    },
  };
}
