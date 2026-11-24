import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  MonitorOff,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { AgentStatus, MachineStatus } from "../../shared/protocol";

export function statusIcon(status: AgentStatus) {
  switch (status) {
    case "working":
      return <Loader2 className="size-3.5 transition-colors text-primary motion-safe:animate-spin" />;
    case "blocked":
      return <CircleX className="size-3.5 transition-colors text-warning" />;
    case "done":
      return <CircleCheck className="size-3.5 transition-colors text-success" />;
    case "idle":
      return <Circle className="size-3.5 transition-colors text-muted-foreground" />;
    default:
      return <CircleDashed className="size-3.5 transition-colors text-muted-foreground" />;
  }
}

export function machineStatusIcon(status: MachineStatus) {
  switch (status) {
    case "online":
      return <Wifi className="size-3.5 transition-colors text-success" />;
    case "connecting":
    case "reconnecting":
      return <RefreshCw className="size-3 transition-colors motion-safe:animate-spin text-muted-foreground" />;
    case "auth_required":
      return <CircleX className="size-3.5 transition-colors text-warning" />;
    case "disabled":
      return <MonitorOff className="size-3.5 transition-colors text-muted-foreground" />;
    default:
      return <WifiOff className="size-3.5 transition-colors text-muted-foreground" />;
  }
}
