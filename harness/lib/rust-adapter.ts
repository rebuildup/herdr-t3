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
 * - `crates/state-projections` (`state-projections-adapter` bin) — the
 *   product-intended state projections (issue #281).
 * - `crates/terminal-core` (`terminal-core-adapter` bin) — the
 *   product-intended terminal engine/session (issue #286), native
 *   libghostty-vt via FFI.
 * - `crates/terminal-render` (`terminal-render-adapter` bin) — the
 *   product-intended paint scene (issue #294), port of
 *   src/lib/ghostty/scene.ts.
 *
 * Both read a batch of steps as JSON and emit observations in the same
 * shape as the TS adapters, so the same fixtures and the same comparator
 * judge both sides. Steps are partitioned per binary and reassembled by
 * index, so scenarios may mix op families freely.
 *
 * Binary resolution: $DIFF_ADAPTER_BIN / $PROTOCOL_CODEC_BIN /
 * $STATE_PROJECTIONS_BIN / $TERMINAL_CORE_BIN, else target/debug/<name>,
 * built on demand via cargo when available.
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

/** state-projection ops served by the product crate (issue #281). */
const PROJECTION_OPS = new Set([
  "derive_workspace",
  "agent_entries",
  "agent_partition",
  "goto_eval",
  "canvas_view_model",
  "next_pane",
  "move_insert_index",
]);

/** terminal ops served by the product crate (issue #286). */
const TERMINAL_OPS = new Set([
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

/** terminal-render paint-scene ops (issue #294). */
const SCENE_OPS = new Set([
  "scene_new",
  "scene_write",
  "scene_collect",
  "scene_render",
  "scene_set",
  "scene_render_overlay",
  "scene_dispose",
]);

/** terminal-input policy ops (issue #301). */
const INPUT_OPS = new Set([
  "input_bypass_key_encoder",
  "input_focus_report",
  "input_pointer_drag_kind",
  "input_wheel_button",
  "input_sends_hover_motion",
  "input_mouse_report_cell",
  "input_engine_key_for",
  "input_composition",
]);

/** terminal-surface state-machine ops (issue #301, contract terminal-surface@1). */
const SURFACE_OPS = new Set([
  "surface_new",
  "surface_write",
  "surface_measure",
  "surface_scroll_to",
  "surface_scroll_by",
  "surface_scroll_to_bottom",
  "surface_host_scroll",
  "surface_cell_at",
  "surface_search",
  "surface_search_step",
  "surface_set_colors",
  "surface_set_background_opacity",
  "surface_set_font",
  "surface_set_read_only",
  "surface_set_mouse_capture",
  "surface_tick",
  "surface_blink_toggle",
  "surface_report_focus",
  "surface_composition_start",
  "surface_composition_end",
  "surface_before_input",
  "surface_key_down",
  "surface_key_up",
  "surface_pointer_down",
  "surface_pointer_move",
  "surface_pointer_up",
  "surface_pointer_cancel",
  "surface_pointer_leave",
  "surface_wheel",
  "surface_paste",
  "surface_get_selection_text",
  "surface_clear_selection",
  "surface_dispose",
]);

const BRIDGE_OPS = new Set([
  "bridge_new",
  "bridge_close",
  "subscribe_terminal",
  "unsubscribe_terminal",
  "terminal_input",
  "terminal_resize",
  "terminal_scroll",
  "terminal_mouse",
  "rpc",
  "deliver_welcome",
  "deliver_terminal",
  "deliver_shutdown",
  "close_client_conn",
  "inject_event",
  "set_detail",
  "sleep",
  "bridge_state",
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
  {
    ops: PROJECTION_OPS,
    path: null,
    package: "state-projections",
    envVar: "STATE_PROJECTIONS_BIN",
    fileName: "state-projections-adapter",
    label: "state-projections-adapter",
  },
  {
    ops: TERMINAL_OPS,
    path: null,
    package: "terminal-core",
    envVar: "TERMINAL_CORE_BIN",
    fileName: "terminal-core-adapter",
    label: "terminal-core-adapter",
  },
  {
    ops: SCENE_OPS,
    path: null,
    package: "terminal-render",
    envVar: "TERMINAL_RENDER_BIN",
    fileName: "terminal-render-adapter",
    label: "terminal-render-adapter",
  },
  {
    ops: INPUT_OPS,
    path: null,
    package: "terminal-input",
    envVar: "TERMINAL_INPUT_BIN",
    fileName: "terminal-input-adapter",
    label: "terminal-input-adapter",
  },
  {
    ops: SURFACE_OPS,
    path: null,
    package: "terminal-surface",
    envVar: "TERMINAL_SURFACE_BIN",
    fileName: "terminal-surface-adapter",
    label: "terminal-surface-adapter",
  },
  {
    ops: BRIDGE_OPS,
    path: null,
    package: "herdr-bridge",
    envVar: "HERDR_BRIDGE_BIN",
    fileName: "herdr-bridge-adapter",
    label: "herdr-bridge-adapter",
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
