/**
 * Wire types shared by the bridge (server/) and the client (src/).
 *
 * The snapshot shapes mirror herdr's API schema (protocol 22 at the pinned
 * baseline, see docs/upstream.md). They are declared here rather than
 * generated because herdr-t3 only consumes the fields it renders; fields
 * herdr adds later are tolerated by the parser, not by these types.
 */

export type AgentStatus = "blocked" | "done" | "idle" | "unknown" | "working" | (string & {});

export interface AgentSessionInfo {
  agent: string;
  kind: string;
  source: string;
  value: string;
}

export interface AgentInfo {
  agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  agent_status: AgentStatus;
  completion_seq?: number | null;
  cwd?: string | null;
  display_agent?: string | null;
  focused: boolean;
  foreground_cwd?: string | null;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  name?: string | null;
  pane_id: string;
  revision: number;
  screen_detection_skipped?: boolean;
  state_change_seq?: number;
  state_labels?: Record<string, unknown>;
  tab_id: string;
  terminal_id: string;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  title?: string | null;
  tokens?: Record<string, unknown>;
  workspace_id: string;
}

export interface PaneScrollInfo {
  offset_from_bottom?: number;
  viewport_rows?: number;
  [key: string]: unknown;
}

/** `pane.process_info` result payload (`PaneProcessInfo` in herdr's schema). */
export interface PaneProcessInfoProcess {
  pid: number;
  name: string;
  argv0?: string | null;
  argv?: string[] | null;
  cmdline?: string | null;
  cwd?: string | null;
}

export interface PaneProcessInfo {
  pane_id: string;
  shell_pid?: number | null;
  foreground_process_group_id?: number | null;
  tty?: string | null;
  foreground_processes: PaneProcessInfoProcess[];
}

/** Inclusive display-cell columns of a detected link on a viewport row. */
export interface PaneLinkRegion {
  row: number;
  start_col: number;
  end_col: number;
}

/** `pane.link.resolve` result payload. */
export interface PaneLinkResolveResult {
  regions: PaneLinkRegion[];
}

/** `pane.link.activate` result payload. */
export interface PaneLinkActivateResult {
  url?: string | null;
  handled: boolean;
}

export interface PaneInfo {
  agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  display_agent?: string | null;
  focused: boolean;
  foreground_cwd?: string | null;
  label?: string | null;
  pane_id: string;
  restore_error?: string | null;
  revision: number;
  scroll?: PaneScrollInfo | null;
  state_labels?: Record<string, unknown>;
  tab_id: string;
  terminal_id: string;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  title?: string | null;
  tokens?: Record<string, unknown>;
  workspace_id: string;
}

export interface TabInfo {
  agent_status: AgentStatus;
  focused: boolean;
  label: string;
  number: number;
  pane_count: number;
  tab_id: string;
  workspace_id: string;
}

export interface WorkspaceWorktreeInfo {
  checkout_path: string;
  is_linked_worktree: boolean;
  repo_key: string;
  repo_name: string;
  repo_root: string;
}

/** One entry of a `worktree.list` response (`WorktreeInfo` in herdr's schema). */
export interface WorktreeListEntry {
  path: string;
  branch?: string | null;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  is_linked_worktree: boolean;
  open_workspace_id?: string | null;
  label: string;
}

/** `worktree.list` result: the resolved repo source plus every known worktree. */
export interface WorktreeListResult {
  source: {
    repo_key: string;
    repo_name: string;
    repo_root: string;
    source_checkout_path: string;
    source_workspace_id?: string | null;
  };
  worktrees: WorktreeListEntry[];
}

/**
 * Shared payload of `worktree.create` / `worktree.open` /
 * `worktree.remove` results (`WorktreeCreated` / `WorktreeOpened` /
 * `WorktreeRemoved` in herdr's schema). The UI treats the pushed snapshot
 * as truth; these fields are informational.
 */
export interface WorktreeMutationResult {
  workspace?: WorkspaceInfo;
  tab?: TabInfo;
  root_pane?: PaneInfo;
  worktree?: WorktreeListEntry;
  already_open?: boolean;
  workspace_id?: string;
  path?: string;
  forced?: boolean;
}

export interface WorkspaceInfo {
  active_tab_id: string;
  agent_status: AgentStatus;
  focused: boolean;
  label: string;
  number: number;
  pane_count: number;
  tab_count: number;
  tokens?: Record<string, unknown>;
  workspace_id: string;
  worktree?: WorkspaceWorktreeInfo | null;
}

export type SplitDirection = "down" | "right" | (string & {});

export interface PaneLayoutRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface PaneLayoutPane {
  focused: boolean;
  pane_id: string;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSplit {
  direction: SplitDirection;
  id: string;
  ratio: number;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSnapshot {
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
  tab_id: string;
  workspace_id: string;
  zoomed: boolean;
}

export interface SessionSnapshot {
  agents: AgentInfo[];
  focused_pane_id?: string | null;
  focused_tab_id?: string | null;
  focused_workspace_id?: string | null;
  layouts: PaneLayoutSnapshot[];
  panes: PaneInfo[];
  protocol: number;
  tabs: TabInfo[];
  version: string;
  workspaces: WorkspaceInfo[];
}

/* ------------------------------------------------------------------ */
/* herdr-t3 bridge <-> client contract                                  */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  ok: true;
  version: string;
  commit: string;
  herdr: {
    reachable: boolean;
    socket: string;
    version?: string;
    protocol?: number;
    /** reachability failure detail when reachable is false */
    error?: string;
  };
}

export interface SessionResponse {
  snapshot: SessionSnapshot;
}

/**
 * A connectable herdr endpoint as the bridge sees it: `local` is this
 * machine's herdr socket; every other id is a saved SSH machine from
 * herdr's own registry (`herdr machine list`).
 */
export type MachineStatus =
  | "online"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "disabled"
  | "unreachable"
  | "auth_required"
  | "incompatible"
  | "error";

export interface MachineInfo {
  id: string;
  label: string;
  kind: "local" | "ssh";
  /** SSH target for kind=ssh (never a credential). */
  target?: string;
  session?: string;
  enabled: boolean;
  status: MachineStatus;
  /** Human-readable detail: last error, herdr version, remediation hint. */
  detail?: string;
  version?: string;
  protocol?: number;
}

/** Client -> server WebSocket frames. `machine` selects the endpoint; absent means local. */
export type ClientFrame =
  | { type: "rpc"; id: string; method: RpcMethod; params: Record<string, unknown>; machine?: string }
  | { type: "subscribe_terminal"; paneId: string; cols?: number; rows?: number; machine?: string; takeover?: boolean }
  | { type: "unsubscribe_terminal"; paneId: string; machine?: string }
  /** `data` is base64 bytes: encoded keys/mouse/paste and engine replies are arbitrary bytes, not necessarily UTF-8. */
  | { type: "terminal_input"; paneId: string; data: string; machine?: string }
  | { type: "terminal_resize"; paneId: string; cols: number; rows: number; machine?: string }
  /** Structured pointer event forwarded as herdr AttachMouse; the server emits SGR reports only when the pane enabled mouse mode. */
  | {
      type: "terminal_mouse";
      paneId: string;
      machine?: string;
      action: "press" | "motion" | "release" | "moved";
      button?: "left" | "middle" | "right" | null;
      column: number;
      row: number;
      modifiers?: number;
    }
  /** Wheel scroll forwarded as herdr AttachScroll; the server arbitrates mouse-report vs scrollback vs alternate-scroll. */
  | {
      type: "terminal_scroll";
      paneId: string;
      machine?: string;
      direction: "up" | "down";
      lines?: number;
      column?: number;
      row?: number;
      modifiers?: number;
    }
  | { type: "list_machines" }
  | { type: "machine_connect"; machine: string }
  | { type: "machine_disconnect"; machine: string }
  | { type: "machine_add"; id: string; label: string; target: string; session?: string }
  /** `id` correlates the rpc_result; `machine` is herdr's saved-machine profile id. */
  | { type: "machine_remove"; id: string; machine: string }
  | { type: "machine_update"; id: string; machine: string; label?: string; enabled?: boolean };

/** Server -> client WebSocket frames. `machine` tags endpoint-scoped data. */
export type ServerFrame =
  | { type: "ready"; snapshot: SessionSnapshot; machine: string }
  | { type: "snapshot"; snapshot: SessionSnapshot; machine: string }
  | { type: "event"; event: unknown; machine: string }
  | { type: "rpc_result"; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string }; machine?: string }
  /** `data` is base64: terminal output is arbitrary bytes, not necessarily UTF-8. */
  | { type: "terminal_data"; paneId: string; data: string; machine: string }
  | { type: "terminal_closed"; paneId: string; reason?: string; machine: string }
  | { type: "machines"; machines: MachineInfo[] }
  | { type: "machine_status"; machine: MachineInfo };

/**
 * The herdr RPC methods the bridge exposes to the client. Anything not
 * listed is refused; the bridge is a gatekeeper, not a proxy.
 */
export const RPC_METHODS = [
  "session.snapshot",
  "workspace.create",
  "workspace.focus",
  "workspace.close",
  "workspace.rename",
  "workspace.move",
  "tab.create",
  "tab.focus",
  "tab.close",
  "tab.rename",
  "tab.move",
  "pane.split",
  "pane.close",
  "pane.focus",
  "pane.rename",
  "pane.zoom",
  "pane.resize",
  "pane.move",
  "pane.swap",
  "pane.scroll",
  "pane.clear",
  "layout.set_split_ratio",
  "pane.send_text",
  "pane.send_keys",
  "agent.get",
  "agent.prompt",
  "agent.rename",
  "agent.start",
  "agent.read",
  "agent.explain",
  "pane.focus_direction",
  "pane.process_info",
  "pane.link.resolve",
  "pane.link.activate",
  "worktree.list",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export function isRpcMethod(method: string): method is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(method);
}

/**
 * Runtime guard for inbound ClientFrames. The bridge trusts nothing: IPC and
 * WebSocket payloads are untrusted input and must be validated before they
 * reach `handleFrame`.
 */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  const paneId = frame["paneId"];
  const machine = frame["machine"];
  const machineOk = machine === undefined || (typeof machine === "string" && machine.length > 0 && machine.length <= 128);
  switch (frame["type"]) {
    case "rpc":
      return (
        typeof frame["id"] === "string" &&
        typeof frame["method"] === "string" &&
        isRpcMethod(frame["method"]) &&
        machineOk &&
        (frame["params"] === undefined ||
          (typeof frame["params"] === "object" && frame["params"] !== null && !Array.isArray(frame["params"])))
      );
    case "subscribe_terminal":
      return (
        typeof paneId === "string" &&
        paneId.length > 0 &&
        machineOk &&
        (frame["takeover"] === undefined || typeof frame["takeover"] === "boolean")
      );
    case "unsubscribe_terminal":
      return typeof paneId === "string" && paneId.length > 0 && machineOk;
    case "terminal_input":
      return typeof paneId === "string" && paneId.length > 0 && typeof frame["data"] === "string" && machineOk;
    case "terminal_resize":
      return (
        typeof paneId === "string" &&
        paneId.length > 0 &&
        typeof frame["cols"] === "number" &&
        typeof frame["rows"] === "number" &&
        Number.isFinite(frame["cols"]) &&
        Number.isFinite(frame["rows"]) &&
        machineOk
      );
    case "terminal_mouse":
      return (
        typeof paneId === "string" &&
        paneId.length > 0 &&
        (frame["action"] === "press" || frame["action"] === "motion" || frame["action"] === "release" || frame["action"] === "moved") &&
        (frame["button"] === undefined || frame["button"] === null ||
          frame["button"] === "left" || frame["button"] === "middle" || frame["button"] === "right") &&
        typeof frame["column"] === "number" &&
        typeof frame["row"] === "number" &&
        Number.isInteger(frame["column"]) &&
        Number.isInteger(frame["row"]) &&
        (frame["modifiers"] === undefined || typeof frame["modifiers"] === "number") &&
        machineOk
      );
    case "terminal_scroll":
      return (
        typeof paneId === "string" &&
        paneId.length > 0 &&
        (frame["direction"] === "up" || frame["direction"] === "down") &&
        (frame["lines"] === undefined || typeof frame["lines"] === "number") &&
        (frame["column"] === undefined || typeof frame["column"] === "number") &&
        (frame["row"] === undefined || typeof frame["row"] === "number") &&
        (frame["modifiers"] === undefined || typeof frame["modifiers"] === "number") &&
        machineOk
      );
    case "list_machines":
      return true;
    case "machine_connect":
    case "machine_disconnect":
      return typeof frame["machine"] === "string" && frame["machine"].length > 0;
    case "machine_add":
      return (
        typeof frame["id"] === "string" &&
        typeof frame["label"] === "string" &&
        typeof frame["target"] === "string" &&
        frame["target"].length > 0 &&
        frame["target"].length <= 253 &&
        !frame["target"].startsWith("-") &&
        (frame["session"] === undefined || (typeof frame["session"] === "string" && frame["session"].length <= 64))
      );
    case "machine_remove":
      return (
        typeof frame["id"] === "string" &&
        typeof frame["machine"] === "string" &&
        frame["machine"].length > 0 &&
        frame["machine"] !== "local"
      );
    case "machine_update":
      return (
        typeof frame["id"] === "string" &&
        typeof frame["machine"] === "string" &&
        frame["machine"].length > 0 &&
        frame["machine"] !== "local" &&
        (frame["label"] === undefined || (typeof frame["label"] === "string" && frame["label"].length > 0 && frame["label"].length <= 128)) &&
        (frame["enabled"] === undefined || typeof frame["enabled"] === "boolean") &&
        (frame["label"] !== undefined || frame["enabled"] !== undefined)
      );
    default:
      return false;
  }
}
