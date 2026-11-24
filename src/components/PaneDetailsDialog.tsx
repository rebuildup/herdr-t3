import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { rpc } from "../lib/api";
import { focusPaneTerminal } from "../lib/paneFocus";
import { agentStatusLabel } from "./AgentStatusBadge";
import type {
  PaneInfo,
  PaneProcessInfo,
  PaneProcessInfoProcess,
} from "../../shared/protocol";

interface ExplainResult {
  explain?: Record<string, unknown>;
}

interface ReadResult {
  read?: { text?: string; truncated?: boolean };
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
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
  const [processInfo, setProcessInfo] = useState<PaneProcessInfo | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [explain, setExplain] = useState<Record<string, unknown> | null>(null);
  const [recentOutput, setRecentOutput] = useState<string | null>(null);
  const [outputTruncated, setOutputTruncated] = useState(false);
  const paneId = pane?.pane_id ?? null;
  const isAgent = Boolean(pane?.agent);

  useEffect(() => {
    setProcessInfo(null);
    setProcessError(null);
    setExplain(null);
    setRecentOutput(null);
    setOutputTruncated(false);
    if (!paneId) return;
    let cancelled = false;
    void rpc<{ process_info?: PaneProcessInfo }>(
      "pane.process_info",
      { pane_id: paneId },
      machine,
    )
      .then((res) => {
        if (!cancelled) setProcessInfo(res?.process_info ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProcessError(error instanceof Error ? error.message : String(error));
        }
      });
    if (isAgent) {
      void rpc<ExplainResult>("agent.explain", { target: paneId }, machine)
        .then((res) => {
          if (!cancelled && res?.explain) setExplain(res.explain);
        })
        .catch(() => {});
      void rpc<ReadResult>(
        "agent.read",
        { target: paneId, lines: 30, format: "text", strip_ansi: true },
        machine,
      )
        .then((res) => {
          if (!cancelled && res?.read?.text !== undefined) {
            setRecentOutput(res.read.text);
            setOutputTruncated(res.read.truncated === true);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [paneId, machine, isAgent]);

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
        <DialogTitle>{pane ? agentStatusLabel(pane.agent_status) : ""} pane details</DialogTitle>
        <DialogDescription>
          Internal identifiers and diagnostics for {pane?.pane_id ?? ""}.
        </DialogDescription>
        {pane ? (
          <div className="flex max-h-96 flex-col gap-4 overflow-y-auto">
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
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
