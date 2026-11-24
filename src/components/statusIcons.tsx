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
      return <Loader2 className="size-3.5 motion-safe:animate-spin" />;
    case "blocked":
      return <CircleX className="size-3.5 text-warning" />;
    case "done":
      return <CircleCheck className="size-3.5 text-success" />;
    case "idle":
      return <Circle className="size-3.5 text-muted-foreground" />;
    default:
      return <CircleDashed className="size-3.5 text-muted-foreground" />;
  }
}

export function machineStatusIcon(status: MachineStatus) {
  switch (status) {
    case "online":
      return <Wifi className="size-3.5 text-success" />;
    case "connecting":
    case "reconnecting":
      return <RefreshCw className="size-3 motion-safe:animate-spin text-muted-foreground" />;
    case "auth_required":
      return <CircleX className="size-3.5 text-warning" />;
    case "disabled":
      return <MonitorOff className="size-3.5 text-muted-foreground" />;
    default:
      return <WifiOff className="size-3.5 text-muted-foreground" />;
  }
}
