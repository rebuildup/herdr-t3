/**
 * Synchronous loader for the protocol-codec wasm consumer artifact
 * (ADR-0025, issue #315). `shared/protocol-codec.wasm` is
 * `crates/protocol-codec` compiled to wasm32-unknown-unknown — a data
 * artifact like ghostty-vt.wasm / terminal-input.wasm, rebuilt by
 * scripts/protocol-codec/build-wasm.sh.
 *
 * The product ingress guards consume only two exports, shaped for their
 * actual call sites (JSON text in, verdict out — callers parse payloads
 * themselves only after validation passes):
 *
 *   protocol_codec_is_client_frame(json) -> 1 | 0
 *   protocol_codec_is_rpc_method(method) -> 1 | 0
 *
 * Loading is synchronous (`new WebAssembly.Module`, not `compile`) so
 * ingress handlers and the CJS desktop bundle need no async plumbing.
 * Any resolution/compile failure falls back to `null` — callers keep the
 * TypeScript guard as the rollback path.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProtocolCodecWasm {
  /** `isClientFrame` on the raw JSON text — false for malformed JSON too. */
  isClientFrame(json: string): boolean;
  isRpcMethod(method: string): boolean;
}

function moduleDir(): string {
  try {
    // ESM (bun server, vite); absent in the CJS desktop bundle.
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return typeof __dirname === "string" ? __dirname : ".";
  }
}

function artifactCandidates(): string[] {
  const env = process.env["HERDR_T3_CODEC_WASM"];
  const here = moduleDir();
  return [
    ...(env ? [env] : []),
    join(here, "protocol-codec.wasm"), // shared/ under bun
    join(here, "../shared/protocol-codec.wasm"), // desktop/ bundle -> shared/
    join(here, "../../shared/protocol-codec.wasm"), // one level deeper
  ];
}

function artifactBytes(): Uint8Array<ArrayBuffer> | null {
  for (const candidate of artifactCandidates()) {
    try {
      if (existsSync(candidate)) return new Uint8Array(readFileSync(candidate));
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

interface CodecExports {
  memory: WebAssembly.Memory;
  protocol_codec_alloc(len: number): number;
  protocol_codec_dealloc(ptr: number, len: number): void;
  protocol_codec_is_client_frame(ptr: number, len: number): number;
  protocol_codec_is_rpc_method(ptr: number, len: number): number;
}

function withBytes(
  exports: CodecExports,
  text: string,
  fn: (ptr: number, len: number) => number,
): boolean {
  const bytes = new TextEncoder().encode(text);
  const ptr = exports.protocol_codec_alloc(bytes.length);
  if (ptr === 0) throw new Error("protocol-codec: alloc failed");
  try {
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
    return fn(ptr, bytes.length) === 1;
  } finally {
    exports.protocol_codec_dealloc(ptr, bytes.length);
  }
}

export function loadProtocolCodecWasm(bytes?: Uint8Array<ArrayBuffer>): ProtocolCodecWasm | null {
  try {
    const data = bytes ?? artifactBytes();
    if (!data) return null;
    const module = new WebAssembly.Module(data);
    const { exports } = new WebAssembly.Instance(module, {}) as unknown as {
      exports: CodecExports;
    };
    for (const name of [
      "memory",
      "protocol_codec_alloc",
      "protocol_codec_dealloc",
      "protocol_codec_is_client_frame",
      "protocol_codec_is_rpc_method",
    ] as const) {
      if (exports[name] === undefined) {
        throw new Error(`protocol-codec: wasm export ${name} missing`);
      }
    }
    return {
      isClientFrame: (json) => withBytes(exports, json, exports.protocol_codec_is_client_frame.bind(exports)),
      isRpcMethod: (method) => withBytes(exports, method, exports.protocol_codec_is_rpc_method.bind(exports)),
    };
  } catch {
    return null;
  }
}

/** Module-level instance: resolved once at import; null => TS fallback. */
export const protocolCodecWasm: ProtocolCodecWasm | null = loadProtocolCodecWasm();
