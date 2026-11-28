import type { AgentStatus, PaneInfo } from "../../shared/protocol";
import { cn } from "../lib/utils";
import { AgentIdentityIcon } from "./agentIdentityIcon";

const LABELS: Record<string, string> = {
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  idle: "Idle",
};

export function agentStatusLabel(status: AgentStatus): string {
  return LABELS[status] ?? "Unknown";
}

export function isKnownAgentStatus(status: AgentStatus): boolean {
  return LABELS[status] !== undefined;
}

export function AgentStatusBadge({
  status,
  agent,
  className,
}: {
  status: AgentStatus;
  /** Provider kind for the glyph's brand mark; omit for the generic mark. */
  agent?: string | null | undefined;
  className?: string;
}) {
  const color =
    status === "working"
      ? "text-primary"
      : status === "blocked"
        ? "text-warning"
        : status === "done"
          ? "text-success"
          : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 text-2xs transition-colors", color, className)}>
      {/* The status glyph is the unified AgentIdentityIcon (issue #550) —
          brand mark + ring + marker, dense `sm` density for the badge. */}
      <AgentIdentityIcon agent={agent} status={status} size="sm" />
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
