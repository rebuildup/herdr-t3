/*
 * Plugin-backed secrets store (ADR-0011 boundary; issue #454).
 *
 * `rebuildup.secrets` on each target host resolves declared env bindings
 * against the Infisical provider and routes resolved values to exactly
 * two sinks: a wrapped child's environment (`run`) and herdr surface
 * creation `env` params (`inject`) — contract
 * `herdr-plugins.secrets/v1`, pinned at
 * rebuildup/hoxay-plugins@d23205af (v0.9.0,
 * docs/contracts/secrets-v1.md; boundary ADR-0027 upstream).
 *
 * VALUE GUARANTEE (ADR-0027, non-negotiable): no command in this
 * contract ever returns, logs, persists, or places in argv a resolved
 * secret value. `resolve` is metadata-only — there is deliberately no
 * eval/`--emit-env` escape hatch in v1. This client mirrors that
 * boundary: every parser below drops any field that could carry a
 * value, mutation results render `env_names` (names only) and surface
 * ids, and error text is the plugin's own sanitized diagnostics —
 * provider stderr/stdout are never echoed by the contract, and this
 * client never renders raw provider output regardless (the pinned
 * contract doc states the guarantee; the v0.1.1 provider-stderr
 * sanitization fix on the unpublished release train only strengthens
 * it).
 *
 * Consumed commands:
 * - `capability` — the eager per-machine read: provider block (domain,
 *   CLI availability/version, projectId configured, reachability),
 *   binding declarations, invalid_bindings, config_warnings. At the
 *   pinned plugin (v0.1.1) the document has NO `mutation_commands`
 *   field (added upstream in plugin v0.2.0); mutations are gated by
 *   the local allowlist intersected with the advertised `commands`
 *   list — and, when a newer plugin DOES advertise `mutation_commands`,
 *   membership there is required too (fail-closed both ways).
 * - `resolve --binding <name>...` — metadata-only resolve preview,
 *   fetched on demand. NOTE: the contract exits 1 when any binding is
 *   unresolved while still printing the full report on stdout; the
 *   bridge returns that `ok:false` document as the result (same
 *   partial-report convention as checkpoints), so per-binding statuses
 *   render verbatim.
 * - `run --binding <name>... -- <cmd> [args...]` and
 *   `inject --binding <name>... --surface <kind> [opts]` — mutations,
 *   each behind an explicit confirmation dialog. `run`'s child
 *   inherits the plugin's stdio, which the plugin_call bridge pipes
 *   and JSON-parses: a successful run therefore surfaces as a
 *   bridge-level `plugin_bad_output`/`plugin_error`, never as a
 *   success document. The env injection still happens plugin-side;
 *   the surface labels this honestly instead of fabricating a result.
 * - `config` is advertised but never invoked (`--init` writes config;
 *   a plain `config` call is only a metadata read the capability
 *   document already covers).
 *
 * Freshness mirrors `textgen.ts`: the capability document refetches on
 * session-snapshot pushes (debounced), when a machine reaches
 * `online`, and as machines come and go.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import { pluginHerdrSkew, type PluginCallResult } from "../../shared/protocol";
import { getBridgeState } from "./bridge";
import { pluginBoundaryReason, pluginErrorCode, pluginErrorDetail } from "./pluginErrors";

export const SECRETS_PLUGIN_ID = "rebuildup.secrets";
export const SECRETS_CONTRACT_PREFIX = "herdr-plugins.secrets/";
/** Commands this surface requires for the read side. */
const REQUIRED_COMMANDS = [
  "capability",
  "resolve",
  "run",
  "inject",
  "config",
] as const;

/**
 * Mutation commands this surface may invoke. Both are side effects:
 * `run` spawns a child with resolved env, `inject` creates a herdr
 * surface carrying resolved env. There is deliberately NO `config`
 * mutation (`--init` writes config.json) and no eval/emit command —
 * the contract has none.
 */
export const SECRETS_MUTATION_COMMANDS = ["run", "inject"] as const;
export type SecretsMutationCommand = (typeof SECRETS_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type SecretsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type SecretsMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: SecretsUnavailableReason; detail?: string };

export interface SecretsMachineState {
  status: SecretsMachineStatus;
  /** Latest parsed `capability` document; null until the first success. */
  capability: SecretsCapability | null;
  /** Classified failure detail when the last capability fetch failed. */
  capabilityError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** `provider.cli` — infisical binary detection (version output only). */
export interface SecretsCliInfo {
  bin: string | null;
  available: boolean;
  version: string | null;
  /** Sanitized detail (e.g. exit code) — never provider output. */
  detail: string | null;
}

/** `provider.reachability` — `not_checked` until `capability --probe`. */
export interface SecretsReachability {
  status: string;
  detail: string | null;
}

/** `provider` block of the capability document. */
export interface SecretsProvider {
  name: string | null;
  domain: string | null;
  cli: SecretsCliInfo | null;
  projectIdConfigured: boolean;
  reachability: SecretsReachability | null;
}

/** One declared binding — metadata only (name/env/ref/projectId). */
export interface SecretsBinding {
  name: string;
  env: string | null;
  ref: string | null;
  projectId: string | null;
}

/** One `invalid_bindings[]` entry (`{name, error}` upstream). */
export interface SecretsInvalidBinding {
  name: string;
  error: string | null;
}

/**
 * Parsed `capability` document. Field names stay camelCase; every
 * value is a declaration or diagnostic — the document cannot carry a
 * secret value by contract, and the parser would drop unknown fields
 * anyway.
 */
export interface SecretsCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  plugin: string | null;
  provider: SecretsProvider | null;
  bindings: SecretsBinding[];
  invalidBindings: SecretsInvalidBinding[];
  configWarnings: string[];
  commands: Set<string>;
  /** Present only on plugin >= v0.2.0; empty set when unadvertised. */
  mutationCommands: Set<string>;
  generatedAt: string | null;
}

/** One `resolve`/`run`/`inject` per-binding report row. */
export interface SecretsBindingReport {
  name: string;
  env: string | null;
  ref: string | null;
  /** resolved | unresolved | provider_unreachable | auth_missing |
      provider_error | config_error — verbatim, never guessed. */
  status: string;
  detail: string | null;
}

/** `resolve` document — metadata-only; there is no value field. */
export interface SecretsResolveReport {
  ok: boolean;
  bindings: SecretsBindingReport[];
  generatedAt: string | null;
}

/** `inject` success document — ids and env NAMES only, never values. */
export interface SecretsInjectResult {
  surface: string | null;
  paneId: string | null;
  tabId: string | null;
  workspaceId: string | null;
  /** Injected env var names — the contract guarantees names only. */
  envNames: string[];
}

/** Options for the `inject` mutation (contract flag mapping). */
export interface SecretsInjectOptions {
  surface: "workspace" | "tab" | "pane";
  workspaceId?: string | undefined;
  targetPaneId?: string | undefined;
  direction?: "right" | "down" | undefined;
  cwd?: string | undefined;
  label?: string | undefined;
  focus?: boolean | undefined;
  ratio?: number | undefined;
}

/* --------------------------- doc parsers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    (typeof contract === "string" && contract.startsWith(SECRETS_CONTRACT_PREFIX))
  );
}

function bindingFromDoc(raw: unknown): SecretsBinding | null {
  if (!isRecord(raw)) return null;
  const name = str(raw["name"]);
  if (name === null || name === "") return null;
  return {
    name,
    env: str(raw["env"]),
    ref: str(raw["ref"]),
    projectId: str(raw["projectId"]),
  };
}

function invalidBindingFromDoc(raw: unknown): SecretsInvalidBinding | null {
  if (!isRecord(raw)) return null;
  const name = str(raw["name"]);
  if (name === null || name === "") return null;
  return { name, error: str(raw["error"]) };
}

function bindingReportFromDoc(raw: unknown): SecretsBindingReport | null {
  if (!isRecord(raw)) return null;
  const name = str(raw["name"]);
  const status = str(raw["status"]);
  if (name === null || name === "" || status === null || status === "") return null;
  // NOTE: any `value`/`env_value`-style field a buggy plugin might add is
  // deliberately NOT parsed — reports are metadata-only by contract.
  return {
    name,
    env: str(raw["env"]),
    ref: str(raw["ref"]),
    status,
    detail: str(raw["detail"]),
  };
}

function providerFromDoc(raw: unknown): SecretsProvider | null {
  if (!isRecord(raw)) return null;
  const cliRaw = isRecord(raw["cli"]) ? raw["cli"] : null;
  const reachRaw = isRecord(raw["reachability"]) ? raw["reachability"] : null;
  return {
    name: str(raw["name"]),
    domain: str(raw["domain"]),
    cli:
      cliRaw === null
        ? null
        : {
            bin: str(cliRaw["bin"]),
            available: cliRaw["available"] === true,
            version: str(cliRaw["version"]),
            detail: str(cliRaw["detail"]),
          },
    projectIdConfigured: raw["project_id_configured"] === true,
    reachability:
      reachRaw === null
        ? null
        : { status: str(reachRaw["status"]) ?? "unknown", detail: str(reachRaw["detail"]) },
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function secretsCapabilityFromDoc(
  doc: Record<string, unknown>,
): SecretsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(SECRETS_CONTRACT_PREFIX)) {
    return null;
  }
  const bindings: SecretsBinding[] = [];
  for (const entry of Array.isArray(doc["bindings"]) ? doc["bindings"] : []) {
    const binding = bindingFromDoc(entry);
    if (binding !== null) bindings.push(binding);
  }
  const invalidBindings: SecretsInvalidBinding[] = [];
  for (const entry of Array.isArray(doc["invalid_bindings"]) ? doc["invalid_bindings"] : []) {
    const invalid = invalidBindingFromDoc(entry);
    if (invalid !== null) invalidBindings.push(invalid);
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    plugin: str(doc["plugin"]),
    provider: providerFromDoc(doc["provider"]),
    bindings,
    invalidBindings,
    configWarnings: strArray(doc["config_warnings"]),
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    generatedAt: str(doc["generated_at"]),
  };
}

/** `resolve` document; null on a foreign contract or missing bindings. */
export function secretsResolveFromDoc(
  doc: Record<string, unknown>,
): SecretsResolveReport | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "resolve") return null;
  const bindingsRaw = doc["bindings"];
  if (!Array.isArray(bindingsRaw)) return null;
  const bindings: SecretsBindingReport[] = [];
  for (const raw of bindingsRaw) {
    const report = bindingReportFromDoc(raw);
    if (report !== null) bindings.push(report);
  }
  return {
    ok: doc["ok"] === true,
    bindings,
    generatedAt: str(doc["generated_at"]),
  };
}

/** `inject` success document; null on foreign contract or missing injected block. */
export function secretsInjectFromDoc(
  doc: Record<string, unknown>,
): SecretsInjectResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "inject" || doc["ok"] !== true) return null;
  const injectedRaw = isRecord(doc["injected"]) ? doc["injected"] : null;
  if (injectedRaw === null) return null;
  return {
    surface: str(injectedRaw["surface"]),
    paneId: str(injectedRaw["pane_id"]),
    tabId: str(injectedRaw["tab_id"]),
    workspaceId: str(injectedRaw["workspace_id"]),
    envNames: strArray(injectedRaw["env_names"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the shared boundary taxonomy.
 * Plugin-side `kind` values (`config_error`, `resolution_failed`,
 * `spawn_failed`, `usage`, …) become the error `code` upstream and
 * stay "error" here with the plugin's own wording — nothing is
 * fabricated, and provider output is never part of the message
 * (contract guarantee; this client adds no raw stderr rendering).
 */
export function classifySecretsError(error: unknown): {
  reason: SecretsUnavailableReason;
  detail: string;
} {
  const detail = pluginErrorDetail(error);
  const boundary = pluginBoundaryReason(pluginErrorCode(error));
  return boundary === null ? { reason: "error", detail } : { reason: boundary, detail };
}

/**
 * The plugin's structured `error.hint`/`error.kind` carried across the
 * bridge in `ApiError.fields`. `kind` is the contract's real
 * classification (`resolution_failed`, `config_error`, …) — returned
 * verbatim so the surface can badge it; never invented.
 */
export function secretsErrorKind(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  const kind = fields["kind"];
  return typeof kind === "string" && kind !== "" ? kind : null;
}

export function secretsErrorHint(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  const hint = fields["hint"];
  return typeof hint === "string" && hint !== "" ? hint : null;
}

/* --------------------------- argv builders (pure) --------------------- */

/**
 * `resolve --binding <name>...`. Binding names are validated
 * plugin-side; this builder only emits the flags — it can never carry
 * a secret value because the contract has no value input at all.
 */
export function secretsResolveArgs(bindingNames: string[]): string[] {
  const args: string[] = [];
  for (const name of bindingNames) {
    if (name !== "") args.push("--binding", name);
  }
  return args;
}

/**
 * `run --binding <name>... -- <cmd> [args...]`. The `--` separator is
 * mandatory: without it the plugin would parse the command's own flags.
 * Command/args are user-supplied argv — they pass through verbatim and
 * are NEVER inspected for secret material here (the contract forbids
 * values in argv; a user typing one is their own disclosure).
 */
export function secretsRunArgs(
  bindingNames: string[],
  command: string,
  commandArgs: string[] = [],
): string[] {
  const args = secretsResolveArgs(bindingNames);
  args.push("--", command, ...commandArgs);
  return args;
}

/**
 * `inject --binding <name>... --surface <kind> [opts]`. Only contract
 * flags are emitted; `env_names`-style output can never contain values.
 */
export function secretsInjectArgs(
  bindingNames: string[],
  options: SecretsInjectOptions,
): string[] {
  const args = secretsResolveArgs(bindingNames);
  args.push("--surface", options.surface);
  if (options.surface !== "workspace" && options.workspaceId !== undefined && options.workspaceId !== "") {
    args.push("--workspace", options.workspaceId);
  }
  if (options.targetPaneId !== undefined && options.targetPaneId !== "") {
    args.push("--target-pane", options.targetPaneId);
  }
  if (options.direction !== undefined) {
    args.push("--direction", options.direction);
  }
  if (options.cwd !== undefined && options.cwd !== "") {
    args.push("--cwd", options.cwd);
  }
  if (options.label !== undefined && options.label !== "") {
    args.push("--label", options.label);
  }
  if (options.focus === true) {
    args.push("--focus");
  }
  if (
    options.ratio !== undefined &&
    Number.isFinite(options.ratio)
  ) {
    args.push("--ratio", String(options.ratio));
  }
  return args;
}

/* -------------------------------- reads -------------------------------- */

async function callSecrets(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: SECRETS_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`secrets plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/**
 * `resolve --binding ...` — metadata-only preview. Per contract the
 * command exits 1 when any binding is unresolved; the bridge surfaces
 * that `ok:false` stdout document as the result document, so this
 * returns a report with `ok:false` rather than throwing — per-binding
 * statuses ARE the answer. A transport/boundary failure still throws.
 */
export async function fetchSecretsResolve(
  machine: string,
  bindingNames: string[],
): Promise<SecretsResolveReport> {
  const doc = await callSecrets(machine, "resolve", secretsResolveArgs(bindingNames));
  const report = secretsResolveFromDoc(doc);
  if (report === null) throw badOutput("resolve");
  return report;
}

/**
 * `capability --probe` — reachability probe classifies provider
 * reachability/auth via a guaranteed-absent sentinel secret; it never
 * touches a real value. On-demand only (spawns the provider CLI).
 */
export async function fetchSecretsProbe(
  machine: string,
): Promise<SecretsCapability> {
  const doc = await callSecrets(machine, "capability", ["--probe"]);
  const cap = secretsCapabilityFromDoc(doc);
  if (cap === null) throw badOutput("capability --probe");
  return cap;
}

/* ----------------------------- mutations ------------------------------ */

/**
 * `run --binding ... -- <cmd>` — spawns the command with resolved env
 * (sink 1). WARNING (documented in docs/migration/contracts/
 * plugin-secrets.md): the child's stdio is inherited by the plugin
 * process, which the plugin_call bridge pipes and JSON-parses — a
 * successful run can therefore only surface as a bridge-level
 * `plugin_bad_output`/`plugin_error`, never a success document. The
 * env injection still happens; callers must treat ANY result as
 * "ran plugin-side, output not streamed" and never fabricate success.
 * Resolution failures (`resolution_failed`) DO come back as proper
 * contract errors before the child starts.
 */
export async function runSecretsCommand(
  machine: string,
  bindingNames: string[],
  command: string,
  commandArgs: string[] = [],
  timeoutMs?: number,
): Promise<void> {
  await callSecrets(
    machine,
    "run",
    secretsRunArgs(bindingNames, command, commandArgs),
    timeoutMs,
  );
}

/**
 * `inject --binding ... --surface ...` — creates a herdr surface with
 * resolved env in the creation params (sink 2). Returns ids and env
 * NAMES only; the contract guarantees no values are emitted.
 */
export async function injectSecretsEnv(
  machine: string,
  bindingNames: string[],
  options: SecretsInjectOptions,
  timeoutMs?: number,
): Promise<SecretsInjectResult> {
  const doc = await callSecrets(
    machine,
    "inject",
    secretsInjectArgs(bindingNames, options),
    timeoutMs,
  );
  const result = secretsInjectFromDoc(doc);
  if (result === null) throw badOutput("inject");
  return result;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<
  string,
  { cap: SecretsCapability | null; at: number }
>();
const capabilityInflight = new Map<string, Promise<SecretsCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin
 * answered but does not advertise the read surface.
 */
export function secretsCapability(
  machine: string,
): Promise<SecretsCapability | null> {
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
        plugin: SECRETS_PLUGIN_ID,
        command: "capability",
      });
      const cap = secretsCapabilityFromDoc(doc);
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

/** True when the host advertises a top-level `command`; null cap = probing. */
export function secretsSupports(
  cap: SecretsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating. `run`/`inject` are real side effects, so both must
 * hold: the command is in the local SECRETS_MUTATION_COMMANDS
 * allowlist AND advertised in the capability `commands` list. When the
 * plugin advertises `mutation_commands` (plugin >= v0.2.0; absent at
 * the v0.9.0 pin where secrets is v0.1.1), membership there is ALSO
 * required — an explicit deny can never be overridden by `commands`.
 * `null` cap = still probing.
 */
export function secretsSupportsMutation(
  cap: SecretsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(SECRETS_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  if (!cap.commands.has(command)) return false;
  if (cap.mutationCommands.size > 0 && !cap.mutationCommands.has(command)) {
    return false;
  }
  return true;
}

/* ------------------------------ store --------------------------------- */

const EMPTY: SecretsMachineState = {
  status: { kind: "loading" },
  capability: null,
  capabilityError: null,
};

const states = new Map<string, SecretsMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, SecretsMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: SecretsMachineState) {
  states.set(machine, next);
  emit();
}

export function getSecretsState(machine: string): SecretsMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useSecretsState(machine: string): SecretsMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getSecretsState(machine),
    () => getSecretsState(machine),
  );
}

/** Per-machine secrets status snapshot (stable identity per emit). */
export function useSecretsStates(): ReadonlyMap<string, SecretsMachineState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statesSnapshot,
    () => statesSnapshot,
  );
}

function capabilityOk(doc: PluginCallResult): { contract: string; version: string } | null {
  const contract = doc["contract"];
  const commands = doc["commands"];
  if (typeof contract !== "string" || !contract.startsWith(SECRETS_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's secrets projection: plugin discovery →
 * enabled check → `capability`. The capability document IS the eager
 * read (provider block + binding declarations + invalid bindings +
 * warnings); `resolve`/`run`/`inject` stay on-demand surface calls. A
 * capability failure keeps the machine `unavailable` but retains the
 * last-good document when one exists — same honesty shape as
 * textgen.ts.
 */
export async function refreshSecrets(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, capability: null, capabilityError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === SECRETS_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      // ADR-0011 §10: a plugin whose min_herdr_version exceeds the host's
      // reported herdr version is `incompatible`, same as a contract miss.
      const skew = pluginHerdrSkew(entry, getBridgeState().machines[machine]?.version);
      if (skew !== null) {
        setState(machine, {
          status: { kind: "unavailable", reason: "incompatible", detail: skew },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      const capabilityDoc = await pluginCall(machine, {
        plugin: SECRETS_PLUGIN_ID,
        command: "capability",
      });
      const cap = capabilityOk(capabilityDoc);
      if (!cap) {
        const contractDetail =
          typeof capabilityDoc["contract"] === "string"
            ? capabilityDoc["contract"]
            : undefined;
        setState(machine, {
          status: {
            kind: "unavailable",
            reason: "incompatible",
            ...(contractDetail !== undefined ? { detail: contractDetail } : {}),
          },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      const parsed = secretsCapabilityFromDoc(capabilityDoc);
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        capability: parsed ?? previous?.capability ?? null,
        capabilityError: null,
      });
    } catch (error) {
      const { reason, detail } = classifySecretsError(error);
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        capability: previous?.capability ?? null,
        capabilityError: null,
      });
    }
  })().finally(() => {
    inflight.delete(machine);
  });
  inflight.set(machine, promise);
  return promise;
}

/* ------------------------- lifecycle wiring -------------------------- */

function scheduleRefresh() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    // Refresh every machine that has ever resolved — binding/config
    // contents can change host-side without a bridge-visible event.
    for (const id of states.keys()) void refreshSecrets(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initSecrets(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshSecrets(machine.id);
    else if (machine.status === "offline" || machine.status === "disabled") {
      states.delete(machine.id);
      emit();
    }
  });
  onMachines((list) => {
    const known = new Set(list.map((m) => m.id));
    for (const id of [...states.keys()]) {
      if (!known.has(id)) {
        states.delete(id);
        emit();
      }
    }
    for (const m of list) {
      if (!states.has(m.id)) void refreshSecrets(m.id);
    }
  });
}
