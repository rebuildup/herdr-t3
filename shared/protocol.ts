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
  };
}

export interface SessionResponse {
  snapshot: SessionSnapshot;
}

/** Client -> server WebSocket frames. */
export type ClientFrame =
  | { type: "rpc"; id: string; method: RpcMethod; params: Record<string, unknown> }
  | { type: "subscribe_terminal"; paneId: string }
  | { type: "unsubscribe_terminal"; paneId: string }
  | { type: "terminal_input"; paneId: string; data: string }
  | { type: "terminal_resize"; paneId: string; cols: number; rows: number };

/** Server -> client WebSocket frames. */
export type ServerFrame =
  | { type: "ready"; snapshot: SessionSnapshot }
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "event"; event: unknown }
  | { type: "rpc_result"; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { type: "terminal_data"; paneId: string; data: string }
  | { type: "terminal_closed"; paneId: string; reason?: string };

/**
 * The herdr RPC methods the bridge exposes to the client. Anything not
 * listed is refused; the bridge is a gatekeeper, not a proxy.
 */
export const RPC_METHODS = [
  "session.snapshot",
  "workspace.create",
  "workspace.close",
  "workspace.rename",
  "workspace.move",
  "tab.create",
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
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export function isRpcMethod(method: string): method is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(method);
}
