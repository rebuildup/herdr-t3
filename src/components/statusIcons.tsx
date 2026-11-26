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
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

/* Spinning status glyphs go through `visible-animate-spin` +
   `observeVisibleAnimation` (issue #381, T3 `visibleAnimation.ts`):
   the animation only runs while the icon is on-screen in a visible
   document with motion allowed, so collapsed/off-screen rows stop
   animating. */
function WorkingSpinner() {
  return (
    <Loader2
      ref={observeVisibleAnimation}
      className="size-3.5 transition-colors text-primary motion-safe:visible-animate-spin"
    />
  );
}

function ConnectingSpinner() {
  return (
    <RefreshCw
      ref={observeVisibleAnimation}
      className="size-3 transition-colors motion-safe:visible-animate-spin text-muted-foreground"
    />
  );
}

export function statusIcon(status: AgentStatus) {
  switch (status) {
    case "working":
      return <WorkingSpinner />;
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
      return <ConnectingSpinner />;
    case "auth_required":
      return <CircleX className="size-3.5 transition-colors text-warning" />;
    case "disabled":
      return <MonitorOff className="size-3.5 transition-colors text-muted-foreground" />;
    default:
      return <WifiOff className="size-3.5 transition-colors text-muted-foreground" />;
  }
}
