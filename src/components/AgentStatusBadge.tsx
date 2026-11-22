import type { AgentStatus } from "../../shared/protocol";
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
      <Icon className={cn("size-3", status === "working" && "animate-spin")} />
      {agentStatusLabel(status)}
    </span>
  );
}
