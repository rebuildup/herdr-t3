/*
 * Handoffs surface (issue #404, ADR-0011 boundary): the host's
 * `rebuildup.handoff` plugin (`herdr-plugins.handoff/v1` pinned at
 * rebuildup/hoxay-plugins@d23205af, v0.9.0 — v1 stable since plugin
 * v0.6.0) owns handoff/delegation records: payload references bound to
 * a source pane/agent generation, a status lifecycle, execution
 * targets, and derived lineage.
 *
 * MUTATIONS (issue #451): `execute`/`delegate`/`merge-back` are offered
 * per host capability through `handoffsSupportsMutation` — the local
 * allowlist intersected with the advertised `commands` list, plus
 * `mutation_commands` membership when the plugin advertises that field
 * (plugin ≥ v0.7.0; the pinned v0.9.0 build predates it and falls back
 * to the allowlist + `commands` check). Every mutation confirms through
 * a dialog that names the target identity (host/session/agent/worktree,
 * plus the remote saved machine for `execute --remote`) before invoking
 * `plugin_call`; results are displayed verbatim and failures surface
 * the plugin's own error. Handoff results are never auto-applied
 * anywhere — generation/application stay separated. `create` is never
 * offered (records are authored by agents via CLI/MCP) and `status`
 * reads always pass `--no-reconcile`.
 *
 * Records are created by agents via CLI/MCP, so an empty registry is
 * the honest common case. `transfer_check.state` is rendered verbatim
 * (`ok`/`stale`/`unchecked` + the plugin's reason) — a foreign-session
 * or snapshot-less record is `unchecked`, never guessed stale.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GitForkIcon, MergeIcon, PlayIcon, RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { cn } from "~/lib/utils";
import {
  HANDOFF_STRATEGIES,
  classifyHandoffError,
  delegateHandoff,
  executeHandoff,
  fetchHandoffList,
  fetchHandoffResumeInfo,
  fetchHandoffStatus,
  handoffCapability,
  handoffErrorHint,
  handoffsSupportsMutation,
  mergeBackHandoff,
  refreshHandoffs,
  useHandoffState,
  type HandoffCapability,
  type HandoffCheck,
  type HandoffExecuteFlags,
  type HandoffListItem,
  type HandoffListReport,
  type HandoffMutationResult,
  type HandoffPayloadRef,
  type HandoffRecord,
  type HandoffRefResolution,
  type HandoffResumeInfoReport,
  type HandoffStatusReport,
  type HandoffTargetChoice,
  type HandoffTargetCheck,
  type HandoffUnavailableReason,
} from "../shell/handoffs";

const UNAVAILABLE_LABELS: Record<HandoffUnavailableReason, string> = {
  not_installed: "handoff plugin not installed",
  disabled: "handoff plugin disabled",
  incompatible: "handoff contract incompatible",
  unreachable: "handoff host unreachable",
  error: "handoffs unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifyHandoffError(error);
  const hint = handoffErrorHint(error);
  const base = `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
  return hint !== null ? `${base} (${hint})` : base;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const HANDOFF_STATUSES = [
  "pending",
  "ready",
  "delivered",
  "done",
  "failed",
  "superseded",
] as const;

const LINEAGE_KINDS = [
  "fork",
  "provider_handoff",
  "merge_back",
  "subagent_spawn",
  "subagent_result",
] as const;

function statusVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "pending":
      return "outline";
    case "ready":
      return "info";
    case "delivered":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "error";
    default:
      return "secondary";
  }
}

function checkVariant(
  state: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (state) {
    case "ok":
    case "resolved":
      return "success";
    case "stale":
      return "warning";
    case "unchecked":
      return "outline";
    case "missing_ref":
      return "warning";
    case "error":
      return "error";
    case "external":
      return "secondary";
    default:
      return "secondary";
  }
}

function resumeVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "supported":
      return "success";
    case "unsupported":
      return "outline";
    case "unknown":
      return "warning";
    default:
      return "secondary";
  }
}

/** Staleness badge: `ok` stays quiet; stale/unchecked carry the reason. */
function TransferCheckBadge({ check }: { check: HandoffCheck }) {
  if (check.state === "ok") return null;
  return (
    <Badge
      size="sm"
      variant={checkVariant(check.state)}
      title={check.reason ?? undefined}
    >
      {check.state}
      {check.reason !== null ? `: ${check.reason}` : ""}
    </Badge>
  );
}

function isLineageKind(kind: string): boolean {
  return (LINEAGE_KINDS as readonly string[]).includes(kind);
}

function refSummary(ref: HandoffPayloadRef): string {
  switch (ref.kind) {
    case "conversation_session":
      return ref.session_key ?? "conversation session";
    case "checkpoint":
      return `checkpoint ${ref.id ?? "?"}`;
    case "handoff_record":
      return `handoff ${ref.id ?? "?"}`;
    case "external":
      return `${ref.target ?? "external"}: ${ref.value ?? "?"}`;
    default:
      return ref.plugin !== null ? `${ref.kind} (${ref.plugin})` : ref.kind;
  }
}

/** Execution target shown on a list row: executed pane > hinted pane > workspace. */
function itemTargetLabel(item: HandoffListItem): string | null {
  if (item.target_pane_id !== null) return item.target_pane_id;
  if (item.target?.pane_id != null) return item.target.pane_id;
  if (item.target?.workspace_id != null) return item.target.workspace_id;
  if (item.target?.provider_hint != null) return `hint:${item.target.provider_hint}`;
  return null;
}

function HandoffRow({
  item,
  selected,
  onSelect,
}: {
  item: HandoffListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const target = itemTargetLabel(item);
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- composite selection row (badges + metadata), same pattern as GitSurface file rows
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5 text-left",
        "hover:bg-accent/40",
        selected ? "border-primary/50 bg-accent/30" : "border-border/60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">
          {item.id}
        </span>
        <Badge size="sm" variant={statusVariant(item.status)}>
          {item.status}
        </Badge>
        {item.strategy !== null ? (
          <Badge size="sm" variant="secondary">
            {item.strategy}
          </Badge>
        ) : null}
        {item.relationship !== null ? (
          <Badge
            size="sm"
            variant="outline"
            title={`parent: ${item.relationship.parent_id}`}
          >
            {isLineageKind(item.relationship.kind)
              ? item.relationship.kind
              : `lineage:${item.relationship.kind}`}
          </Badge>
        ) : null}
        {item.child_count > 0 ? (
          <Badge size="sm" variant="info">
            {item.child_count} child{item.child_count === 1 ? "" : "ren"}
          </Badge>
        ) : null}
        <TransferCheckBadge check={item.transfer_check} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span>created {formatTime(item.created_at)}</span>
        {item.transfer?.pane_id != null ? (
          <span className="font-mono">src {item.transfer.pane_id}</span>
        ) : null}
        {target !== null ? <span className="font-mono">→ {target}</span> : null}
        <span>
          {item.ref_count} ref{item.ref_count === 1 ? "" : "s"}
          {item.has_excerpt ? " + excerpt" : ""}
        </span>
        {item.updated_at !== null && item.updated_at !== item.created_at ? (
          <span>updated {formatTime(item.updated_at)}</span>
        ) : null}
      </div>
    </button>
  );
}

/* ------------------------------ status detail -------------------------- */

function CheckLine({ label, check }: { label: string; check: HandoffCheck | null }) {
  if (check === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-2xs">
      <span className="w-20 shrink-0 text-muted-foreground/70">{label}</span>
      <Badge size="sm" variant={checkVariant(check.state)}>
        {check.state}
      </Badge>
      {check.reason !== null ? (
        <span className="min-w-0 truncate text-muted-foreground">{check.reason}</span>
      ) : null}
    </div>
  );
}

function TargetCheckDetail({ check }: { check: HandoffTargetCheck }) {
  return (
    <div className="flex flex-col gap-0.5">
      <CheckLine label="target" check={check} />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-20 text-2xs text-muted-foreground">
        {check.pane_present !== null ? (
          <span>pane {check.pane_present ? "present" : "missing"}</span>
        ) : null}
        {check.agent_status !== null ? <span>agent: {check.agent_status}</span> : null}
        {check.state_change_seq !== null ? (
          <span>seq {check.state_change_seq}</span>
        ) : null}
        {check.agent_session?.value != null ? (
          <span className="font-mono">session {check.agent_session.value}</span>
        ) : null}
      </div>
    </div>
  );
}

function RefResolutionRow({ resolution }: { resolution: HandoffRefResolution }) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-sm px-1.5 py-1 text-2xs hover:bg-accent/40">
      <Badge size="sm" variant={checkVariant(resolution.state)} className="mt-0.5 shrink-0">
        {resolution.state}
      </Badge>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate font-mono">{refSummary(resolution.ref)}</span>
        {resolution.detail !== null ? (
          <span className="min-w-0 truncate text-muted-foreground">{resolution.detail}</span>
        ) : null}
      </div>
    </div>
  );
}

function PayloadSection({ record, report }: { record: HandoffRecord; report: HandoffStatusReport }) {
  const resolutions = report.payload_resolution;
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Payload
      </h4>
      {record.payload.refs.length === 0 && record.payload.excerpt === null ? (
        <p className="text-2xs text-muted-foreground">no payload refs or excerpt</p>
      ) : null}
      {record.payload.refs.length > 0 ? (
        <div className="flex flex-col">
          {resolutions !== null
            ? resolutions.map((resolution, index) => (
                <RefResolutionRow
                  key={`${resolution.ref.kind}-${index}`}
                  resolution={resolution}
                />
              ))
            : record.payload.refs.map((ref, index) => (
                <div
                  key={`${ref.kind}-${index}`}
                  className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-2xs"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{refSummary(ref)}</span>
                </div>
              ))}
        </div>
      ) : null}
      {resolutions === null ? (
        <p className="text-2xs text-muted-foreground/70">
          ref resolution not requested for this read
        </p>
      ) : null}
      {report.missing_refs !== null && report.missing_refs > 0 ? (
        <p className="text-2xs text-warning">
          {report.missing_refs} missing ref{report.missing_refs === 1 ? "" : "s"} — owner
          plugin confirmed absence (never an error)
        </p>
      ) : null}
      {record.payload.excerpt !== null ? (
        <div className="flex flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
          <p className="text-2xs whitespace-pre-wrap">{record.payload.excerpt.text}</p>
          <p className="text-2xs text-muted-foreground/70">
            excerpt{record.payload.excerpt.truncated ? " (truncated)" : ""}
            {record.payload.excerpt.source !== null
              ? ` · source: ${record.payload.excerpt.source}`
              : ""}
          </p>
        </div>
      ) : null}
      {record.payload.requirements.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-2xs text-muted-foreground/70">requirements</p>
          {record.payload.requirements.map((req, index) => (
            <p key={index} className="text-2xs">
              • {req}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ExecutionSection({ record }: { record: HandoffRecord }) {
  const exec = record.execution;
  if (exec === null) {
    return (
      <section className="flex flex-col gap-1">
        <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Execution
        </h4>
        <p className="text-2xs text-muted-foreground">never executed</p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Execution
      </h4>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span>
          strategy{" "}
          <span className="font-medium text-foreground">
            {exec.strategy_used ?? "—"}
          </span>
          {record.strategy !== null && record.strategy !== exec.strategy_used ? (
            <span className="text-muted-foreground/70"> (record: {record.strategy})</span>
          ) : null}
        </span>
        {exec.provider_kind !== null ? <span>provider {exec.provider_kind}</span> : null}
        {exec.decided_at !== null ? <span>decided {formatTime(exec.decided_at)}</span> : null}
      </div>
      {exec.decision !== null ? (
        <p className="text-2xs text-muted-foreground">{exec.decision}</p>
      ) : null}
      {exec.target !== null ? (
        <p className="font-mono text-2xs text-muted-foreground">
          target {exec.target.pane_id ?? "?"}
          {exec.target.workspace_id !== null ? ` ws ${exec.target.workspace_id}` : ""}
          {exec.target.created ? " (created)" : " (reused)"}
        </p>
      ) : null}
      {exec.agent !== null ? (
        <p className="text-2xs text-muted-foreground">
          agent {exec.agent.name ?? "?"} ({exec.agent.kind ?? "?"})
          {exec.agent.agent_status !== null ? ` · ${exec.agent.agent_status}` : ""}
          {exec.agent.pane_id !== null ? (
            <span className="font-mono"> · {exec.agent.pane_id}</span>
          ) : null}
        </p>
      ) : null}
      {exec.prompt !== null ? (
        <p className="text-2xs text-muted-foreground">
          prompt {exec.prompt.chars !== null ? `${exec.prompt.chars} chars` : "delivered"}
          {exec.prompt.delivered_at !== null
            ? ` at ${formatTime(exec.prompt.delivered_at)}`
            : ""}
          {exec.prompt.waited ? " · waited" : ""}
        </p>
      ) : null}
      {exec.error !== null ? (
        <p className="text-2xs text-destructive">
          failed at {exec.error.step ?? "?"}: {exec.error.message ?? "unknown error"}
          {exec.error.at !== null ? ` (${formatTime(exec.error.at)})` : ""}
        </p>
      ) : null}
      {exec.observed !== null ? (
        <p className="text-2xs text-muted-foreground">
          observed agent_status {exec.observed.agent_status ?? "—"}
          {exec.observed.pane_present !== null
            ? ` · pane ${exec.observed.pane_present ? "present" : "missing"}`
            : ""}
          {exec.observed.checked_at !== null
            ? ` · ${formatTime(exec.observed.checked_at)}`
            : ""}
        </p>
      ) : null}
      {exec.remote !== null ? (
        <p className="text-2xs text-muted-foreground">
          remote {exec.remote.label ?? exec.remote.machine_id ?? "?"}
          {exec.remote.target !== null ? ` (${exec.remote.target})` : ""}
          {exec.remote.session !== null ? ` · session ${exec.remote.session}` : ""}
          {!exec.remote.enabled ? " · disabled" : ""}
        </p>
      ) : null}
      {exec.worktree !== null ? (
        <p className="font-mono text-2xs text-muted-foreground">
          worktree {exec.worktree.path ?? "?"}
          {exec.worktree.branch !== null ? ` @ ${exec.worktree.branch}` : ""}
        </p>
      ) : null}
      {exec.cleaned_up ? (
        <p className="text-2xs text-muted-foreground">failure cleanup closed the created pane</p>
      ) : null}
    </section>
  );
}

/* --------------------------- record mutations -------------------------- */

type HandoffMutationAction = "execute" | "delegate" | "merge-back";

const MUTATION_TITLES: Record<HandoffMutationAction, string> = {
  execute: "Execute handoff?",
  delegate: "Delegate from handoff?",
  "merge-back": "Merge result back?",
};

const MUTATION_CONFIRM: Record<HandoffMutationAction, string> = {
  execute: "Execute",
  delegate: "Delegate",
  "merge-back": "Merge back",
};

const MUTATION_DESCRIPTIONS: Record<HandoffMutationAction, string> = {
  execute:
    "Runs the handoff end-to-end: staleness gate → strategy decision → target surface (optionally a remote saved machine) → agent.start → payload prompt → delivered. The record must be pending/ready with an ok transfer check; the plugin refuses stale sources before any mutation.",
  delegate:
    "Creates a child handoff record (subagent_spawn) bound to this record's pane, then runs the normal execute pipeline as a new agent — unless 'record only' is set. Same-session only in v1; --remote is never sent.",
  "merge-back":
    "Creates a result record (subagent_result/merge_back) reporting on this child and delivers it via agent.prompt to the delegating agent's EXISTING pane — agent.start is never called on a pane that already runs an agent — unless 'record only' is set.",
};

/** Compact target-identity line for the confirmation dialog. */
function mutationIdentityLines(record: HandoffRecord): string[] {
  const transfer = record.transfer;
  const lines: string[] = [`record ${record.id} (${record.status})`];
  if (transfer !== null) {
    const parts: string[] = [];
    if (transfer.pane_id !== null) parts.push(`pane ${transfer.pane_id}`);
    if (transfer.workspace_id !== null) parts.push(`ws ${transfer.workspace_id}`);
    if (transfer.host !== null) parts.push(`host ${transfer.host}`);
    if (transfer.herdr_session !== null) parts.push(`session ${transfer.herdr_session}`);
    if (parts.length > 0) lines.push(`source: ${parts.join(" · ")}`);
    if (transfer.provider_kind !== null) lines.push(`provider ${transfer.provider_kind}`);
    if (transfer.cwd !== null) lines.push(`cwd ${transfer.cwd}`);
    if (transfer.agent_session?.value != null) {
      lines.push(`agent_session ${transfer.agent_session.value}`);
    }
  }
  if (record.relationship !== null) {
    lines.push(`lineage ${record.relationship.kind} → parent ${record.relationship.parent_id}`);
  }
  return lines;
}

/**
 * Confirmation + options dialog for one mutation. The identity block
 * always names host/session/agent/worktree context before anything is
 * sent; the remote saved-machine field appears only when the contract
 * advertises remote execution, and is echoed verbatim in the summary.
 * On success the plugin's own outcome/record is rendered — never
 * auto-applied anywhere.
 */
function HandoffMutationDialog({
  machine,
  action,
  record,
  transferCheck,
  cap,
  onClose,
  onMutated,
}: {
  machine: string;
  action: HandoffMutationAction;
  record: HandoffRecord;
  transferCheck: HandoffCheck;
  cap: HandoffCapability | null;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [task, setTask] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [strategy, setStrategy] = useState<string>("inherit");
  const [targetMode, setTargetMode] = useState<string>("auto");
  const [paneId, setPaneId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [worktreeBase, setWorktreeBase] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [waitMs, setWaitMs] = useState("");
  const [remote, setRemote] = useState("");
  const [cleanup, setCleanup] = useState(false);
  const [noExecute, setNoExecute] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HandoffMutationResult | null>(null);

  const isExecute = action === "execute";
  const isDelegate = action === "delegate";
  const showsExecuteFlags = isExecute || isDelegate;
  const remoteSupported =
    isExecute && cap !== null && (cap.execution ?? "").includes("remote");

  const waitRaw = waitMs.trim();
  const waitNum = waitRaw === "" ? undefined : Number(waitRaw);
  const waitValid =
    waitNum === undefined || (Number.isInteger(waitNum) && waitNum >= 0);
  const targetValid =
    (targetMode !== "pane" || paneId.trim() !== "") &&
    (targetMode !== "workspace" || workspaceId.trim() !== "");
  const formValid = waitValid && targetValid;

  const targetChoice = (): HandoffTargetChoice => {
    switch (targetMode) {
      case "pane":
        return { kind: "pane", paneId: paneId.trim() };
      case "workspace":
        return { kind: "workspace", workspaceId: workspaceId.trim() };
      case "new-workspace":
        return { kind: "new-workspace" };
      case "worktree":
        return {
          kind: "worktree",
          branch: worktreeBranch.trim() === "" ? undefined : worktreeBranch.trim(),
          base: worktreeBase.trim() === "" ? undefined : worktreeBase.trim(),
        };
      default:
        return { kind: "auto" };
    }
  };

  const execFlags = (): HandoffExecuteFlags => ({
    target: targetChoice(),
    provider: provider.trim() === "" ? undefined : provider.trim(),
    model: model.trim() === "" ? undefined : model.trim(),
    waitMs: waitNum,
    cleanupOnFailure: cleanup,
  });

  const submit = async () => {
    if (busy || !formValid) return;
    setBusy(true);
    setError(null);
    try {
      let next: HandoffMutationResult;
      if (isExecute) {
        next = await executeHandoff(machine, record.id, {
          ...execFlags(),
          remote: remote.trim() === "" ? undefined : remote.trim(),
        });
      } else if (isDelegate) {
        next = await delegateHandoff(machine, record.id, {
          ...execFlags(),
          task: task.trim() === "" ? undefined : task.trim(),
          strategy:
            strategy === "inherit" ||
            !(HANDOFF_STRATEGIES as readonly string[]).includes(strategy)
              ? undefined
              : strategy,
          linkNote: linkNote.trim() === "" ? undefined : linkNote.trim(),
          noExecute,
        });
      } else {
        next = await mergeBackHandoff(machine, record.id, {
          task: task.trim() === "" ? undefined : task.trim(),
          waitMs: waitNum,
          linkNote: linkNote.trim() === "" ? undefined : linkNote.trim(),
          noExecute,
        });
      }
      setResult(next);
      // The record changed plugin-side; refresh the list AND this detail.
      onMutated();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  const exec = result?.record.execution ?? null;
  const remoteTarget = remote.trim();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{MUTATION_TITLES[action]}</DialogTitle>
          <DialogDescription>{MUTATION_DESCRIPTIONS[action]}</DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
              {mutationIdentityLines(record).map((line) => (
                <p key={line} className="text-2xs text-muted-foreground">
                  {line}
                </p>
              ))}
              {isExecute && remoteSupported && remoteTarget !== "" ? (
                <p className="text-2xs text-warning">
                  remote target: saved machine &quot;{remoteTarget}&quot; on this
                  host — probed before any mutation; the remote snapshot drives
                  target planning
                </p>
              ) : null}
              {showsExecuteFlags && targetMode !== "auto" ? (
                <p className="text-2xs text-muted-foreground">
                  target:{" "}
                  {targetMode === "pane"
                    ? `pane ${paneId.trim()}`
                    : targetMode === "workspace"
                      ? `workspace ${workspaceId.trim()}`
                      : targetMode === "new-workspace"
                        ? "new workspace"
                        : `worktree${worktreeBranch.trim() !== "" ? ` branch ${worktreeBranch.trim()}` : ""}`}
                </p>
              ) : null}
            </div>

            {showsExecuteFlags ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                  Target surface
                  <Select value={targetMode} onValueChange={(v) => setTargetMode(v)}>
                    <SelectTrigger aria-label="Target surface" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">plugin default</SelectItem>
                      <SelectItem value="new-workspace">new workspace</SelectItem>
                      <SelectItem value="worktree">new worktree</SelectItem>
                      <SelectItem value="pane">existing pane…</SelectItem>
                      <SelectItem value="workspace">workspace tab…</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                {targetMode === "pane" ? (
                  <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                    Pane id
                    <Input
                      size="sm"
                      font="mono"
                      value={paneId}
                      onChange={(e) => setPaneId(e.target.value)}
                      placeholder="w1:p2"
                    />
                  </label>
                ) : null}
                {targetMode === "workspace" ? (
                  <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                    Workspace id
                    <Input
                      size="sm"
                      font="mono"
                      value={workspaceId}
                      onChange={(e) => setWorkspaceId(e.target.value)}
                      placeholder="w2"
                    />
                  </label>
                ) : null}
                {targetMode === "worktree" ? (
                  <>
                    <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                      Worktree branch (optional)
                      <Input
                        size="sm"
                        font="mono"
                        value={worktreeBranch}
                        onChange={(e) => setWorktreeBranch(e.target.value)}
                        placeholder="handoff/x"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                      Worktree base (optional)
                      <Input
                        size="sm"
                        font="mono"
                        value={worktreeBase}
                        onChange={(e) => setWorktreeBase(e.target.value)}
                        placeholder="HEAD"
                      />
                    </label>
                  </>
                ) : null}
                <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                  Provider hint (optional)
                  <Input
                    size="sm"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder={record.target?.provider_hint ?? "e.g. claude"}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                  Model (optional)
                  <Input
                    size="sm"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="provider model flag value"
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                  Wait for agent ms (optional)
                  <Input
                    size="sm"
                    font="mono"
                    value={waitMs}
                    onChange={(e) => setWaitMs(e.target.value)}
                    placeholder="e.g. 30000"
                  />
                </label>
              </div>
            ) : null}

            {isExecute && remoteSupported ? (
              <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                Remote machine (optional — saved herdr machine label or id on
                this host)
                <Input
                  size="sm"
                  font="mono"
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                  placeholder="e.g. lab-box"
                />
              </label>
            ) : null}

            {isDelegate ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                  Strategy
                  <Select value={strategy} onValueChange={(v) => setStrategy(v)}>
                    <SelectTrigger aria-label="Delegate strategy" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">record default</SelectItem>
                      <SelectItem value="native_resume">native_resume</SelectItem>
                      <SelectItem value="portable_context">portable_context</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            ) : null}

            {isDelegate || action === "merge-back" ? (
              <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                {isDelegate ? "Task / note for the child (optional)" : "Result summary for the parent (optional)"}
                <Input
                  size="sm"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder={
                    isDelegate
                      ? "bounded task description — becomes the payload excerpt"
                      : "what the child accomplished — delivered to the delegating agent"
                  }
                />
              </label>
            ) : null}

            {isDelegate || action === "merge-back" ? (
              <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                Link note (optional)
                <Input
                  size="sm"
                  value={linkNote}
                  onChange={(e) => setLinkNote(e.target.value)}
                  placeholder="annotates the lineage link"
                />
              </label>
            ) : null}

            {action === "merge-back" ? (
              <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                Wait for agent ms (optional)
                <Input
                  size="sm"
                  font="mono"
                  value={waitMs}
                  onChange={(e) => setWaitMs(e.target.value)}
                  placeholder="e.g. 30000"
                />
              </label>
            ) : null}

            <div className="flex flex-col gap-2">
              {showsExecuteFlags ? (
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <Switch
                    size="sm"
                    checked={cleanup}
                    onCheckedChange={(checked) => setCleanup(checked === true)}
                    aria-label="Clean up created surface on failure"
                  />
                  <span>
                    Clean up the created surface on failure — only panes the
                    plugin created are closed; reused panes are never closed
                  </span>
                </div>
              ) : null}
              {!isExecute ? (
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <Switch
                    size="sm"
                    checked={noExecute}
                    onCheckedChange={(checked) => setNoExecute(checked === true)}
                    aria-label="Record intent only"
                  />
                  <span>
                    Record intent only — skip the execute/delivery pipeline
                  </span>
                </div>
              ) : null}
            </div>

            {showsExecuteFlags && transferCheck.state !== "ok" ? (
              <p className="text-2xs text-warning">
                source check: {transferCheck.state}
                {transferCheck.reason !== null ? ` (${transferCheck.reason})` : ""} —
                the plugin will refuse until the source pane/agent generation
                matches
              </p>
            ) : null}
            {!waitValid ? (
              <p className="text-2xs text-destructive">
                wait ms must be a non-negative integer
              </p>
            ) : null}
            {error !== null ? (
              <p className="text-2xs text-destructive">mutation failed: {error}</p>
            ) : null}

            {result !== null ? (
              <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-2xs">
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant={statusVariant(result.record.status)}>
                    {result.record.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    {result.command} → {result.outcome ?? "completed"}
                    {result.dryRun ? " (dry run)" : ""}
                  </span>
                </div>
                <div className="font-mono text-muted-foreground">
                  record {result.record.id}
                  {result.parentId !== null ? ` · parent ${result.parentId}` : ""}
                  {result.childId !== null ? ` · child ${result.childId}` : ""}
                </div>
                {exec !== null ? (
                  <div className="flex flex-col gap-0.5 text-muted-foreground">
                    {exec.strategy_used !== null ? (
                      <span>strategy {exec.strategy_used}</span>
                    ) : null}
                    {exec.target !== null ? (
                      <span className="font-mono">
                        target {exec.target.pane_id ?? "?"}
                        {exec.target.workspace_id !== null
                          ? ` ws ${exec.target.workspace_id}`
                          : ""}
                        {exec.target.created ? " (created)" : " (reused)"}
                      </span>
                    ) : null}
                    {exec.agent !== null ? (
                      <span>
                        agent {exec.agent.name ?? "?"} ({exec.agent.kind ?? "?"})
                        {exec.agent.agent_status !== null
                          ? ` · ${exec.agent.agent_status}`
                          : ""}
                      </span>
                    ) : null}
                    {exec.prompt !== null ? (
                      <span>
                        prompt {exec.prompt.chars !== null ? `${exec.prompt.chars} chars` : "delivered"}
                      </span>
                    ) : null}
                    {exec.error !== null ? (
                      <span className="text-destructive">
                        failed at {exec.error.step ?? "?"}: {exec.error.message ?? "unknown"}
                      </span>
                    ) : null}
                    {exec.worktree !== null ? (
                      <span className="font-mono">
                        worktree {exec.worktree.path ?? "?"}
                        {exec.worktree.branch !== null ? ` @ ${exec.worktree.branch}` : ""}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {result.remote !== null ? (
                  <div className="text-muted-foreground">
                    remote {result.remote.label ?? result.remote.machine_id ?? "?"}
                    {result.remote.target !== null ? ` (${result.remote.target})` : ""}
                    {result.remote.session !== null
                      ? ` · session ${result.remote.session}`
                      : ""}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={close} disabled={busy}>
            {result !== null ? "Done" : "Cancel"}
          </Button>
          {result === null ? (
            <Button
              size="sm"
              disabled={busy || !formValid}
              onClick={() => void submit()}
            >
              {busy ? "Working…" : MUTATION_CONFIRM[action]}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mutation action row for one record. Buttons render only when the
 * host capability allows the command AND the record shape fits
 * (execute needs pending/ready — the plugin's own gate; merge-back
 * needs a lineage link). `cap === undefined` (probing) or `null`
 * (unavailable) hides everything.
 */
function HandoffActions({
  machine,
  record,
  transferCheck,
  cap,
  onMutated,
}: {
  machine: string;
  record: HandoffRecord;
  transferCheck: HandoffCheck;
  cap: HandoffCapability | null | undefined;
  onMutated: () => void;
}) {
  const [action, setAction] = useState<HandoffMutationAction | null>(null);
  const canExecute =
    handoffsSupportsMutation(cap, "execute") === true &&
    (record.status === "pending" || record.status === "ready");
  const canDelegate = handoffsSupportsMutation(cap, "delegate") === true;
  const canMergeBack =
    handoffsSupportsMutation(cap, "merge-back") === true &&
    record.relationship !== null;

  if (!canExecute && !canDelegate && !canMergeBack) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {/* secondary, not ghost-muted: these are the record's primary
            mutations and read as disabled next to the quiet row
            (issue #480). */}
        {canExecute ? (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setAction("execute")}
          >
            <PlayIcon />
            Execute
          </Button>
        ) : null}
        {canDelegate ? (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setAction("delegate")}
          >
            <GitForkIcon />
            Delegate
          </Button>
        ) : null}
        {canMergeBack ? (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setAction("merge-back")}
          >
            <MergeIcon />
            Merge back
          </Button>
        ) : null}
      </div>
      {action !== null && cap !== null && cap !== undefined ? (
        <HandoffMutationDialog
          machine={machine}
          action={action}
          record={record}
          transferCheck={transferCheck}
          cap={cap}
          onClose={() => setAction(null)}
          onMutated={onMutated}
        />
      ) : null}
    </div>
  );
}

function HandoffDetail({
  machine,
  handoffId,
  cap,
  refreshNonce,
  onMutated,
  onSelectChild,
}: {
  machine: string;
  handoffId: string;
  cap: HandoffCapability | null | undefined;
  /** Bumped after a mutation so status refetches the post-mutation record. */
  refreshNonce: number;
  onMutated: () => void;
  onSelectChild: (id: string) => void;
}) {
  const [report, setReport] = useState<HandoffStatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The fetched record is keyed on machine+handoffId; a nonce-only
  // refetch (post-mutation) keeps the previous report rendered so the
  // mutation dialog — a child of this component — is not unmounted.
  const detailKeyRef = useRef(`${machine}\n${handoffId}`);

  useEffect(() => {
    const detailKey = `${machine}\n${handoffId}`;
    if (detailKeyRef.current !== detailKey) {
      detailKeyRef.current = detailKey;
      setReport(null);
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHandoffStatus(machine, handoffId)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshNonce is the explicit invalidation signal after a mutation; the fetch is keyed on machine + handoffId
  }, [machine, handoffId, refreshNonce]);

  if (loading && report === null) {
    return (
      <p className="text-2xs text-muted-foreground">
        loading status for {handoffId}… (resolves payload refs via owner plugins)
      </p>
    );
  }
  if (error !== null) {
    return <p className="text-2xs text-destructive">status failed: {error}</p>;
  }
  if (report === null) return null;

  const record = report.handoff;
  const transfer = record.transfer;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">{record.id}</span>
        <Badge size="sm" variant={statusVariant(record.status)}>
          {record.status}
        </Badge>
        {record.strategy !== null ? (
          <Badge size="sm" variant="secondary">
            {record.strategy}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span>created {formatTime(record.created_at)}</span>
        <span>updated {formatTime(record.updated_at)}</span>
      </div>

      <HandoffActions
        machine={machine}
        record={record}
        transferCheck={report.transfer_check}
        cap={cap}
        onMutated={onMutated}
      />

      {transfer !== null ? (
        <section className="flex flex-col gap-0.5">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Source
          </h4>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            {transfer.pane_id !== null ? (
              <span className="font-mono">pane {transfer.pane_id}</span>
            ) : null}
            {transfer.workspace_id !== null ? (
              <span className="font-mono">ws {transfer.workspace_id}</span>
            ) : null}
            {transfer.host !== null ? <span>host {transfer.host}</span> : null}
            {transfer.herdr_session !== null ? (
              <span>session {transfer.herdr_session}</span>
            ) : null}
            {transfer.provider_kind !== null ? (
              <span>provider {transfer.provider_kind}</span>
            ) : null}
            {transfer.cwd !== null ? <span className="font-mono">{transfer.cwd}</span> : null}
          </div>
          {transfer.agent_session?.value != null ? (
            <p className="font-mono text-2xs text-muted-foreground">
              agent_session {transfer.agent_session.value}
              {transfer.state_change_seq !== null
                ? ` · seq ${transfer.state_change_seq}`
                : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      {record.target !== null ? (
        <section className="flex flex-col gap-0.5">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Target intent
          </h4>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            {record.target.pane_id !== null ? (
              <span className="font-mono">pane {record.target.pane_id}</span>
            ) : null}
            {record.target.workspace_id !== null ? (
              <span className="font-mono">ws {record.target.workspace_id}</span>
            ) : null}
            {record.target.provider_hint !== null ? (
              <span>hint {record.target.provider_hint}</span>
            ) : null}
            {record.target.note !== null ? <span>{record.target.note}</span> : null}
          </div>
        </section>
      ) : null}

      {record.relationship !== null ? (
        <section className="flex flex-col gap-0.5">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Lineage
          </h4>
          <p className="text-2xs text-muted-foreground">
            {record.relationship.kind} · parent{" "}
            {/* oxlint-disable-next-line herdr-t3/no-raw-control -- inline id link styled as text, same exception as PaneContextCard panel rows */}
            <button
              type="button"
              className="font-mono text-primary hover:underline"
              onClick={() => onSelectChild(record.relationship?.parent_id ?? "")}
            >
              {record.relationship.parent_id}
            </button>
            {record.relationship.note !== null ? ` — ${record.relationship.note}` : ""}
          </p>
          {report.lineage !== null && report.lineage.children.length > 0 ? (
            <div className="flex flex-col gap-0.5 pl-2">
              {report.lineage.children.map((child) => (
                // oxlint-disable-next-line herdr-t3/no-raw-control -- composite navigation row (id + badges), same pattern as HandoffRow
                <button
                  key={child.id}
                  type="button"
                  className="flex min-w-0 items-center gap-2 text-left text-2xs hover:bg-accent/40"
                  onClick={() => onSelectChild(child.id)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{child.id}</span>
                  {child.kind !== null ? (
                    <span className="text-muted-foreground/70">{child.kind}</span>
                  ) : null}
                  {child.status !== null ? (
                    <Badge size="sm" variant={statusVariant(child.status)}>
                      {child.status}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {report.lineage?.parent_missing === true ? (
            <p className="text-2xs text-warning">linked parent record is missing</p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-0.5">
        <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Checks
        </h4>
        <CheckLine label="transfer" check={report.transfer_check} />
        {report.target_check !== null ? (
          <TargetCheckDetail check={report.target_check} />
        ) : null}
        {report.remote_check !== null ? (
          <div className="flex min-w-0 items-center gap-2 text-2xs">
            <span className="w-20 shrink-0 text-muted-foreground/70">remote</span>
            <Badge size="sm" variant={checkVariant(report.remote_check.state)}>
              {report.remote_check.state}
            </Badge>
            <span className="min-w-0 truncate text-muted-foreground">
              {[
                report.remote_check.label ?? report.remote_check.machine_id,
                report.remote_check.target,
                report.remote_check.session !== null
                  ? `session ${report.remote_check.session}`
                  : null,
                report.remote_check.reason,
                report.remote_check.note,
              ]
                .filter((part): part is string => part !== null && part !== "")
                .join(" · ")}
            </span>
          </div>
        ) : null}
      </section>

      <PayloadSection record={record} report={report} />
      <ExecutionSection record={record} />

      <p className="text-2xs text-muted-foreground/70">
        status fetched {formatTime(report.generated_at)}
        {report.state_file !== null ? ` · ${report.state_file}` : ""} · read with
        --no-reconcile (no state writes)
      </p>
    </div>
  );
}

/* ------------------------------ resume-info ---------------------------- */

function ResumeInfoSection({ machine }: { machine: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<HandoffResumeInfoReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchHandoffResumeInfo(machine)
      .then(setReport)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [machine]);

  useEffect(() => {
    setOpen(false);
    setReport(null);
    setError(null);
  }, [machine]);

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Provider resume capability
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              setOpen(true);
              if (report === null && !loading) load();
            }
          }}
          disabled={loading}
          aria-label={open ? "Hide resume info" : "Show resume info"}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
          {open ? "Hide" : "Load"}
        </Button>
      </div>
      {open ? (
        loading && report === null ? (
          <p className="text-2xs text-muted-foreground">loading resume info…</p>
        ) : error !== null ? (
          <p className="text-2xs text-destructive">resume-info failed: {error}</p>
        ) : report !== null ? (
          <>
            {report.providers.length === 0 ? (
              <p className="text-2xs text-muted-foreground">no providers in the resume table</p>
            ) : (
              <div className="flex flex-col gap-1">
                {report.providers.map((provider) => (
                  <div
                    key={provider.kind}
                    className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge size="sm" variant="outline">
                        {provider.kind}
                      </Badge>
                      <Badge size="sm" variant={resumeVariant(provider.native_resume)}>
                        {provider.native_resume}
                      </Badge>
                      {provider.session_id_source !== null ? (
                        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                          id: {provider.session_id_source}
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1" />
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
                      {provider.resume_args_template !== null ? (
                        <span className="font-mono">
                          resume {provider.resume_args_template.join(" ")}
                        </span>
                      ) : null}
                      {provider.model_flag !== null ? (
                        <span>model flag {provider.model_flag}</span>
                      ) : null}
                    </div>
                    {provider.notes !== null ? (
                      <p className="text-2xs text-muted-foreground/70">{provider.notes}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {report.notes.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {report.notes.map((note, index) => (
                  <p key={index} className="text-2xs text-muted-foreground/70">
                    {note}
                  </p>
                ))}
              </div>
            ) : null}
            <p className="text-2xs text-muted-foreground/70">
              native_resume=supported means the provider CLI documents session resume;
              unknown/unsupported fall back to portable_context — resume is never guessed
            </p>
          </>
        ) : null
      ) : null}
    </section>
  );
}

/* -------------------------------- surface ------------------------------ */

export function HandoffsSurface({ machine }: { machine: string }) {
  const state = useHandoffState(machine);
  const [cap, setCap] = useState<HandoffCapability | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [filtered, setFiltered] = useState<{
    report: HandoffListReport | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped after a mutation so the open record detail refetches status.
  const [detailNonce, setDetailNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    handoffCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshHandoffs(machine);
  }, [machine, state.status.kind]);

  // Status filter is a lazy `list --status` refetch — the eager store
  // list stays the unfiltered view.
  useEffect(() => {
    if (statusFilter === "all") {
      setFiltered(null);
      return;
    }
    let cancelled = false;
    setFiltered({ report: null, loading: true, error: null });
    fetchHandoffList(machine, { status: statusFilter, limit: 500 })
      .then((report) => {
        if (!cancelled) setFiltered({ report, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFiltered({ report: null, loading: false, error: errorText(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [machine, statusFilter]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshHandoffs(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const list = filtered?.report ?? state.list;
  const listLoading = filtered?.loading ?? false;
  const listError = filtered?.error ?? state.listError;
  const filtering = statusFilter !== "all";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Handoff and delegation records from the rebuildup.handoff
            plugin — payload references bound to a source pane/agent
            generation with a status lifecycle, execution targets, and
            lineage. execute/delegate/merge-back are offered per host
            capability behind a confirmation dialog; create stays
            agent-side (CLI/MCP).
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh handoffs"
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading handoffs…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.list !== null ? " (showing last known records)" : ""}
          </p>
        ) : null}

        {cap !== null && cap !== undefined ? (
          <p className="text-2xs text-muted-foreground/70">
            contract {cap.contract} v{cap.version}
            {cap.execution !== null ? ` · execution: ${cap.execution}` : ""}
          </p>
        ) : null}

        {state.status.kind === "ready" || state.list !== null ? (
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Records
                </h3>
                <Select
                  value={statusFilter}
                  onValueChange={(value) => setStatusFilter(value)}
                >
                  <SelectTrigger aria-label="Status filter" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all statuses</SelectItem>
                    {HANDOFF_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {listError !== null ? (
                <p className="text-2xs text-destructive">list failed: {listError}</p>
              ) : null}
              {listLoading ? (
                <p className="text-2xs text-muted-foreground">loading records…</p>
              ) : null}

              {list !== null && !listLoading ? (
                <>
                  {list.truncated ? (
                    <p className="text-2xs text-muted-foreground">
                      registry truncated — showing {list.count} of {list.total} records
                    </p>
                  ) : null}
                  {list.items.length === 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      {filtering
                        ? `no ${statusFilter} handoff records`
                        : "no handoff records — agents create them via the rebuildup.handoff CLI or MCP tools"}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {list.items.map((item) => (
                        <HandoffRow
                          key={item.id}
                          item={item}
                          selected={selectedId === item.id}
                          onSelect={() =>
                            setSelectedId((current) =>
                              current === item.id ? null : item.id,
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                  <p className="text-2xs text-muted-foreground/70">
                    {list.total} record{list.total === 1 ? "" : "s"} total
                    {list.generated_at !== null
                      ? ` · listed ${formatTime(list.generated_at)}`
                      : ""}
                  </p>
                </>
              ) : null}
            </section>

            {selectedId !== null && state.status.kind === "ready" ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Record detail
                </h3>
                <HandoffDetail
                  machine={machine}
                  handoffId={selectedId}
                  cap={cap}
                  refreshNonce={detailNonce}
                  onMutated={() => {
                    setDetailNonce((n) => n + 1);
                    void refreshHandoffs(machine);
                  }}
                  onSelectChild={(id) => {
                    if (id !== "") setSelectedId(id);
                  }}
                />
              </section>
            ) : null}

            {state.status.kind === "ready" ? <ResumeInfoSection machine={machine} /> : null}
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
