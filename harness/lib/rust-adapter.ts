import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, Observation } from "./types.ts";

/**
 * Rust adapter client (issue #237): `crates/diff-adapter` is a minimal
 * non-product reference implementation. It reads a batch of steps as
 * JSON and emits observations in the same shape as the TS adapters, so
 * the same fixtures and the same comparator judge both sides.
 *
 * Binary resolution: $DIFF_ADAPTER_BIN, else target/debug/diff-adapter,
 * built on demand via `cargo build -p diff-adapter` when cargo exists.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BIN_CANDIDATES = [
  process.env["DIFF_ADAPTER_BIN"],
  join(REPO_ROOT, "target/debug/diff-adapter"),
].filter((p): p is string => typeof p === "string" && p.length > 0);

let binPath: string | null = null;
let buildAttempted = false;

function cargoAvailable(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function rustAdapterAvailable(): boolean {
  if (binPath) return true;
  if (BIN_CANDIDATES.some((p) => existsSync(p))) {
    binPath = BIN_CANDIDATES.find((p) => existsSync(p))!;
    return true;
  }
  if (buildAttempted) return false;
  buildAttempted = true;
  if (!cargoAvailable()) return false;
  try {
    execFileSync("cargo", ["build", "-p", "diff-adapter"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 300_000,
    });
  } catch {
    return false;
  }
  const built = BIN_CANDIDATES.find((p) => existsSync(p));
  if (built) binPath = built;
  return binPath !== null;
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

export const rustAdapter: Adapter = {
  name: "rust",
  ops: CODEC_OPS,
  async run(): Promise<Observation> {
    // Batched path is used by the runner; single-step calls are unsupported.
    return { ok: false, error: "rust adapter is batch-only; use runRustScenario" };
  },
};

export interface RustBatchResult {
  observations: Observation[];
}

/**
 * Run a list of {op,input} steps through the Rust binary in one process.
 * Returns observations aligned by index; a step the binary rejects still
 * yields an {ok:false} observation rather than failing the batch.
 */
export function runRustSteps(steps: { op: string; input: Record<string, unknown> }[]): Observation[] {
  if (!rustAdapterAvailable()) {
    throw new Error(
      "rust diff-adapter unavailable: set DIFF_ADAPTER_BIN or install the Rust toolchain (cargo)",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "diff-adapter-"));
  const inPath = join(dir, "steps.json");
  const outPath = join(dir, "out.json");
  writeFileSync(inPath, JSON.stringify({ steps }));
  execFileSync(binPath!, [inPath, outPath], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
  const parsed = JSON.parse(readFileSync(outPath, "utf8")) as RustBatchResult;
  if (!Array.isArray(parsed.observations) || parsed.observations.length !== steps.length) {
    throw new Error(`rust diff-adapter returned ${parsed.observations?.length ?? "?"} observations for ${steps.length} steps`);
  }
  return parsed.observations;
}
