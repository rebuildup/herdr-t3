/*
 * Secrets surface (issue #454, ADR-0011 boundary): the host's
 * `rebuildup.secrets` plugin (`herdr-plugins.secrets/v1` pinned at
 * rebuildup/hoxay-plugins@d23205af, v0.9.0) resolves declared env
 * bindings against Infisical and routes values to exactly two sinks —
 * a wrapped child's environment (`run`) and herdr surface-creation
 * `env` params (`inject`).
 *
 * VALUE GUARANTEE (ADR-0027): this surface NEVER renders, logs, or
 * places a resolved secret value anywhere — not in the DOM, not in
 * copied text, not in argv builders. `resolve` is metadata-only; the
 * parsers in src/shell/secrets.ts drop any value-shaped field; mutation
 * results render `env_names` (names only) and surface ids. Provider
 * stderr/stdout are never displayed regardless of plugin version —
 * only the contract's sanitized `detail`/`error` fields render.
 *
 * Reads: `capability` eagerly (provider block + binding declarations +
 * invalid bindings + warnings), `capability --probe` and `resolve`
 * on demand. Mutations: `inject` (surface picker) and `run` (command
 * line) — both behind explicit confirmation dialogs and gated by
 * `secretsSupportsMutation`. `run`'s child inherits the plugin's
 * stdio, which the plugin_call bridge cannot stream: a successful run
 * surfaces as a bridge-level error, never a fabricated success — the
 * surface says so verbatim.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlayIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";

import { StatusBadge, type StatusBadgeStatus } from "./ui/status-badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { RefreshIcon } from "./ui/refresh-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  classifySecretsError,
  fetchSecretsProbe,
  fetchSecretsResolve,
  injectSecretsEnv,
  refreshSecrets,
  runSecretsCommand,
  secretsErrorHint,
  secretsErrorKind,
  secretsSupports,
  secretsSupportsMutation,
  useSecretsState,
  type SecretsBinding,
  type SecretsCapability,
  type SecretsInjectOptions,
  type SecretsInjectResult,
  type SecretsReachability,
  type SecretsResolveReport,
  type SecretsUnavailableReason,
} from "../shell/secrets";

const UNAVAILABLE_LABELS: Record<SecretsUnavailableReason, string> = {
  not_installed: "secrets plugin not installed",
  disabled: "secrets plugin disabled",
  incompatible: "secrets contract incompatible",
  unreachable: "secrets host unreachable",
  error: "secrets unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifySecretsError(error);
  const kind = secretsErrorKind(error);
  const hint = secretsErrorHint(error);
  const base = `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
  const tagged = kind !== null ? `${base} [${kind}]` : base;
  return hint !== null ? `${tagged} (${hint})` : tagged;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function resolveStatus(
  status: string,
): StatusBadgeStatus {
  switch (status) {
    case "resolved":
    case "ok":
      return "ok";
    case "unresolved":
    case "auth_missing":
    case "config_error":
      return "error";
    case "provider_unreachable":
    case "provider_error":
      return "warning";
    default:
      return "neutral";
  }
}

/* ---------------------------- provider section ------------------------ */

function ProviderSection({
  machine,
  capability,
}: {
  machine: string;
  capability: SecretsCapability;
}) {
  const provider = capability.provider;
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<SecretsReachability | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const runProbe = useCallback(() => {
    if (probing) return;
    setProbing(true);
    setProbeError(null);
    fetchSecretsProbe(machine)
      .then((cap) => setProbe(cap.provider?.reachability ?? null))
      .catch((e: unknown) => setProbeError(errorText(e)))
      .finally(() => setProbing(false));
  }, [machine, probing]);

  if (provider === null) return null;
  const reachability = probe ?? provider.reachability;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Provider
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={runProbe}
          disabled={probing}
          title="capability --probe: classify provider reachability/auth via a guaranteed-absent sentinel — never touches a real secret"
        >
          <ShieldCheckIcon className={probing ? "animate-pulse" : undefined} />
          {probing ? "Probing…" : "Probe reachability"}
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-2xs text-muted-foreground">{provider.name ?? "provider"}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-2xs">
            {provider.domain ?? "—"}
          </span>
          <StatusBadge size="sm" status={provider.projectIdConfigured ? "ok" : "warning"}>
            {provider.projectIdConfigured ? "project id set" : "no project id"}
          </StatusBadge>
        </div>
        {provider.cli !== null ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            <span className="shrink-0">
              cli {provider.cli.bin ?? "?"}{" "}
              {provider.cli.available ? (
                <StatusBadge size="sm" status="ok">
                  available
                </StatusBadge>
              ) : (
                <StatusBadge size="sm" status="error">
                  missing
                </StatusBadge>
              )}
            </span>
            {provider.cli.version !== null ? (
              <span className="min-w-0 truncate">{provider.cli.version}</span>
            ) : null}
            {provider.cli.detail !== null ? (
              <span className="min-w-0 truncate text-muted-foreground/70">
                {provider.cli.detail}
              </span>
            ) : null}
          </div>
        ) : null}
        {reachability !== null ? (
          <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
            <span className="shrink-0">reachability</span>
            <StatusBadge size="sm" status={resolveStatus(reachability.status)}>
              {reachability.status}
            </StatusBadge>
            {reachability.detail !== null ? (
              <span className="min-w-0 truncate text-muted-foreground/70">
                {reachability.detail}
              </span>
            ) : null}
            {probe !== null ? (
              <span className="shrink-0 text-muted-foreground/70">(probed now)</span>
            ) : (
              <span className="shrink-0 text-muted-foreground/70">(last capability report)</span>
            )}
          </div>
        ) : null}
      </div>
      {probeError !== null ? (
        <p className="text-2xs text-destructive">probe failed: {probeError}</p>
      ) : null}
    </section>
  );
}

/* ---------------------------- bindings section ------------------------ */

function BindingsSection({
  capability,
  selected,
  onToggle,
}: {
  capability: SecretsCapability;
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Bindings{" "}
        <span className="normal-case text-muted-foreground/70">
          (metadata only — select rows for resolve / inject / run)
        </span>
      </h3>
      {capability.bindings.length === 0 && capability.invalidBindings.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          no bindings declared in config.json on this host
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {capability.bindings.map((binding) => {
            const isSelected = selected.has(binding.name);
            return (
              // oxlint-disable-next-line herdr-t3/no-raw-control -- composite row (badge + env/ref text + select toggle), same pattern as surface rows
              <button
                key={binding.name}
                type="button"
                onClick={() => onToggle(binding.name)}
                className={`flex min-w-0 flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
                  isSelected
                    ? "border-primary/60 bg-accent/40"
                    : "border-border/60 hover:bg-accent/30"
                }`}
                aria-pressed={isSelected}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-2xs text-muted-foreground">{binding.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                    {binding.env ?? "—"}
                  </span>
                  {binding.projectId !== null ? (
                    <span className="shrink-0 text-2xs text-muted-foreground/70">
                      project {binding.projectId}
                    </span>
                  ) : null}
                </div>
                <p className="truncate font-mono text-2xs text-muted-foreground/80">
                  {binding.ref ?? "—"}
                </p>
              </button>
            );
          })}
          {capability.invalidBindings.map((invalid) => (
            <div
              key={`invalid-${invalid.name}`}
              className="flex min-w-0 flex-col gap-0.5 rounded-md border border-destructive/40 px-2 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge size="sm" status="error">
                  {invalid.name}
                </StatusBadge>
                <span className="text-2xs text-destructive">invalid binding</span>
              </div>
              {invalid.error !== null ? (
                <p className="text-2xs text-muted-foreground">{invalid.error}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------------------- resolve preview ------------------------- */

function ResolveSection({
  machine,
  capability,
  selectedNames,
}: {
  machine: string;
  capability: SecretsCapability;
  selectedNames: string[];
}) {
  const supported = secretsSupports(capability, "resolve");
  const [report, setReport] = useState<SecretsResolveReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runResolve = useCallback(() => {
    if (selectedNames.length === 0 || loading || supported !== true) return;
    setLoading(true);
    setError(null);
    fetchSecretsResolve(machine, selectedNames)
      .then(setReport)
      // ok:false is a REPORT (per-binding statuses), not a thrown error —
      // but a boundary failure still lands here.
      .catch((e: unknown) => {
        setReport(null);
        setError(errorText(e));
      })
      .finally(() => setLoading(false));
  }, [machine, selectedNames, loading, supported]);

  if (supported !== true) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Resolve preview
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={runResolve}
          disabled={loading || selectedNames.length === 0}
          title="Metadata-only: resolves each selected binding against the provider, discards the values, reports statuses. Secret values are never returned."
        >
          <PlayIcon className={loading ? "animate-pulse" : undefined} />
          {loading ? "Resolving…" : "Preview resolve"}
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground/70">
        metadata-only check — the contract has no value-returning command;
        statuses only
      </p>
      {error !== null ? (
        <p className="text-2xs text-destructive">resolve failed: {error}</p>
      ) : null}
      {report !== null ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <StatusBadge size="sm" status={report.ok ? "ok" : "warning"}>
              {report.ok ? "all resolved" : "not all resolved"}
            </StatusBadge>
            {report.generatedAt !== null ? (
              <span className="text-muted-foreground/70">
                {formatTime(report.generatedAt)}
              </span>
            ) : null}
          </div>
          {report.bindings.map((row) => (
            <div
              key={row.name}
              className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-2xs text-muted-foreground">{row.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                  {row.env ?? "—"}
                </span>
                <StatusBadge size="sm" status={resolveStatus(row.status)}>
                  {row.status}
                </StatusBadge>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
                {row.ref !== null ? (
                  <span className="min-w-0 truncate font-mono">{row.ref}</span>
                ) : null}
                {row.detail !== null ? (
                  <span className="min-w-0 truncate text-muted-foreground/70">
                    {row.detail}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------ mutations ----------------------------- */

type PendingMutation =
  | { kind: "inject"; options: SecretsInjectOptions }
  | { kind: "run"; command: string; args: string };

function MutationsSection({
  machine,
  capability,
  selected,
}: {
  machine: string;
  capability: SecretsCapability;
  selected: SecretsBinding[];
}) {
  const canRun = secretsSupportsMutation(capability, "run") === true;
  const canInject = secretsSupportsMutation(capability, "inject") === true;
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runCommand, setRunCommand] = useState("");
  const [runArgs, setRunArgs] = useState("");
  const [injectSurface, setInjectSurface] = useState<"workspace" | "tab" | "pane">("workspace");
  const [injectWorkspace, setInjectWorkspace] = useState("");
  const [injectTargetPane, setInjectTargetPane] = useState("");
  const [injectDirection, setInjectDirection] = useState<"right" | "down">("right");
  const [injectCwd, setInjectCwd] = useState("");
  const [injectLabel, setInjectLabel] = useState("");
  const [injectResult, setInjectResult] = useState<SecretsInjectResult | null>(null);

  const names = useMemo(() => selected.map((b) => b.name), [selected]);
  const envNames = useMemo(() => selected.map((b) => b.env).filter((v): v is string => v !== null), [selected]);

  const confirmPending = useCallback(() => {
    if (pending === null || busy || names.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const done = () => {
      setBusy(false);
      setPending(null);
    };
    if (pending.kind === "inject") {
      injectSecretsEnv(machine, names, pending.options)
        .then((result) => {
          setInjectResult(result);
          setNotice(
            `surface created — env: ${result.envNames.join(", ") || "(none)"}`,
          );
        })
        .catch((e: unknown) => setError(errorText(e)))
        .finally(done);
    } else {
      const cmdArgs = pending.args.trim() === "" ? [] : pending.args.trim().split(/\s+/);
      runSecretsCommand(machine, names, pending.command, cmdArgs, 120_000)
        .then(() => {
          // Unreachable in practice: a silent successful child yields a
          // bridge-level error, not a document. Kept honest — never a
          // fabricated success.
          setNotice("run completed (child output is not streamed through this surface)");
        })
        .catch((e: unknown) => {
          // `resolution_failed`/`spawn_failed` arrive as contract errors;
          // a silent successful child arrives as plugin_bad_output /
          // plugin_error — both rendered verbatim, never relabelled.
          setError(errorText(e));
        })
        .finally(done);
    }
  }, [pending, busy, names, machine]);

  if (!canRun && !canInject) return null;
  if (names.length === 0) {
    return (
      <section className="flex flex-col gap-1.5">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Mutations
        </h3>
        <p className="text-2xs text-muted-foreground">
          select at least one binding above to enable inject / run
        </p>
      </section>
    );
  }

  const pendingCopy =
    pending === null
      ? null
      : pending.kind === "inject"
        ? {
            title: "Inject secrets into a new herdr surface?",
            description: `Resolves ${names.join(", ")} and creates a ${pending.options.surface} carrying env ${envNames.join(", ")}. Values are injected into the surface's environment — never displayed.`,
            confirm: "Inject",
          }
        : {
            title: "Run command with resolved secrets?",
            description: `Resolves ${names.join(", ")} and spawns \`${pending.command}\` with env ${envNames.join(", ")}. The child's stdio is inherited plugin-side and is NOT streamed through this surface — a silent successful run reports as a bridge error.`,
            confirm: "Run",
          };

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Mutations{" "}
        <span className="normal-case text-muted-foreground/70">
          ({names.join(", ")} → {envNames.join(", ")})
        </span>
      </h3>
      <div className="flex flex-col gap-2 rounded-md border border-border/60 px-2 py-2">
        {canInject ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-muted-foreground">inject into</span>
            <Select
              value={injectSurface}
              onValueChange={(value) =>
                setInjectSurface(value as "workspace" | "tab" | "pane")
              }
            >
              <SelectTrigger aria-label="Inject surface" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">workspace</SelectItem>
                <SelectItem value="tab">tab</SelectItem>
                <SelectItem value="pane">pane</SelectItem>
              </SelectContent>
            </Select>
            {injectSurface !== "workspace" ? (
              <Input
                size="sm"
                value={injectWorkspace}
                onChange={(e) => setInjectWorkspace(e.target.value)}
                placeholder="workspace id"
                aria-label="Target workspace"
                className="w-32"
              />
            ) : null}
            {injectSurface === "pane" ? (
              <>
                <Input
                  size="sm"
                  value={injectTargetPane}
                  onChange={(e) => setInjectTargetPane(e.target.value)}
                  placeholder="target pane id"
                  aria-label="Target pane"
                  className="w-32"
                />
                <Select
                  value={injectDirection}
                  onValueChange={(value) =>
                    setInjectDirection(value as "right" | "down")
                  }
                >
                  <SelectTrigger aria-label="Split direction" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="right">right</SelectItem>
                    <SelectItem value="down">down</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ) : null}
            <Input
              size="sm"
              value={injectCwd}
              onChange={(e) => setInjectCwd(e.target.value)}
              placeholder="cwd (optional)"
              aria-label="Working directory"
              className="min-w-32 flex-1"
            />
            <Input
              size="sm"
              value={injectLabel}
              onChange={(e) => setInjectLabel(e.target.value)}
              placeholder="label (optional)"
              aria-label="Surface label"
              className="min-w-32 flex-1"
            />
            <Button
              size="xs"
              variant="default"
              disabled={busy}
              onClick={() =>
                setPending({
                  kind: "inject",
                  options: {
                    surface: injectSurface,
                    ...(injectWorkspace.trim() !== ""
                      ? { workspaceId: injectWorkspace.trim() }
                      : {}),
                    ...(injectTargetPane.trim() !== ""
                      ? { targetPaneId: injectTargetPane.trim() }
                      : {}),
                    ...(injectSurface === "pane"
                      ? { direction: injectDirection }
                      : {}),
                    ...(injectCwd.trim() !== "" ? { cwd: injectCwd.trim() } : {}),
                    ...(injectLabel.trim() !== "" ? { label: injectLabel.trim() } : {}),
                  },
                })
              }
            >
              <PlusIcon />
              Inject…
            </Button>
          </div>
        ) : null}
        {canRun ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-muted-foreground">run</span>
            <Input
              size="sm"
              value={runCommand}
              onChange={(e) => setRunCommand(e.target.value)}
              placeholder="command (e.g. infisical run -- printenv)"
              aria-label="Command to run"
              className="min-w-48 flex-1"
            />
            <Input
              size="sm"
              value={runArgs}
              onChange={(e) => setRunArgs(e.target.value)}
              placeholder="args (space-separated)"
              aria-label="Command arguments"
              className="min-w-32 flex-1"
            />
            <Button
              size="xs"
              variant="default"
              disabled={busy || runCommand.trim() === ""}
              onClick={() =>
                setPending({
                  kind: "run",
                  command: runCommand.trim(),
                  args: runArgs,
                })
              }
            >
              <PlayIcon />
              Run…
            </Button>
          </div>
        ) : null}
        {busy ? <span className="text-2xs text-muted-foreground">working…</span> : null}
        {notice !== null ? (
          <span className="text-2xs text-muted-foreground">{notice}</span>
        ) : null}
        {error !== null ? (
          <p className="text-2xs text-destructive">mutation failed: {error}</p>
        ) : null}
        {injectResult !== null ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="shrink-0">
              {injectResult.surface ?? "?"}
              {injectResult.workspaceId !== null ? ` · ws ${injectResult.workspaceId}` : ""}
              {injectResult.tabId !== null ? ` · tab ${injectResult.tabId}` : ""}
              {injectResult.paneId !== null ? ` · pane ${injectResult.paneId}` : ""}
            </span>
            {injectResult.envNames.map((name) => (
              <span key={name} className="font-mono text-2xs text-muted-foreground">
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pendingCopy?.title}</DialogTitle>
            <DialogDescription>{pendingCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant={pending?.kind === "run" ? "destructive" : "default"}
              disabled={busy || pending === null}
              onClick={confirmPending}
            >
              {busy ? "Working…" : pendingCopy?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/* ---------------------------- config warnings ------------------------- */

function WarningsSection({ capability }: { capability: SecretsCapability }) {
  if (capability.configWarnings.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Config warnings
      </h3>
      {capability.configWarnings.map((warning) => (
        <p key={warning} className="text-2xs text-warning">
          {warning}
        </p>
      ))}
    </section>
  );
}

/* -------------------------------- surface ------------------------------ */

export function SecretsSurface({ machine }: { machine: string }) {
  const state = useSecretsState(machine);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshSecrets(machine);
  }, [machine, state.status.kind]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshSecrets(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const capability = state.capability;
  const selectedBindings = useMemo(
    () => (capability?.bindings ?? []).filter((b) => selected.has(b.name)),
    [capability, selected],
  );
  const toggleBinding = useCallback((name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Secret bindings from the rebuildup.secrets plugin — declared
            env names resolved against Infisical and injected into child
            processes or new herdr surfaces.{" "}
            <span className="text-muted-foreground/80">
              Secret values are never displayed, logged, or placed in
              argv (ADR-0027); resolve reports statuses only.
            </span>
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh secrets"
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading secrets…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.capability !== null ? " (showing last known capability)" : ""}
          </p>
        ) : null}

        {state.capabilityError !== null ? (
          <p className="text-2xs text-destructive">
            capability failed: {state.capabilityError}
          </p>
        ) : null}

        {state.status.kind === "ready" || capability !== null ? (
          capability !== null ? (
            <div className="mt-3 flex flex-col gap-4">
              <ProviderSection machine={machine} capability={capability} />
              <BindingsSection
                capability={capability}
                selected={selected}
                onToggle={toggleBinding}
              />
              <ResolveSection
                machine={machine}
                capability={capability}
                selectedNames={selectedBindings.map((b) => b.name)}
              />
              <MutationsSection
                machine={machine}
                capability={capability}
                selected={selectedBindings}
              />
              <WarningsSection capability={capability} />
              <p className="text-2xs text-muted-foreground/70">
                contract {capability.contract} · plugin{" "}
                {capability.plugin ?? "rebuildup.secrets"} v
                {capability.version || "?"}
                {capability.generatedAt !== null
                  ? ` · reported ${formatTime(capability.generatedAt)}`
                  : ""}
              </p>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              capability document unavailable on this host
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
