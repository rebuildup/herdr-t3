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

/**
 * Non-interference capability surface (contract
 * `terminal-noninterference@2` §C1–C5, issue #597 / program #233 H-NI-1).
 * These are *codec-level* declarations: the bridge protocol carries the
 * options and frames a backend (upstream herdr v23+, or the future hoxay
 * native backend) may implement. Against herdr v22 the bridge degrades to
 * the observe/promotion interim contract — the frames are additive and
 * never required for existing v22 flows.
 */

/**
 * C3 history anchor (`HistoryAnchor` in the spec): a stable position in a
 * pane's retained scrollback. `offset_from_bottom` is re-anchored by the
 * server at read time; `absolute_line` indexes the retained scrollback and
 * is stable under appends. Both are non-negative safe integers (u64 on the
 * wire; JS numbers stay exact only to 2^53).
 */
export type HistoryAnchor =
  | { kind: "offset_from_bottom"; offset: number }
  | { kind: "absolute_line"; line: number };

/** C3 row format for history pages: plain text or ANSI-styled rows. */
export type HistoryReadFormat = "text" | "ansi";

/**
 * C4 scroll scope for `terminal_scroll` / `subscribe_terminal.scrollScope`:
 * `"shared"` (default, absent) moves the pane-global scroll offset exactly
 * like herdr v22 `AttachScroll`; `"viewport"` addresses the requesting
 * client's own scroll offset (herdr `AttachScrollViewport`, per-client
 * independence) and must only be sent when the machine advertised
 * `terminal.per_client_scroll`.
 */
export type TerminalScrollScope = "shared" | "viewport";

/**
 * C2b observe-with-input-grant (`ObserveTerminalGrant` in the spec):
 * per-connection grant of input message classes on an observe-mode attach.
 * Absent fields are not granted; an object with every field `false` (or
 * absent) revokes the grant. Granted scroll without per-client scroll
 * (C4) still moves the shared viewport — documented spec interaction.
 */
export interface TerminalInputGrant {
  keys?: boolean;
  mouse?: boolean;
  scroll?: boolean;
}

/**
 * C3 initial history page requested via `subscribe_terminal.history`:
 * after the attach stream opens the bridge answers with a
 * `terminal_history_page` frame (same shape as a `terminal_history`
 * request with `paneId` implied by the subscription). `anchor` absent
 * means the pane bottom; `rows`/`format` fall back to bridge defaults.
 */
export interface TerminalHistoryOptions {
  anchor?: HistoryAnchor;
  rows?: number;
  format?: HistoryReadFormat;
}

/**
 * Capability ids a bridge session may advertise on `ready.capabilities`
 * for the non-interference set (spec C5.8 — "advertised, not implied": a
 * client must never send a gated field or frame to a machine that did not
 * advertise the matching capability). Strings are stable contract ids.
 */
export const TERMINAL_NONINTERFERENCE_CAPABILITIES = {
  /** C1: writable attach without resize authority (herdr AttachTerminalSharedSize). */
  sharedSizeAttach: "terminal.shared_size_attach",
  /** C2: live mode negotiation / observe-with-input-grant. */
  inputGrant: "terminal.input_grant",
  modeNegotiation: "terminal.mode_negotiation",
  /** C3: AttachHistoryRead / TerminalHistoryPage demand-driven paging. */
  historyPaging: "terminal.history_paging",
  /** C4: AttachScrollViewport per-client scroll independence. */
  perClientScroll: "terminal.per_client_scroll",
} as const;

export type TerminalNoninterferenceCapability =
  (typeof TERMINAL_NONINTERFERENCE_CAPABILITIES)[keyof typeof TERMINAL_NONINTERFERENCE_CAPABILITIES];

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
  | {
      type: "subscribe_terminal";
      paneId: string;
      cols?: number;
      rows?: number;
      machine?: string;
      takeover?: boolean;
      /**
       * Attach mode (issue #571): `true`/absent = writable AttachTerminal
       * (resize authority + input); `false` = read-only ObserveTerminal
       * stream that does not touch pane size, focus or scroll ownership.
       * Re-sending subscribe_terminal for a live paneId with a different
       * `writable` negotiates the mode on the existing slot — the bridge
       * re-attaches the link without dropping queued ops — while a repeat
       * with the same `writable` counts as an ordinary extra reference.
       */
      writable?: boolean;
      /**
       * C1 (issue #597): `false` requests writable attach *without* resize
       * authority — the herdr `AttachTerminalSharedSize` shape: input,
       * mouse, scroll and detach route normally but the attach never calls
       * `runtime.resize` and never takes `direct_attach_resize_locks`; the
       * pane keeps its layout-owned size and the client renders the pane
       * grid mapped into its announced cols/rows (observe-style mapping).
       * Only meaningful with `writable` not `false`; ignored/absent keeps
       * current behavior (manageSize = true). Must only be sent when the
       * machine advertised `terminal.shared_size_attach`; on herdr v22 the
       * bridge falls back to the observe/promotion interim.
       */
      manageSize?: boolean;
      /**
       * C2b (issue #597): observe-with-input-grant. Grants the named input
       * classes on an observe-mode (`writable: false`) attach without
       * taking resize authority or a takeover. Revoked by re-sending with
       * all-false or by mode negotiation. Gated on the machine's
       * `terminal.input_grant` capability.
       */
      inputGrant?: TerminalInputGrant;
      /**
       * C4 (issue #597): default scroll scope for this subscription's
       * `terminal_scroll` frames. `"viewport"` selects per-client scroll
       * (herdr `AttachScrollViewport`); absent/`"shared"` keeps the
       * pane-global offset. Gated on `terminal.per_client_scroll`.
       */
      scrollScope?: TerminalScrollScope;
      /**
       * C3 (issue #597): request an initial scrollback page for this pane;
       * the bridge answers with `terminal_history_page`. Read-only — never
       * moves the scroll viewport. Gated on `terminal.history_paging`.
       */
      history?: TerminalHistoryOptions;
    }
  | { type: "unsubscribe_terminal"; paneId: string; machine?: string }
  /**
   * C3 (issue #597, herdr `AttachHistoryRead`): read-only scrollback page
   * request. Never mutates scroll offset, resize locks, focus or any
   * client-visible state; safe on observe and writable attaches. The
   * bridge answers with `terminal_history_page`. `anchor` is required;
   * `rows` is server-capped and oversized requests get an explicit
   * `rpc_result`-style error, not truncation. Gated on the machine's
   * `terminal.history_paging` capability.
   */
  | {
      type: "terminal_history";
      paneId: string;
      machine?: string;
      anchor: HistoryAnchor;
      rows?: number;
      format?: HistoryReadFormat;
    }
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
      /**
       * C4 (issue #597): per-message scroll scope override. Absent uses the
       * subscription's `scrollScope`; `"viewport"` moves only this client's
       * scroll offset (herdr `AttachScrollViewport`) and never the
       * pane-global one. Gated on `terminal.per_client_scroll`.
       */
      scope?: TerminalScrollScope;
    }
  | { type: "list_machines" }
  | { type: "machine_connect"; machine: string }
  | { type: "machine_disconnect"; machine: string }
  /**
   * Declares which machine's session detail the client is viewing
   * (issue #585, program #568). The named machine's bridge session runs
   * in full detail mode — canvas layouts, pane scroll state and terminal
   * attach eligibility; every other connected machine drops to summary
   * mode: structure + agent status only, stripped snapshot payload, no
   * terminal delivery. Idempotent; selecting a machine also connects it.
   */
  | { type: "machine_select"; machine: string }
  | { type: "machine_add"; id: string; label: string; target: string; session?: string }
  /** `id` correlates the rpc_result; `machine` is herdr's saved-machine profile id. */
  | { type: "machine_remove"; id: string; machine: string }
  | { type: "machine_update"; id: string; machine: string; label?: string; enabled?: boolean }
  /**
   * Installed-plugin discovery on one host (ADR-0011): runs
   * `herdr plugin list --json` on the machine's own host and answers on
   * `rpc_result` with `{ plugins: PluginListEntry[] }`.
   */
  | { type: "plugin_list"; id: string; machine?: string }
  /**
   * One plugin contract command on one host (ADR-0011): resolves the
   * installed plugin, verifies its `capability`, then runs
   * `<plugin_root>/src/cli.ts <command> [args]` as argv — never through
   * a forwarded socket and never by reading plugin state files.
   * `args` are argv elements; the bridge adds no shell interpolation.
   * `stdin` is written to the child's stdin and closed immediately —
   * contracts that read a payload from stdin (e.g. textgen-v1 `generate`)
   * need it because `--input FILE` has no remote write channel; it is
   * bounded and never logged.
   */
  | {
      type: "plugin_call";
      id: string;
      machine?: string;
      plugin: string;
      command: string;
      args?: string[];
      stdin?: string;
      timeout_ms?: number;
    };

/** Server -> client WebSocket frames. `machine` tags endpoint-scoped data. */
export type ServerFrame =
  | {
      type: "ready";
      snapshot: SessionSnapshot;
      machine: string;
      detail?: "summary";
      /**
       * C5 (issue #597): non-interference capability ids this machine's
       * backend advertises (see TERMINAL_NONINTERFERENCE_CAPABILITIES).
       * Absent means none advertised — clients must treat every gated
       * subscribe_terminal field and `terminal_history` as unsupported.
       * Additive: older servers never send it.
       */
      capabilities?: string[];
    }
  /**
   * `probe: true` marks a snapshot fetched by the reachability probe for a
   * machine with no live bridge session (issue #212): real session data,
   * but up to the probe interval old and not backed by a subscription.
   * Clients may display it but must not treat it as a live session.
   * `detail: "summary"` marks a snapshot pushed by a session in summary
   * mode (issue #585): structure + agent status for the sidebar, with
   * canvas detail (layouts, pane scroll state) stripped. Absent means a
   * full-detail snapshot.
   */
  | { type: "snapshot"; snapshot: SessionSnapshot; machine: string; probe?: boolean; detail?: "summary" }
  | { type: "event"; event: unknown; machine: string }
  | {
      type: "rpc_result";
      id: string;
      ok: boolean;
      result?: unknown;
      /**
       * `fields` carries bounded structured extras from a plugin contract
       * error (issue #257): the plugin's own non-secret `error.*` siblings
       * (`repos`, `key`, `run_id`, …), already size-capped server-side.
       * Additive — older servers never send it and older clients ignore it.
       */
      error?: { code: string; message: string; fields?: PluginErrorFields };
      machine?: string;
    }
  /** `data` is base64: terminal output is arbitrary bytes, not necessarily UTF-8. */
  | { type: "terminal_data"; paneId: string; data: string; machine: string }
  /**
   * herdr `ServerMessage::MouseCapture` for the attached pane (issue #169):
   * the pane's program currently requests mouse reporting. A selection-vs-
   * report hint only — the server still gates every AttachMouse/AttachScroll
   * report against the pane's modes. Absent on herdr < 0.9.0.
   */
  | { type: "terminal_mouse_capture"; paneId: string; enabled: boolean; machine: string }
  | { type: "terminal_closed"; paneId: string; reason?: string; machine: string }
  /**
   * C3 (issue #597, herdr `TerminalHistoryPage`): answer to a
   * `terminal_history` request (or a `subscribe_terminal.history` initial
   * page). Read-only — answering never moved any scroll viewport.
   * `anchor` is the request anchor echoed back *clamped*; `contentRevision`
   * lets the client detect drift under appends and re-anchor.
   * `nextAnchor` is the stable forward cursor for paging without
   * recomputing. `rows` holds one entry per row in the requested `format`
   * (plain text or ANSI row text — UTF-8, never split mid-grapheme).
   * `hasMoreAbove`/`hasMoreBelow` are `false` at the retention boundary,
   * never an error.
   */
  | {
      type: "terminal_history_page";
      paneId: string;
      machine: string;
      terminalId?: string;
      contentRevision: number;
      anchor: HistoryAnchor;
      rows: string[];
      hasMoreAbove: boolean;
      hasMoreBelow: boolean;
      nextAnchor: HistoryAnchor;
    }
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
  "pane.send_input",
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

/**
 * RPC methods that cannot mutate session state (issue #423). A successful
 * call to one of these never schedules a snapshot refetch; every other
 * method keeps the post-RPC refresh as a belt-and-suspenders for mutations
 * herdr does not emit events for. `session.snapshot` is the fetch itself —
 * refreshing after it would amplify read traffic into more fetches.
 * Unknown/future methods default to refreshing (conservative).
 */
export const READ_ONLY_RPC_METHODS = [
  "session.snapshot",
  "agent.get",
  "agent.read",
  "agent.explain",
  "pane.process_info",
  "pane.link.resolve",
  "worktree.list",
] as const;

export function isReadOnlyRpcMethod(method: string): boolean {
  return (READ_ONLY_RPC_METHODS as readonly string[]).includes(method);
}

/* ------------------------------------------------------------------ */
/* Plugin contract boundary types (ADR-0011)                            */
/* ------------------------------------------------------------------ */

/** One entry of a `plugin_list` result — the fields herdr-t3 consumes. */
export interface PluginListEntry {
  plugin_id: string;
  name: string;
  version: string;
  enabled: boolean;
  plugin_root: string;
  description?: string;
  /**
   * Lowest herdr version the plugin supports (`plugin_list`'s
   * `min_herdr_version`, e.g. "0.9.0"). Absent on hosts/plugins that do
   * not report it — never fabricated.
   */
  min_herdr_version?: string;
  /** OS ids the plugin supports (`plugin_list`'s `platforms`). */
  platforms?: string[];
}

export interface PluginListResult {
  plugins: PluginListEntry[];
}

/**
 * Compare two dotted-numeric versions ("0.9.5" vs "0.9.0"). Parses the
 * leading `v?\d+(\.\d+)*` prefix and pads missing components with 0, so
 * "0.9" equals "0.9.0". Returns null when either side has no numeric
 * version prefix — callers must treat null as "unknown", never as equal.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const match = /^\s*v?(\d+(?:\.\d+)*)/.exec(v);
    const digits = match?.[1];
    if (digits === undefined) return null;
    return digits.split(".").map((part) => Number.parseInt(part, 10));
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * ADR-0011 §10 version-skew check for one `plugin_list` entry against the
 * machine's reported herdr version. Returns a display-ready detail string
 * only when the host herdr is *definitively* older than the plugin's
 * `min_herdr_version`; null when compatible or when either version is
 * unknown — missing data never blocks a surface.
 */
export function pluginHerdrSkew(
  entry: Pick<PluginListEntry, "min_herdr_version">,
  hostVersion: string | undefined,
): string | null {
  const min = entry.min_herdr_version;
  if (typeof min !== "string" || min.length === 0 || hostVersion === undefined) {
    return null;
  }
  const cmp = compareVersions(hostVersion, min);
  if (cmp === null || cmp >= 0) return null;
  return `requires herdr >= ${min} (host reports ${hostVersion})`;
}

/**
 * `plugin_call` success payload: the plugin CLI's single JSON document
 * from stdout, passed through verbatim (contract `ok`/`error` fields
 * inside it are the plugin's own). Transport/contract failures come back
 * as `rpc_result` errors instead.
 */
export type PluginCallResult = Record<string, unknown>;

/**
 * Structured extras a plugin contract error may carry across the bridge
 * (issue #257). Upstream contracts document these as non-secret; the
 * server still bounds count, key length and value size before sending.
 */
export type PluginErrorFields = Record<string, unknown>;

export function isRpcMethod(method: string): method is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(method);
}

/* ---- non-interference frame helpers (issue #597, C1–C5) ---- */

/**
 * Anchor/rows magnitudes are u64 on the wire; JS numbers stay exact only
 * to 2^53-1, so the guard admits non-negative safe integers only — the
 * same set the Rust codec's `u64` fields can represent losslessly.
 */
function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isHistoryAnchorValue(v: unknown): v is HistoryAnchor {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const anchor = v as Record<string, unknown>;
  if (anchor["kind"] === "offset_from_bottom") return isNonNegSafeInt(anchor["offset"]);
  if (anchor["kind"] === "absolute_line") return isNonNegSafeInt(anchor["line"]);
  return false;
}

function isHistoryReadFormatValue(v: unknown): v is HistoryReadFormat {
  return v === "text" || v === "ansi";
}

function isInputGrantValue(v: unknown): v is TerminalInputGrant {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const grant = v as Record<string, unknown>;
  return (
    (grant["keys"] === undefined || typeof grant["keys"] === "boolean") &&
    (grant["mouse"] === undefined || typeof grant["mouse"] === "boolean") &&
    (grant["scroll"] === undefined || typeof grant["scroll"] === "boolean")
  );
}

function isScrollScopeValue(v: unknown): v is TerminalScrollScope {
  return v === "shared" || v === "viewport";
}

function isHistoryOptionsValue(v: unknown): v is TerminalHistoryOptions {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const history = v as Record<string, unknown>;
  return (
    (history["anchor"] === undefined || isHistoryAnchorValue(history["anchor"])) &&
    (history["rows"] === undefined || isNonNegSafeInt(history["rows"])) &&
    (history["format"] === undefined || isHistoryReadFormatValue(history["format"]))
  );
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
        (frame["takeover"] === undefined || typeof frame["takeover"] === "boolean") &&
        (frame["writable"] === undefined || typeof frame["writable"] === "boolean") &&
        // C1/C2b/C3/C4 (issue #597): additive non-interference options.
        (frame["manageSize"] === undefined || typeof frame["manageSize"] === "boolean") &&
        (frame["inputGrant"] === undefined || isInputGrantValue(frame["inputGrant"])) &&
        (frame["scrollScope"] === undefined || isScrollScopeValue(frame["scrollScope"])) &&
        (frame["history"] === undefined || isHistoryOptionsValue(frame["history"]))
      );
    case "terminal_history":
      return (
        typeof paneId === "string" &&
        paneId.length > 0 &&
        machineOk &&
        isHistoryAnchorValue(frame["anchor"]) &&
        (frame["rows"] === undefined || isNonNegSafeInt(frame["rows"])) &&
        (frame["format"] === undefined || isHistoryReadFormatValue(frame["format"]))
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
        // C4 (issue #597): per-client viewport scroll scope.
        (frame["scope"] === undefined || isScrollScopeValue(frame["scope"])) &&
        machineOk
      );
    case "list_machines":
      return true;
    case "machine_connect":
    case "machine_disconnect":
    case "machine_select":
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
    case "plugin_list":
      return typeof frame["id"] === "string" && machineOk;
    case "plugin_call":
      return (
        typeof frame["id"] === "string" &&
        machineOk &&
        typeof frame["plugin"] === "string" &&
        frame["plugin"].length > 0 &&
        frame["plugin"].length <= 128 &&
        typeof frame["command"] === "string" &&
        frame["command"].length > 0 &&
        frame["command"].length <= 64 &&
        (frame["args"] === undefined ||
          (Array.isArray(frame["args"]) &&
            frame["args"].length <= 32 &&
            frame["args"].every(
              (a) => typeof a === "string" && a.length <= 4096 && !a.includes("\0"),
            ))) &&
        (frame["stdin"] === undefined ||
          (typeof frame["stdin"] === "string" && frame["stdin"].length <= 262144)) &&
        (frame["timeout_ms"] === undefined ||
          (typeof frame["timeout_ms"] === "number" &&
            Number.isInteger(frame["timeout_ms"]) &&
            frame["timeout_ms"] >= 500 &&
            frame["timeout_ms"] <= 600_000))
      );
    default:
      return false;
  }
}
