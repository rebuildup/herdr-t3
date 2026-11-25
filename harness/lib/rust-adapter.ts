import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, Observation } from "./types.ts";

/**
 * Rust adapter client (issue #237, extended #275). Two binaries share the
 * "rust" adapter name, routed by op:
 *
 * - `crates/diff-adapter` — non-product reference for the attach codec
 *   (bincode-2 varint frames). Proves the harness pattern.
 * - `crates/protocol-codec` (`protocol-codec-adapter` bin) — the
 *   product-intended protocol.codec implementation (issue #275).
 *
 * Both read a batch of steps as JSON and emit observations in the same
 * shape as the TS adapters, so the same fixtures and the same comparator
 * judge both sides. Steps are partitioned per binary and reassembled by
 * index, so scenarios may mix op families freely.
 *
 * Binary resolution: $DIFF_ADAPTER_BIN / $PROTOCOL_CODEC_BIN, else
 * target/debug/<name>, built on demand via cargo when available.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");

interface RustBin {
  /** ops this binary serves */
  ops: ReadonlySet<string>;
  /** resolved binary path, or null when unavailable */
  path: string | null;
  /** cargo package to build on demand */
  package: string;
  /** env override */
  envVar: string;
  /** fixed binary filename under target/debug */
  fileName: string;
  label: string;
}

const CODEC_OPS = new Set([
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

/** protocol.codec ops served by the product crate (issue #275). */
const JSON_CODEC_OPS = new Set([
  "json_is_client_frame",
  "json_encode_client_frame",
  "json_decode_server_frame",
  "json_parse_snapshot",
]);

const BINS: RustBin[] = [
  {
    ops: CODEC_OPS,
    path: null,
    package: "diff-adapter",
    envVar: "DIFF_ADAPTER_BIN",
    fileName: "diff-adapter",
    label: "diff-adapter",
  },
  {
    ops: JSON_CODEC_OPS,
    path: null,
    package: "protocol-codec",
    envVar: "PROTOCOL_CODEC_BIN",
    fileName: "protocol-codec-adapter",
    label: "protocol-codec-adapter",
  },
];

function cargoAvailable(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function binPath(bin: RustBin): string | null {
  if (bin.path) return bin.path;
  const candidates = [
    process.env[bin.envVar],
    join(REPO_ROOT, "target/debug", bin.fileName),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  const found = candidates.find((p) => existsSync(p));
  if (found) {
    bin.path = found;
    return found;
  }
  if (!cargoAvailable()) return null;
  try {
    execFileSync("cargo", ["build", "-p", bin.package], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 300_000,
    });
  } catch {
    return null;
  }
  const built = candidates.find((p) => existsSync(p));
  bin.path = built ?? null;
  return bin.path;
}

export function rustAdapterAvailable(): boolean {
  return BINS.every((bin) => binPath(bin) !== null);
}

const ALL_OPS = new Set(BINS.flatMap((b) => [...b.ops]));

export const rustAdapter: Adapter = {
  name: "rust",
  ops: ALL_OPS,
  async run(): Promise<Observation> {
    // Batched path is used by the runner; single-step calls are unsupported.
    return { ok: false, error: "rust adapter is batch-only; use runRustScenario" };
  },
};

export interface RustBatchResult {
  observations: Observation[];
}

function runBatch(bin: RustBin, path: string, steps: { op: string; input: Record<string, unknown> }[]): Observation[] {
  const dir = mkdtempSync(join(tmpdir(), `${bin.label}-`));
  const inPath = join(dir, "steps.json");
  const outPath = join(dir, "out.json");
  writeFileSync(inPath, JSON.stringify({ steps }));
  execFileSync(path, [inPath, outPath], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
  const parsed = JSON.parse(readFileSync(outPath, "utf8")) as RustBatchResult;
  if (!Array.isArray(parsed.observations) || parsed.observations.length !== steps.length) {
    throw new Error(`${bin.label} returned ${parsed.observations?.length ?? "?"} observations for ${steps.length} steps`);
  }
  return parsed.observations;
}

/**
 * Run a list of {op,input} steps through the Rust binaries in one process
 * per binary. Returns observations aligned by index; a step the binary
 * rejects still yields an {ok:false} observation rather than failing the
 * batch.
 */
export function runRustSteps(steps: { op: string; input: Record<string, unknown> }[]): Observation[] {
  const out: Observation[] = new Array(steps.length);
  const byBin = new Map<RustBin, { steps: typeof steps; indices: number[] }>();
  for (let i = 0; i < steps.length; i++) {
    const bin = BINS.find((b) => b.ops.has(steps[i]!.op));
    if (!bin) {
      out[i] = { ok: false, error: `rust adapter: unknown op "${steps[i]!.op}"` };
      continue;
    }
    const group = byBin.get(bin) ?? { steps: [], indices: [] };
    group.steps.push(steps[i]!);
    group.indices.push(i);
    byBin.set(bin, group);
  }
  for (const [bin, group] of byBin) {
    const path = binPath(bin);
    if (!path) {
      const msg = `rust ${bin.label} unavailable: set ${bin.envVar} or install the Rust toolchain (cargo)`;
      for (const i of group.indices) out[i] = { ok: false, error: msg };
      continue;
    }
    const observations = runBatch(bin, path, group.steps);
    group.indices.forEach((stepIndex, j) => {
      out[stepIndex] = observations[j]!;
    });
  }
  return out;
}
