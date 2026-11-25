/*
 * Plugin-backed checkpoints store (ADR-0011, ADR-0015; issue #260).
 *
 * `rebuildup.checkpoints` on the host owns hidden-ref worktree
 * checkpoints through the `herdr-plugins.checkpoints/v1` contract,
 * pinned at rebuildup/herdr-plugins@4aab1a7 (release-0-4-0). The
 * contract doc is docs/migration/contracts/plugin-checkpoints.md.
 *
 * Commands are flat words (`create`, `list`, `show`, `diff`, `delete`)
 * carried as the `plugin_call` command; `capability.commands`
 * advertises the same words and `mutation_commands` carries `create`
 * and `delete`. `create` resolves its repo either from an explicit
 * `--repo PATH` or from a pane id positional (the focused pane the
 * dialog was opened from); `list --repo` filters by canonical repo
 * root.
 *
 * Honest-state rules (ADR-0015): `show` reports `ref.exists:false`
 * while still returning the state entry — the ref may have been
 * deleted out-of-band and the client must render that, never drop the
 * row. `delete` is idempotent: `ref_existed:false` plus `warnings`
 * when the hidden ref was already gone or the repo unreachable.
 * v1 has no restore/auto-capture/GC — those stay upstream (herdr-plugins
 * #73–#75) and are not offered here.
 */
import { pluginCall } from "../lib/api";

export const CHECKPOINTS_PLUGIN_ID = "rebuildup.checkpoints";
export const CHECKPOINTS_CONTRACT_PREFIX = "herdr-plugins.checkpoints/";

/** Boundary-level unavailability (ADR-0011 §10). */
export type CheckpointsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

/**
 * Classified failure for any checkpoints-plugin call. `unavailable` is
 * a boundary failure (plugin missing/disabled/foreign contract);
 * `plugin` preserves the plugin's `error.kind` verbatim so
 * `unknown_checkpoint`, `cross_repo`, `sparse_checkout`, pane-resolution
 * and git kinds stay distinct.
 */
export type CheckpointsError =
  | { kind: "unavailable"; reason: CheckpointsUnavailableReason; detail: string }
  | { kind: "plugin"; code: string; detail: string };

/** Plugin `error.kind` values from the checkpoints-v1 contract. */
const CHECKPOINTS_ERROR_KINDS = new Set([
  // Repo resolution / capture refusals.
  "not_a_repo",
  "bare_repo",
  "empty_repo",
  "sparse_checkout",
  // State lookups.
  "unknown_checkpoint",
  "cross_repo",
  // Pane resolution (create via pane id).
  "pane_not_found",
  "no_pane_cwd",
  // Shared git-core spawn failures.
  "git_missing",
  "timeout",
  "git_error",
  "usage",
]);

/**
 * Classify a plugin_call failure. Boundary codes map to `unavailable`
 * reasons; every known plugin kind keeps its code; unknown codes
 * degrade to `plugin_error` rather than collapsing into a fake
 * success.
 */
export function classifyCheckpointsError(error: unknown): CheckpointsError {
  const code = (error as { code?: string })?.code ?? "";
  const detail = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "plugin_not_installed":
      return { kind: "unavailable", reason: "not_installed", detail };
    case "plugin_disabled":
      return { kind: "unavailable", reason: "disabled", detail };
    case "plugin_incompatible":
    case "plugin_unsupported_command":
    case "plugin_bad_output":
      return { kind: "unavailable", reason: "incompatible", detail };
    case "plugin_host_unreachable":
    case "machine_unavailable":
    case "connect_failed":
    case "unreachable":
      return { kind: "unavailable", reason: "unreachable", detail };
    default:
      if (CHECKPOINTS_ERROR_KINDS.has(code)) {
        return { kind: "plugin", code, detail };
      }
      return { kind: "plugin", code: "plugin_error", detail };
  }
}

/* ------------------------------ capability ---------------------------- */

/**
 * Per-host capability probe (`capability` command). `commands` carries
 * the flat command words; `mutationCommands` carries `create`/`delete`.
 * `contractOk` is false for a foreign/missing contract.
 */
export interface CheckpointsCapability {
  contractOk: boolean;
  contract: string;
  commands: Set<string>;
  mutationCommands: Set<string>;
  readOnly: boolean;
}

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return (
    contract === undefined ||
    (typeof contract === "string" && contract.startsWith(CHECKPOINTS_CONTRACT_PREFIX))
  );
}

/** Normalize a `capability` document; null when the contract is foreign. */
export function checkpointsCapabilityFromDoc(
  doc: Record<string, unknown>,
): CheckpointsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(CHECKPOINTS_CONTRACT_PREFIX)) {
    return null;
  }
  return {
    contractOk: true,
    contract,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    readOnly: doc["read_only"] === true,
  };
}

const capabilityCache = new Map<string, { cap: CheckpointsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<CheckpointsCapability | null>>();

/**
 * Per-host capability, cached briefly. Returns null on boundary failure
 * (plugin missing/disabled/unreachable); an object with empty `commands`
 * means the plugin answered but does not advertise the word — the
 * "not supported by this plugin version" case.
 */
export function checkpointsCapability(
  machine: string,
): Promise<CheckpointsCapability | null> {
  const cached = capabilityCache.get(machine);
  if (cached !== undefined) {
    const ttl = cached.cap === null ? CAPABILITY_ERROR_TTL_MS : CAPABILITY_TTL_MS;
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.cap);
  }
  const running = capabilityInflight.get(machine);
  if (running) return running;
  const promise = (async () => {
    try {
      const doc = await pluginCall(machine, {
        plugin: CHECKPOINTS_PLUGIN_ID,
        command: "capability",
      });
      const cap = checkpointsCapabilityFromDoc(doc);
      capabilityCache.set(machine, { cap, at: Date.now() });
      return cap;
    } catch {
      capabilityCache.set(machine, { cap: null, at: Date.now() });
      return null;
    } finally {
      capabilityInflight.delete(machine);
    }
  })();
  capabilityInflight.set(machine, promise);
  return promise;
}

/* ------------------------------ documents ------------------------------ */

/**
 * One checkpoint entry as stored in plugin state. Optional upstream
 * fields are omitted (not nulled) when absent; `files_summary` is the
 * bounded `git diff --name-status` captured at create time.
 */
export interface CheckpointEntry {
  id: string;
  repo_root: string;
  repo_key: string;
  ref: string;
  commit: string;
  head_sha: string;
  branch: string | null;
  created_at: string;
  label: string | null;
  files_summary: string | null;
  files_summary_truncated: boolean;
  submodules: string[];
}

function checkpointEntryFromDoc(raw: unknown): CheckpointEntry | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const repoRoot = str(raw["repo_root"]);
  const ref = str(raw["ref"]);
  const commit = str(raw["commit"]);
  const headSha = str(raw["head_sha"]);
  if (
    id === null ||
    id === "" ||
    repoRoot === null ||
    repoRoot === "" ||
    ref === null ||
    commit === null ||
    headSha === null
  ) {
    return null;
  }
  return {
    id,
    repo_root: repoRoot,
    repo_key: str(raw["repo_key"]) ?? "",
    ref,
    commit,
    head_sha: headSha,
    branch: str(raw["branch"]),
    created_at: str(raw["created_at"]) ?? "",
    label: str(raw["label"]),
    files_summary: str(raw["files_summary"]),
    files_summary_truncated: raw["files_summary_truncated"] === true,
    submodules: strArray(raw["submodules"]),
  };
}

/** `list` document: newest `created_at` first, plugin-paginated. */
export interface CheckpointsListResult {
  repo_root: string | null;
  count: number;
  total: number;
  truncated: boolean;
  checkpoints: CheckpointEntry[];
  generated_at: string | null;
}

export function checkpointsListFromDoc(
  doc: Record<string, unknown>,
): CheckpointsListResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "list") return null;
  const rawEntries = doc["checkpoints"];
  if (!Array.isArray(rawEntries)) return null;
  const checkpoints: CheckpointEntry[] = [];
  for (const raw of rawEntries) {
    const entry = checkpointEntryFromDoc(raw);
    if (entry !== null) checkpoints.push(entry);
  }
  return {
    repo_root: str(doc["repo_root"]),
    count: num(doc["count"]) ?? checkpoints.length,
    total: num(doc["total"]) ?? checkpoints.length,
    truncated: doc["truncated"] === true,
    checkpoints,
    generated_at: str(doc["generated_at"]),
  };
}

/** `show` hidden-ref status: `exists:false` is honest, never hidden. */
export interface CheckpointRefStatus {
  name: string;
  exists: boolean;
  oid: string | null;
}

export interface CheckpointSummary {
  output: string;
  truncated: boolean;
  bytes: number;
}

/** `show` document: entry + ref probe + bounded `git show --stat`. */
export interface CheckpointShowResult {
  checkpoint: CheckpointEntry;
  repo_root: string | null;
  ref: CheckpointRefStatus | null;
  summary: CheckpointSummary | null;
  summary_error: string | null;
  generated_at: string | null;
}

export function checkpointShowFromDoc(
  doc: Record<string, unknown>,
): CheckpointShowResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "show") return null;
  const checkpoint = checkpointEntryFromDoc(doc["checkpoint"]);
  if (checkpoint === null) return null;
  let ref: CheckpointRefStatus | null = null;
  const rawRef = doc["ref"];
  if (isRecord(rawRef)) {
    const name = str(rawRef["name"]);
    if (name !== null) {
      ref = { name, exists: rawRef["exists"] === true, oid: str(rawRef["oid"]) };
    }
  }
  let summary: CheckpointSummary | null = null;
  const rawSummary = doc["summary"];
  if (isRecord(rawSummary)) {
    const output = str(rawSummary["output"]);
    if (output !== null) {
      summary = {
        output,
        truncated: rawSummary["truncated"] === true,
        bytes: num(rawSummary["bytes"]) ?? output.length,
      };
    }
  }
  return {
    checkpoint,
    repo_root: str(doc["repo_root"]),
    ref,
    summary,
    summary_error: str(doc["summary_error"]),
    generated_at: str(doc["generated_at"]),
  };
}

/** One `diff` side: `HEAD` or a checkpoint resolved to its hidden ref. */
export interface CheckpointDiffSide {
  kind: string;
  id: string | null;
  rev: string | null;
  commit: string | null;
}

/** `diff` document: bounded `git diff --no-color <revA> <revB>`. */
export interface CheckpointDiffResult {
  repo_root: string | null;
  a: CheckpointDiffSide;
  b: CheckpointDiffSide;
  patch: string;
  truncated: boolean;
  bytes: number;
  generated_at: string | null;
}

function checkpointDiffSideFromDoc(raw: unknown): CheckpointDiffSide | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw["kind"]);
  const rev = str(raw["rev"]);
  // `rev` is always emitted (HEAD literal or the checkpoint's hidden
  // ref); a side without it is malformed, not an empty diff.
  if (kind === null || rev === null) return null;
  return {
    kind,
    id: str(raw["id"]),
    rev,
    commit: str(raw["commit"]),
  };
}

export function checkpointDiffFromDoc(
  doc: Record<string, unknown>,
): CheckpointDiffResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "diff") return null;
  const a = checkpointDiffSideFromDoc(doc["a"]);
  const b = checkpointDiffSideFromDoc(doc["b"]);
  if (a === null || b === null) return null;
  const patch = str(doc["patch"]);
  if (patch === null) return null;
  return {
    repo_root: str(doc["repo_root"]),
    a,
    b,
    patch,
    truncated: doc["truncated"] === true,
    bytes: num(doc["bytes"]) ?? patch.length,
    generated_at: str(doc["generated_at"]),
  };
}

/** `create` document: the new entry plus capture warnings. */
export interface CheckpointCreateResult {
  pane_id: string | null;
  repo_root: string | null;
  checkpoint: CheckpointEntry;
  warnings: string[];
  generated_at: string | null;
}

export function checkpointCreateFromDoc(
  doc: Record<string, unknown>,
): CheckpointCreateResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "create" || doc["ok"] !== true) return null;
  const checkpoint = checkpointEntryFromDoc(doc["checkpoint"]);
  if (checkpoint === null) return null;
  return {
    pane_id: str(doc["pane_id"]),
    repo_root: str(doc["repo_root"]),
    checkpoint,
    warnings: strArray(doc["warnings"]),
    generated_at: str(doc["generated_at"]),
  };
}

/**
 * `delete` document. `ref_existed:false` is the honest idempotent
 * outcome (ref already gone or repo unreachable); `warnings` carries the
 * plugin's explanation — displayed verbatim, never swallowed.
 */
export interface CheckpointDeleteResult {
  id: string;
  ref: string;
  ref_existed: boolean;
  warnings: string[];
  generated_at: string | null;
}

export function checkpointDeleteFromDoc(
  doc: Record<string, unknown>,
): CheckpointDeleteResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "delete" || doc["ok"] !== true) return null;
  const id = str(doc["id"]);
  if (id === null || id === "") return null;
  return {
    id,
    ref: str(doc["ref"]) ?? "",
    ref_existed: doc["ref_existed"] === true,
    warnings: strArray(doc["warnings"]),
    generated_at: str(doc["generated_at"]),
  };
}

/* ------------------------- argv builders (pure) ------------------------ */

/**
 * Pure argv builders — exported so tests pin the exact contract shape
 * without a plugin host. `create` takes EITHER `--repo PATH` or a pane
 * id positional (never both — the plugin rejects the combination);
 * `--label` is an optional flag pair on either form.
 */
export function checkpointsListArgs(
  options: { repo?: string | undefined; limit?: number | undefined } = {},
): string[] {
  const args: string[] = [];
  const repo = options.repo?.trim() ?? "";
  if (repo !== "") args.push("--repo", repo);
  if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    args.push("--limit", String(options.limit));
  }
  return args;
}

export function checkpointShowArgs(
  id: string,
  options: { maxBytes?: number | undefined } = {},
): string[] {
  const args = [id];
  if (options.maxBytes !== undefined && options.maxBytes > 0) {
    args.push("--max-bytes", String(options.maxBytes));
  }
  return args;
}

export function checkpointDiffArgs(
  a: string,
  b: string,
  options: { maxBytes?: number | undefined } = {},
): string[] {
  const args = [a, b];
  if (options.maxBytes !== undefined && options.maxBytes > 0) {
    args.push("--max-bytes", String(options.maxBytes));
  }
  return args;
}

export function checkpointCreateArgs(
  target: { repo?: string | undefined; paneId?: string | undefined },
  options: { label?: string | undefined } = {},
): string[] {
  const args: string[] = [];
  const repo = target.repo?.trim() ?? "";
  const paneId = target.paneId?.trim() ?? "";
  if (repo !== "") {
    args.push("--repo", repo);
  } else if (paneId !== "") {
    args.push(paneId);
  }
  const label = options.label?.trim() ?? "";
  if (label !== "") args.push("--label", label);
  return args;
}

export function checkpointDeleteArgs(id: string): string[] {
  return [id];
}

/* ------------------------------ fetchers -------------------------------- */

function badOutput(command: string): Error {
  const error = new Error(`checkpoints plugin returned an unrecognized ${command} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/**
 * `list [--repo PATH] [--limit N]` — host-global state read; works
 * without a live herdr session for `--repo`-less listings of plugin
 * state (the filter itself resolves a repo, so `--repo` needs git).
 */
export async function fetchCheckpointsList(
  machine: string,
  options: { repo?: string | undefined; limit?: number | undefined } = {},
): Promise<CheckpointsListResult> {
  const doc = await pluginCall(machine, {
    plugin: CHECKPOINTS_PLUGIN_ID,
    command: "list",
    args: checkpointsListArgs(options),
  });
  const result = checkpointsListFromDoc(doc);
  if (result === null) throw badOutput("list");
  return result;
}

/** `show <id> [--max-bytes N]` — entry + ref probe + bounded stat. */
export async function fetchCheckpointShow(
  machine: string,
  id: string,
  options: { maxBytes?: number | undefined } = {},
): Promise<CheckpointShowResult> {
  const doc = await pluginCall(machine, {
    plugin: CHECKPOINTS_PLUGIN_ID,
    command: "show",
    args: checkpointShowArgs(id, options),
  });
  const result = checkpointShowFromDoc(doc);
  if (result === null) throw badOutput("show");
  return result;
}

/**
 * `diff <id|HEAD> <id|HEAD> [--max-bytes N]` — at least one side must be
 * a checkpoint id; cross-repo pairs fail `cross_repo` plugin-side.
 */
export async function fetchCheckpointDiff(
  machine: string,
  a: string,
  b: string,
  options: { maxBytes?: number | undefined } = {},
): Promise<CheckpointDiffResult> {
  const doc = await pluginCall(machine, {
    plugin: CHECKPOINTS_PLUGIN_ID,
    command: "diff",
    args: checkpointDiffArgs(a, b, options),
  });
  const result = checkpointDiffFromDoc(doc);
  if (result === null) throw badOutput("diff");
  return result;
}

/**
 * `create [--repo PATH | <pane_id>] [--label TEXT]` — mutation; writes a
 * hidden ref + state entry plugin-side. The user's index/worktree are
 * never touched. Returns the new entry and capture warnings.
 */
export async function createCheckpoint(
  machine: string,
  target: { repo?: string | undefined; paneId?: string | undefined },
  options: { label?: string | undefined } = {},
): Promise<CheckpointCreateResult> {
  const doc = await pluginCall(machine, {
    plugin: CHECKPOINTS_PLUGIN_ID,
    command: "create",
    args: checkpointCreateArgs(target, options),
  });
  const result = checkpointCreateFromDoc(doc);
  if (result === null) throw badOutput("create");
  return result;
}

/**
 * `delete <id>` — mutation; removes the state entry always and the
 * hidden ref when it still exists. Idempotent: `ref_existed:false` +
 * `warnings` when the ref was already gone — displayed as returned.
 */
export async function deleteCheckpoint(
  machine: string,
  id: string,
): Promise<CheckpointDeleteResult> {
  const doc = await pluginCall(machine, {
    plugin: CHECKPOINTS_PLUGIN_ID,
    command: "delete",
    args: checkpointDeleteArgs(id),
  });
  const result = checkpointDeleteFromDoc(doc);
  if (result === null) throw badOutput("delete");
  return result;
}
