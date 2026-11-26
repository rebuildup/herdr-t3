import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { focusPaneTerminal } from "../lib/paneFocus";
import { usePaneDiagnostics } from "../lib/paneDiagnostics";
import { agentStatusLabel, isKnownAgentStatus } from "./AgentStatusBadge";
import type { PaneInfo, PaneProcessInfoProcess } from "../../shared/protocol";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    // Agent-state keys are long identifiers (e.g.
    // local_override_shadowing_note); a fixed label column let them
    // overflow into the value — a fixed label column with truncation
    // keeps the pair separated (issue #142).
    <div className="flex min-w-0 gap-3 text-xs">
      <span className="w-44 shrink-0 truncate text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{value}</span>
    </div>
  );
}

function ProcessRow({ process }: { process: PaneProcessInfoProcess }) {
  const detail = process.cmdline ?? process.argv?.join(" ") ?? process.argv0 ?? process.name;
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-12 shrink-0 text-muted-foreground tabular-nums">{process.pid}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{detail}</span>
      {process.cwd ? (
        <span className="hidden max-w-40 truncate text-muted-foreground sm:inline">{process.cwd}</span>
      ) : null}
    </div>
  );
}

/**
 * Internal/diagnostic detail surface (docs/design/info-architecture.md §5):
 * ids, cwd, process info, agent explain and recent agent output — the
 * place internal identifiers live, fetched on demand through the whitelisted
 * `pane.process_info` / `agent.explain` / `agent.read` RPCs (issue #113).
 * Each fetch fails independently so older herdr versions degrade field by
 * field instead of breaking the dialog.
 */
export function PaneDetailsDialog({
  pane,
  machine,
  onClose,
}: {
  pane: PaneInfo | null;
  machine: string;
  onClose: () => void;
}) {
  const requestClose = () => {
    onClose();
    setTimeout(() => focusPaneTerminal(), 0);
  };
  const paneId = pane?.pane_id ?? null;
  const isAgent = Boolean(pane?.agent);
  const { processInfo, processError, explain, recentOutput, outputTruncated } =
    usePaneDiagnostics(paneId, machine, isAgent);

  const explainEntries = explain
    ? Object.entries(explain).filter(
        ([, v]) =>
          v === null ||
          ["string", "number", "boolean"].includes(typeof v),
      )
    : [];

  return (
    <Dialog open={pane !== null} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {pane && isKnownAgentStatus(pane.agent_status)
              ? `${agentStatusLabel(pane.agent_status)} pane details`
              : "Pane details"}
          </DialogTitle>
          <DialogDescription>
            Internal identifiers and diagnostics for {pane?.pane_id ?? ""}.
          </DialogDescription>
        </DialogHeader>
        {pane ? (
          <DialogPanel>
            <section className="flex flex-col gap-1">
              <Field label="workspace" value={pane.workspace_id} />
              <Field label="tab" value={pane.tab_id} />
              <Field label="pane" value={pane.pane_id} />
              <Field label="terminal" value={pane.terminal_id} />
              <Field label="title" value={pane.terminal_title_stripped ?? pane.terminal_title ?? pane.title} />
              <Field label="label" value={pane.label} />
              <Field label="agent" value={pane.agent} />
              <Field label="cwd" value={pane.cwd} />
              <Field label="foreground cwd" value={pane.foreground_cwd} />
              <Field
                label="agent session"
                value={pane.agent_session ? `${pane.agent_session.agent} ${pane.agent_session.value}` : null}
              />
              <Field
                label="scroll"
                value={
                  pane.scroll?.offset_from_bottom !== undefined
                    ? `${pane.scroll.offset_from_bottom} rows above bottom`
                    : null
                }
              />
            </section>
            <section className="flex flex-col gap-1">
              <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Process
              </div>
              {processError ? (
                <div className="text-xs text-muted-foreground">
                  process info unavailable: {processError}
                </div>
              ) : processInfo ? (
                <>
                  <Field label="shell pid" value={processInfo.shell_pid ?? null} />
                  <Field label="tty" value={processInfo.tty} />
                  {processInfo.foreground_processes.map((p) => (
                    <ProcessRow key={p.pid} process={p} />
                  ))}
                </>
              ) : (
                <div className="text-xs text-muted-foreground">loading…</div>
              )}
            </section>
            {isAgent ? (
              <section className="flex flex-col gap-1">
                <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Agent state
                </div>
                {explainEntries.length > 0 ? (
                  explainEntries.map(([key, value]) => (
                    <Field key={key} label={key} value={String(value)} />
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground">no explanation available</div>
                )}
                {recentOutput !== null ? (
                  <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-2xs whitespace-pre-wrap">
                    {recentOutput}
                    {outputTruncated ? "\n… (truncated)" : ""}
                  </pre>
                ) : null}
              </section>
            ) : null}
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
