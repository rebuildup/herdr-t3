/*
 * Controls surface (issue #450, ADR-0011 boundary): the host's
 * `rebuildup.controls` plugin (`herdr-plugins.controls/v1` pinned at
 * rebuildup/herdr-plugins@d23205af, v0.9.0 — v1 stable since plugin
 * v0.6.0) is the agent operation core: provider slash-command
 * passthrough, PTY-level interrupt, status wait, and agent launch with
 * per-provider launch options — all over herdr's `agent.*` socket API.
 *
 * BOUNDARY: only plugin-contract capabilities herdr does not already
 * provide are offered. `send`/`rename`/`read` duplicate the bridge's
 * `agent.prompt`/`agent.rename`/`agent.read` RPCs and are NOT consumed;
 * raw `--arg`/`--unsafe-args` passthrough is not exposed. Every
 * mutation (`command`/`interrupt`/`start`) is gated by
 * `controlsSupportsMutation` (local allowlist ∩ advertised
 * `mutation_commands` ∩ `commands`) and runs through an explicit
 * confirmation dialog; `--expect-*` generation guards are derived
 * from the live snapshot automatically. `wait` is non-mutating per the
 * contract and needs no confirmation.
 *
 * Honest states: plugin missing/disabled/incompatible/unreachable,
 * no agents in the snapshot, unsupported launch options per provider
 * (fields hidden with the contract's own verdict), `fragile` slash
 * commands and `pty_level` interrupt are labelled verbatim — never
 * upgraded.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BotIcon,
  CircleStopIcon,
  HourglassIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { cn } from "~/lib/utils";
import type { AgentInfo, PaneInfo } from "../../shared/protocol";
import { useBridgeState } from "../shell/bridge";
import {
  classifyControlsError,
  controlsAgentLabel,
  controlsCapability,
  controlsExpectFromAgent,
  controlsProvider,
  controlsSlashCommandValid,
  controlsSupports,
  controlsSupportsMutation,
  interruptControlsAgent,
  refreshControls,
  runControlsSlashCommand,
  startControlsAgent,
  useControlsState,
  waitControlsAgent,
  type ControlsCapability,
  type ControlsOperationResult,
  type ControlsProvider,
  type ControlsUnavailableReason,
} from "../shell/controls";

const UNAVAILABLE_LABELS: Record<ControlsUnavailableReason, string> = {
  not_installed: "controls plugin not installed",
  disabled: "controls plugin disabled",
  incompatible: "controls contract incompatible",
  unreachable: "controls host unreachable",
  error: "controls unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifyControlsError(error);
  return `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
}

const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

function statusVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "working":
      return "info";
    case "blocked":
      return "warning";
    case "done":
      return "success";
    case "idle":
      return "secondary";
    default:
      return "outline";
  }
}

/* ------------------------------ result view ---------------------------- */

type LastOutcome =
  | { kind: "ok"; result: ControlsOperationResult }
  | { kind: "error"; text: string };

function ResultView({ outcome }: { outcome: LastOutcome }) {
  if (outcome.kind === "error") {
    return <p className="text-2xs text-destructive">operation failed: {outcome.text}</p>;
  }
  const r = outcome.result;
  const identity = r.identity;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge size="sm" variant="success">
          {r.command}
        </Badge>
        {r.waited ? <Badge size="sm" variant="info">waited</Badge> : null}
        {r.ptyLevel ? <Badge size="sm" variant="warning">pty_level</Badge> : null}
        {r.fragile ? <Badge size="sm" variant="warning">fragile</Badge> : null}
        {r.commandName !== null ? (
          <span className="font-mono text-2xs">{r.commandName}</span>
        ) : null}
        {r.provider?.knownCommand === true ? (
          <Badge size="sm" variant="secondary">known command</Badge>
        ) : r.provider?.knownCommand === false ? (
          <Badge size="sm" variant="outline">unlisted command</Badge>
        ) : null}
        {identity?.agent_status != null ? (
          <Badge size="sm" variant={statusVariant(identity.agent_status)}>
            {identity.agent_status}
          </Badge>
        ) : null}
      </div>
      {r.text !== null ? (
        <p className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          submitted: {r.text}
        </p>
      ) : null}
      {r.keys !== null ? (
        <p className="text-2xs text-muted-foreground">
          keys: {r.keys.join(", ")} (PTY-level injection — effect depends on provider keybindings)
        </p>
      ) : null}
      {r.provider?.note != null ? (
        <p className="text-2xs text-muted-foreground/70">{r.provider.note}</p>
      ) : null}
      {r.launch !== null ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-2xs text-muted-foreground">
            launch {r.launch.kind ?? "?"}
            {r.launch.requested_kind !== null && r.launch.requested_kind !== r.launch.kind
              ? ` (requested ${r.launch.requested_kind})`
              : ""}
            {r.launch.name !== null ? ` · name ${r.launch.name}` : ""}
            {r.launch.pane_id !== null ? (
              <span className="font-mono"> · {r.launch.pane_id}</span>
            ) : null}
          </p>
          {r.launch.argv.length > 0 ? (
            <p className="min-w-0 truncate font-mono text-2xs text-muted-foreground/70">
              argv: {r.launch.argv.join(" ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {identity !== null ? (
        <p className="text-2xs text-muted-foreground/70">
          identity pane {identity.pane_id ?? "?"}
          {identity.agent !== null ? ` · agent ${identity.agent}` : ""}
          {identity.state_change_seq !== null ? ` · seq ${identity.state_change_seq}` : ""}
          {identity.agent_session?.value != null
            ? ` · session ${identity.agent_session.value}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------ agent picker --------------------------- */

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- composite selection row (badges + metadata), same pattern as HandoffsSurface rows
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
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-2xs font-medium">
          {controlsAgentLabel(agent)}
        </span>
        {agent.agent != null && agent.agent !== "" ? (
          <Badge size="sm" variant="outline">
            {agent.agent}
          </Badge>
        ) : null}
        <Badge size="sm" variant={statusVariant(agent.agent_status)}>
          {agent.agent_status}
        </Badge>
        {agent.launch_pending === true ? (
          <Badge size="sm" variant="info">launch pending</Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span className="font-mono">{agent.pane_id}</span>
        {agent.state_change_seq !== undefined ? (
          <span>seq {agent.state_change_seq}</span>
        ) : null}
        {agent.agent_session?.value != null ? (
          <span className="font-mono">session {agent.agent_session.value}</span>
        ) : null}
        {agent.interactive_ready === false ? <span>not interactive-ready</span> : null}
      </div>
    </button>
  );
}

/* ------------------------------ dialogs -------------------------------- */

const WAIT_UNTIL_OPTIONS = [
  { value: "__default__", label: "default (idle|done|blocked)" },
  ...AGENT_STATUSES.map((s) => ({ value: s, label: s })),
] as const;

function waitUntilArg(value: string): string[] {
  return value === "__default__" ? [] : [value];
}

function optionalMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Shared mutation-run plumbing: busy flag, outcome, error text. */
function useMutationRun(onOutcome: (outcome: LastOutcome) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: () => Promise<ControlsOperationResult>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        onOutcome({ kind: "ok", result });
        return true;
      } catch (e: unknown) {
        const text = errorText(e);
        setError(text);
        onOutcome({ kind: "error", text });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onOutcome],
  );
  return { busy, error, run };
}

function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label>{label}</Label>
      {children}
      {hint !== undefined ? (
        <p className="text-2xs text-muted-foreground/70">{hint}</p>
      ) : null}
    </div>
  );
}

/* ---- slash command dialog ---- */

function CommandDialog({
  machine,
  agent,
  provider,
  open,
  onClose,
  onOutcome,
}: {
  machine: string;
  agent: AgentInfo;
  provider: ControlsProvider | null;
  open: boolean;
  onClose: () => void;
  onOutcome: (outcome: LastOutcome) => void;
}) {
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [wait, setWait] = useState(false);
  const [until, setUntil] = useState("__default__");
  const [timeout, setTimeoutMs] = useState("");
  const { busy, error, run } = useMutationRun(onOutcome);

  useEffect(() => {
    if (open) {
      setCommand("");
      setArgsText("");
      setWait(false);
      setUntil("__default__");
      setTimeoutMs("");
    }
  }, [open]);

  const valid = controlsSlashCommandValid(command);
  const known =
    provider !== null && command !== ""
      ? provider.commands.find(
          (c) => c === command.replace(/^\//, "") || c === command,
        )
      : undefined;

  const submit = () => {
    const args = argsText.trim() === "" ? [] : argsText.trim().split(/\s+/);
    void run(async () => {
      const result = await runControlsSlashCommand(machine, {
        target: agent.pane_id,
        command,
        args,
        wait,
        waitUntil: waitUntilArg(until),
        timeoutMs: optionalMs(timeout),
        expect: controlsExpectFromAgent(agent),
      });
      onClose();
      return result;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send slash command</DialogTitle>
          <DialogDescription>
            Provider slash-command passthrough to {controlsAgentLabel(agent)} (
            {agent.pane_id}) via the controls plugin — submitted as prompt
            text, so interpretation is provider-TUI dependent (fragile by
            contract). Generation guards are applied automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Field label="Command" hint={provider !== null ? `provider: ${provider.id} (advisory table)` : undefined}>
            <Input
              size="sm"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/model"
              aria-label="Slash command"
            />
          </Field>
          {command !== "" && !valid ? (
            <p className="text-2xs text-destructive">
              must look like /name (letters, digits, _ and -)
            </p>
          ) : null}
          {provider !== null && provider.commands.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {provider.commands.slice(0, 12).map((c) => (
                // oxlint-disable-next-line herdr-t3/no-raw-control -- inline chip button styled as text, same exception as HandoffsSurface lineage links
                <button
                  key={c}
                  type="button"
                  className="rounded-sm border border-border/60 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground hover:bg-accent/40"
                  onClick={() => setCommand(`/${c}`)}
                >
                  /{c}
                </button>
              ))}
              {provider.commands.length > 12 ? (
                <span className="text-2xs text-muted-foreground/70">
                  +{provider.commands.length - 12} more
                </span>
              ) : null}
            </div>
          ) : null}
          {known !== undefined ? (
            <p className="text-2xs text-muted-foreground">
              known_command: true (advisory, unverified)
            </p>
          ) : command !== "" && valid && provider !== null ? (
            <p className="text-2xs text-muted-foreground">
              not in the advisory table — still forwarded (known_command is a
              hint, never a gate)
            </p>
          ) : null}
          <Field label="Arguments" hint="joined with spaces upstream; no quoting layer">
            <Input
              size="sm"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="optional args"
              aria-label="Command arguments"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Switch
              size="sm"
              checked={wait}
              onCheckedChange={(v) => setWait(v === true)}
              aria-label="Wait for status after submit"
            />
            <span className="text-2xs text-muted-foreground">
              wait for a status transition after submit
            </span>
          </div>
          {wait ? (
            <div className="flex flex-col gap-1">
              <Field label="Wait until">
                <Select value={until} onValueChange={setUntil}>
                  <SelectTrigger aria-label="Wait until status" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WAIT_UNTIL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Timeout (ms)">
                <Input
                  size="sm"
                  value={timeout}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                  placeholder="optional"
                  inputMode="numeric"
                  aria-label="Wait timeout ms"
                />
              </Field>
            </div>
          ) : null}
          {error !== null ? (
            <p className="text-2xs text-destructive">command failed: {error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !valid || command.trim() === ""}
            onClick={submit}
          >
            {busy ? "Sending…" : "Send command"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- interrupt dialog ---- */

function InterruptDialog({
  machine,
  agent,
  open,
  onClose,
  onOutcome,
}: {
  machine: string;
  agent: AgentInfo;
  open: boolean;
  onClose: () => void;
  onOutcome: (outcome: LastOutcome) => void;
}) {
  const [keysText, setKeysText] = useState("");
  const { busy, error, run } = useMutationRun(onOutcome);

  useEffect(() => {
    if (open) setKeysText("");
  }, [open]);

  const keys = keysText
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter((k) => k !== "");

  const submit = () => {
    void run(async () => {
      const result = await interruptControlsAgent(machine, {
        target: agent.pane_id,
        keys,
        expect: controlsExpectFromAgent(agent),
      });
      onClose();
      return result;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Interrupt agent</DialogTitle>
          <DialogDescription>
            PTY-level key injection into {controlsAgentLabel(agent)} (
            {agent.pane_id}) — NOT a structured interrupt; the effect depends
            on the provider's keybindings. Empty keys send the plugin default
            (<code>esc</code>). Generation guards are applied automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Field label="Keys" hint="space or comma separated, e.g. esc or ctrl+c">
            <Input
              size="sm"
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
              placeholder="esc"
              aria-label="Interrupt keys"
            />
          </Field>
          {error !== null ? (
            <p className="text-2xs text-destructive">interrupt failed: {error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={submit}>
            {busy ? "Sending keys…" : "Send keys"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- wait dialog (non-mutating) ---- */

function WaitDialog({
  machine,
  agent,
  open,
  onClose,
  onOutcome,
}: {
  machine: string;
  agent: AgentInfo;
  open: boolean;
  onClose: () => void;
  onOutcome: (outcome: LastOutcome) => void;
}) {
  const [until, setUntil] = useState("__default__");
  const [timeout, setTimeoutMs] = useState("");
  const { busy, error, run } = useMutationRun(onOutcome);

  useEffect(() => {
    if (open) {
      setUntil("__default__");
      setTimeoutMs("");
    }
  }, [open]);

  const submit = () => {
    void run(async () => {
      const result = await waitControlsAgent(machine, {
        target: agent.pane_id,
        until: waitUntilArg(until),
        timeoutMs: optionalMs(timeout),
        expect: controlsExpectFromAgent(agent),
      });
      onClose();
      return result;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Wait for agent status</DialogTitle>
          <DialogDescription>
            Observe {controlsAgentLabel(agent)} ({agent.pane_id}) until the
            status matches — non-mutating read through the controls plugin.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Field label="Wait until">
            <Select value={until} onValueChange={setUntil}>
              <SelectTrigger aria-label="Wait until status" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WAIT_UNTIL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Timeout (ms)">
            <Input
              size="sm"
              value={timeout}
              onChange={(e) => setTimeoutMs(e.target.value)}
              placeholder="optional"
              inputMode="numeric"
              aria-label="Wait timeout ms"
            />
          </Field>
          {error !== null ? (
            <p className="text-2xs text-destructive">wait failed: {error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={submit}>
            {busy ? "Waiting…" : "Wait"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- start dialog ---- */

function paneLabel(pane: PaneInfo): string {
  return (
    pane.terminal_title_stripped ??
    pane.terminal_title ??
    pane.title ??
    pane.label ??
    pane.pane_id
  );
}

function StartDialog({
  machine,
  cap,
  panes,
  agents,
  open,
  onClose,
  onOutcome,
}: {
  machine: string;
  cap: ControlsCapability;
  panes: PaneInfo[];
  agents: AgentInfo[];
  open: boolean;
  onClose: () => void;
  onOutcome: (outcome: LastOutcome) => void;
}) {
  const [paneId, setPaneId] = useState("");
  const [kind, setKind] = useState("");
  const [customKind, setCustomKind] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [resumeValue, setResumeValue] = useState("");
  const [resumeFrom, setResumeFrom] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [wait, setWait] = useState(false);
  const [until, setUntil] = useState("__default__");
  const { busy, error, run } = useMutationRun(onOutcome);

  const providerIds = useMemo(() => cap.providers.map((p) => p.id), [cap]);
  // `kind` holds a provider id, "__custom__", or "" (free-text path when
  // the capability table is empty). The effective kind resolves aliases
  // plugin-side; the capability lookup stays verbatim on the typed value.
  const agentKind = kind === "__custom__" ? customKind.trim() : kind;
  const provider = controlsProvider(
    cap,
    agentKind !== "" ? agentKind : undefined,
  );
  const launch = provider?.launch ?? null;

  useEffect(() => {
    if (open) {
      setPaneId("");
      setKind(providerIds[0] ?? "");
      setCustomKind("");
      setName("");
      setModel("");
      setReasoning("");
      setPermissionMode("");
      setResumeValue("");
      setResumeFrom("");
      setTimeoutMs("");
      setWait(false);
      setUntil("__default__");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  const bothResume = resumeValue.trim() !== "" && resumeFrom !== "";
  const canSubmit = paneId !== "" && agentKind !== "" && !bothResume;

  const submit = () => {
    void run(async () => {
      const result = await startControlsAgent(machine, {
        paneId,
        agent: agentKind,
        name: name.trim() === "" ? undefined : name.trim(),
        model: model.trim() === "" ? undefined : model.trim(),
        reasoning: reasoning.trim() === "" ? undefined : reasoning.trim(),
        permissionMode: permissionMode === "" ? undefined : permissionMode,
        resume: resumeValue.trim() === "" ? undefined : resumeValue.trim(),
        resumeFrom: resumeFrom === "" ? undefined : resumeFrom,
        timeoutMs: optionalMs(timeoutMs),
        wait,
        waitUntil: waitUntilArg(until),
      });
      onClose();
      return result;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start agent</DialogTitle>
          <DialogDescription>
            Launch a detected agent kind in an existing shell pane through the
            controls plugin. Launch options map to provider CLI args via the
            contract's per-provider table; unsupported options are hidden,
            never defaulted. Raw --arg passthrough is not exposed here.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
          <Field label="Pane" hint="must sit at its interactive shell prompt; herdr rejects busy panes">
            <Select
              value={paneId === "" ? "__none__" : paneId}
              onValueChange={(v) => setPaneId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger aria-label="Target pane" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">select a pane…</SelectItem>
                {panes.map((pane) => (
                  <SelectItem key={pane.pane_id} value={pane.pane_id}>
                    {paneLabel(pane)}
                    {pane.agent != null && pane.agent !== ""
                      ? ` · agent ${pane.agent}`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {panes.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              no panes in the snapshot
            </p>
          ) : null}
          <div className="flex gap-2">
            <Field label="Agent kind" className="flex-1">
              {providerIds.length > 0 ? (
                <Select value={kind} onValueChange={(v) => { setKind(v); setCustomKind(""); }}>
                  <SelectTrigger aria-label="Agent kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                    <SelectItem value="__custom__">custom…</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  size="sm"
                  value={customKind}
                  onChange={(e) => setCustomKind(e.target.value)}
                  placeholder="claude"
                  aria-label="Agent kind"
                />
              )}
            </Field>
            {providerIds.length > 0 && kind === "__custom__" ? (
              <Field label="Custom kind" className="flex-1">
                <Input
                  size="sm"
                  value={customKind}
                  onChange={(e) => setCustomKind(e.target.value)}
                  placeholder="provider kind or alias"
                  aria-label="Custom agent kind"
                />
              </Field>
            ) : null}
          </div>
          <Field label="Name" hint="optional; herdr rules [a-z][a-z0-9_-]{0,31}, default <kind>-<suffix>">
            <Input
              size="sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="optional"
              aria-label="Agent name"
            />
          </Field>
          {launch !== null && (launch.model || launch.reasoning || launch.permissionModes.length > 0 || launch.resumeSupported) ? (
            <div className="flex flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5">
              <p className="text-2xs font-medium text-muted-foreground">
                Launch options — {provider?.id ?? "provider"}
              </p>
              {launch.model ? (
                <Field label="Model">
                  <Input
                    size="sm"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="optional"
                    aria-label="Model"
                  />
                </Field>
              ) : null}
              {launch.reasoning ? (
                <Field label="Reasoning">
                  <Input
                    size="sm"
                    value={reasoning}
                    onChange={(e) => setReasoning(e.target.value)}
                    placeholder="optional"
                    aria-label="Reasoning level"
                  />
                </Field>
              ) : null}
              {launch.permissionModes.length > 0 ? (
                <Field label="Permission mode">
                  <Select
                    value={permissionMode === "" ? "__default__" : permissionMode}
                    onValueChange={(v) => setPermissionMode(v === "__default__" ? "" : v)}
                  >
                    <SelectTrigger aria-label="Permission mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">provider default</SelectItem>
                      {launch.permissionModes.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {mode}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              {launch.resumeSupported ? (
                <p className="text-2xs text-muted-foreground/70">
                  resume supported: {launch.resumeDetail ?? "yes"}
                </p>
              ) : null}
            </div>
          ) : launch !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              no verified launch options for {provider?.id ?? "this provider"} —
              model/reasoning/permission-mode/resume are unsupported upstream
            </p>
          ) : kind !== "" || customKind.trim() !== "" ? (
            <p className="text-2xs text-muted-foreground/70">
              provider not in the capability table — launch options stay
              unsupported (never defaulted)
            </p>
          ) : null}
          {launch !== null && !launch.resumeSupported ? null : (
            <div className="flex flex-col gap-2 rounded-md border border-border/60 px-2 py-1.5">
              <p className="text-2xs font-medium text-muted-foreground">Resume (optional)</p>
              <Field label="Resume session value" hint="literal provider session id/path">
                <Input
                  size="sm"
                  value={resumeValue}
                  onChange={(e) => setResumeValue(e.target.value)}
                  placeholder="optional"
                  aria-label="Resume session value"
                />
              </Field>
              <Field label="Or resume from agent" hint="reuses the target's reported agent_session">
                <Select value={resumeFrom === "" ? "__none__" : resumeFrom} onValueChange={(v) => setResumeFrom(v === "__none__" ? "" : v)}>
                  <SelectTrigger aria-label="Resume from agent" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">none</SelectItem>
                    {agents.map((agent) => (
                      <SelectItem key={agent.pane_id} value={agent.pane_id}>
                        {controlsAgentLabel(agent)} ({agent.pane_id})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {bothResume ? (
                <p className="text-2xs text-destructive">
                  pick at most one of resume value or resume-from target
                </p>
              ) : null}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch
              size="sm"
              checked={wait}
              onCheckedChange={(v) => setWait(v === true)}
              aria-label="Wait for agent after launch"
            />
            <span className="text-2xs text-muted-foreground">
              wait for the agent to reach a status after launch
            </span>
          </div>
          {wait ? (
            <Field label="Wait until">
              <Select value={until} onValueChange={setUntil}>
                <SelectTrigger aria-label="Post-launch wait until" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">default (idle|working)</SelectItem>
                  {AGENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label="Launch timeout (ms)" hint="agent.start readiness wait, (3000, 300000]">
            <Input
              size="sm"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              placeholder="optional (upstream default 30000)"
              inputMode="numeric"
              aria-label="Launch timeout ms"
            />
          </Field>
          {error !== null ? (
            <p className="text-2xs text-destructive">start failed: {error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !canSubmit} onClick={submit}>
            {busy ? "Launching…" : "Start agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- surface ------------------------------ */

export function ControlsSurface({ machine }: { machine: string }) {
  const state = useControlsState(machine);
  const bridge = useBridgeState();
  const snapshot = bridge.snapshots[machine];
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);
  const panes = useMemo(() => snapshot?.panes ?? [], [snapshot]);
  const [cap, setCap] = useState<ControlsCapability | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPane, setSelectedPane] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"command" | "interrupt" | "wait" | "start" | null>(
    null,
  );
  const [outcome, setOutcome] = useState<LastOutcome | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    controlsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshControls(machine);
  }, [machine, state.status.kind]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshControls(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const selectedAgent =
    agents.find((a) => a.pane_id === selectedPane) ?? agents[0] ?? null;
  const selectedProvider = controlsProvider(cap, selectedAgent?.agent ?? undefined);

  const canCommand = controlsSupportsMutation(cap, "command");
  const canInterrupt = controlsSupportsMutation(cap, "interrupt");
  const canStart = controlsSupportsMutation(cap, "start");
  const canWait = controlsSupports(cap, "wait");
  const mutationsAdvertised =
    cap != null &&
    (cap.mutationCommands.has("command") ||
      cap.mutationCommands.has("interrupt") ||
      cap.mutationCommands.has("start"));

  const runWaitNow = () => {
    if (selectedAgent === null) return;
    setBusyAction(true);
    setOutcome(null);
    void waitControlsAgent(machine, {
      target: selectedAgent.pane_id,
      expect: controlsExpectFromAgent(selectedAgent),
    })
      .then((result) => setOutcome({ kind: "ok", result }))
      .catch((e: unknown) => setOutcome({ kind: "error", text: errorText(e) }))
      .finally(() => setBusyAction(false));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Agent control operations from the rebuildup.controls plugin —
            provider slash commands, PTY-level interrupt, status wait, and
            agent launch with per-provider options. Only capabilities herdr
            does not already provide are offered; send/rename/read stay on
            the bridge RPCs.
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh controls"
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading controls…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
          </p>
        ) : null}

        {cap !== null && cap !== undefined ? (
          <p className="text-2xs text-muted-foreground/70">
            contract {cap.contract} v{cap.version}
            {cap.mutationCommands.size > 0
              ? ` · mutation_commands: ${[...cap.mutationCommands].join(", ")}`
              : ""}
            {cap.providers.length > 0
              ? ` · ${cap.providers.length} providers`
              : ""}
          </p>
        ) : null}

        {state.status.kind === "ready" ? (
          <div className="flex flex-col gap-4">
            {cap === null ? (
              <p className="text-2xs text-muted-foreground">
                capability probe unavailable — operations stay gated off
              </p>
            ) : null}
            {cap !== null && cap !== undefined && !mutationsAdvertised ? (
              <p className="text-2xs text-muted-foreground">
                this plugin build advertises no mutation commands — read-only
                wait remains available
              </p>
            ) : null}

            <section className="flex flex-col gap-1.5">
              <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Agents
              </h3>
              {agents.length === 0 ? (
                <p className="text-2xs text-muted-foreground">
                  no agents in the snapshot — start one below or in a pane
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {agents.map((agent) => (
                    <AgentRow
                      key={agent.pane_id}
                      agent={agent}
                      selected={selectedAgent?.pane_id === agent.pane_id}
                      onSelect={() =>
                        setSelectedPane((current) =>
                          current === agent.pane_id ? null : agent.pane_id,
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            {selectedAgent !== null ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Operations — {controlsAgentLabel(selectedAgent)}
                </h3>
                {selectedAgent.agent_status === "blocked" ? (
                  <p className="text-2xs text-warning">
                    agent is blocked — prompt-based commands are rejected
                    upstream (requires_interactive_input); use interrupt or the
                    pane itself for the open dialog
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  {canCommand === true ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => setDialog("command")}
                    >
                      <SendIcon />
                      Slash command…
                    </Button>
                  ) : null}
                  {canInterrupt === true ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => setDialog("interrupt")}
                    >
                      <CircleStopIcon />
                      Interrupt…
                    </Button>
                  ) : null}
                  {canWait === true ? (
                    <>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={runWaitNow}
                        disabled={busyAction}
                        title="agent.wait with upstream defaults (idle|done|blocked)"
                      >
                        <HourglassIcon className={busyAction ? "animate-pulse" : undefined} />
                        Wait now
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={() => setDialog("wait")}
                      >
                        <HourglassIcon />
                        Wait…
                      </Button>
                    </>
                  ) : null}
                </div>
                {canCommand !== true && canInterrupt !== true && canWait !== true ? (
                  <p className="text-2xs text-muted-foreground">
                    no operations offered — capability gating closed every
                    command for this host
                  </p>
                ) : null}
              </section>
            ) : null}

            {canStart === true ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Launch
                </h3>
                <div>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => setDialog("start")}
                  >
                    <PlayIcon />
                    Start agent…
                  </Button>
                </div>
                <p className="text-2xs text-muted-foreground/70">
                  agent.start in an existing shell pane with the contract's
                  per-provider launch options (model / reasoning /
                  permission-mode / resume)
                </p>
              </section>
            ) : null}

            {cap !== null && cap !== undefined ? (
              <p className="text-2xs text-muted-foreground/70">
                structured dialogs (approval/question/attachments/goals):{" "}
                {Object.entries(cap.dialogs)
                  .map(([name, status]) => `${name}=${status}`)
                  .join(", ") || "not advertised"}
                {cap.upstreamGaps.length > 0
                  ? ` · upstream gaps: ${cap.upstreamGaps.length}`
                  : ""}
              </p>
            ) : null}

            {outcome !== null ? <ResultView outcome={outcome} /> : null}
          </div>
        ) : null}
      </DialogPanel>

      {selectedAgent !== null ? (
        <>
          <CommandDialog
            machine={machine}
            agent={selectedAgent}
            provider={selectedProvider}
            open={dialog === "command"}
            onClose={() => setDialog(null)}
            onOutcome={setOutcome}
          />
          <InterruptDialog
            machine={machine}
            agent={selectedAgent}
            open={dialog === "interrupt"}
            onClose={() => setDialog(null)}
            onOutcome={setOutcome}
          />
          <WaitDialog
            machine={machine}
            agent={selectedAgent}
            open={dialog === "wait"}
            onClose={() => setDialog(null)}
            onOutcome={setOutcome}
          />
        </>
      ) : null}
      {cap !== null && cap !== undefined ? (
        <StartDialog
          machine={machine}
          cap={cap}
          panes={panes}
          agents={agents}
          open={dialog === "start"}
          onClose={() => setDialog(null)}
          onOutcome={setOutcome}
        />
      ) : null}
    </div>
  );
}
