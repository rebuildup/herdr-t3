import type { AgentStatus, PaneInfo } from "../../shared/protocol";
import { cn } from "../lib/utils";
import { Circle, CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";

const LABELS: Record<string, string> = {
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  idle: "Idle",
};

export function agentStatusLabel(status: AgentStatus): string {
  return LABELS[status] ?? "Unknown";
}

export function AgentStatusBadge({ status, className }: { status: AgentStatus; className?: string }) {
  const color =
    status === "working"
      ? "text-primary"
      : status === "blocked"
        ? "text-warning"
        : status === "done"
          ? "text-success"
          : "text-muted-foreground";
  const Icon =
    status === "working"
      ? Loader2
      : status === "blocked"
        ? CircleX
        : status === "done"
          ? CircleCheck
          : status === "idle"
            ? Circle
            : CircleDashed;
  return (
    <span className={cn("inline-flex items-center gap-1 text-2xs", color, className)}>
      <Icon className={cn("size-3", status === "working" && "motion-safe:animate-spin")} />
      {agentStatusLabel(status)}
    </span>
  );
}

/**
 * On-demand detail for the focused pane's agent state (issue #110):
 * status label, agent identity, herdr `state_labels` string entries, and
 * cwd — the "details live behind the summary" half of the info design.
 */
export function PaneStatusDetail({ pane }: { pane: PaneInfo }) {
  const stateLabels = Object.entries(pane.state_labels ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return (
    <div className="flex flex-col gap-0.5">
      <div>
        {agentStatusLabel(pane.agent_status)}
        {pane.agent ? ` · ${pane.agent}` : ""}
      </div>
      {pane.display_agent && pane.display_agent !== pane.agent ? (
        <div className="text-muted-foreground">{pane.display_agent}</div>
      ) : null}
      {stateLabels.map(([key, value]) => (
        <div key={key} className="text-muted-foreground">
          {key}: {value}
        </div>
      ))}
      {pane.cwd ? <div className="truncate text-muted-foreground">{pane.cwd}</div> : null}
    </div>
  );
}
