/*
 * Sidebar agent row — extracted from WorkspaceSidebar (issue #550) so
 * the real component, its hover card and context menu are
 * Storybook-reviewable. Left edge is the unified AgentIdentityIcon;
 * organize mutations stay plugin-backed via the onOrganize callback.
 */
import {
  CheckCheckIcon,
  CopyIcon,
  InfoIcon,
  MoonIcon,
  MousePointerClickIcon,
  RotateCcwIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { requestFocusHandoff } from "~/lib/focusHandoff";
import { isAgentKindName } from "~/components/agentKind";
import { AgentIdentityIcon } from "~/components/agentIdentityIcon";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { AgentHoverCard } from "./AgentHoverCard";
import {
  agentAuxStateLabels,
  agentDisplayName,
  agentStateLabel,
  agentWorkTarget,
  shortPaneId,
  type AgentListEntry,
} from "./agents";
import type { InboxUnavailableReason } from "./inbox";
import { callRpc, ensureMachine, selectWorkspace } from "./bridge";
import type { PaneInfo } from "../../shared/protocol";

export type AgentOrganizeAction = "settle" | "snooze" | "restore";

/** Why organize actions are unavailable on a machine (ADR-0011 §10). */
const INBOX_UNAVAILABLE_LABELS: Record<InboxUnavailableReason, string> = {
  not_installed: "inbox plugin not installed",
  disabled: "inbox plugin disabled",
  incompatible: "inbox contract incompatible",
  unreachable: "inbox host unreachable",
  error: "inbox unavailable",
};

/** Snooze presets offered by the plugin contract (`--until` specs). */
const SNOOZE_PRESETS = [
  { label: "1 hour", spec: "+1h" },
  { label: "1 day", spec: "+1d" },
  { label: "1 week", spec: "+7d" },
] as const;

function formatSnoozeUntil(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * One agent row in the Agents shelves. Two lines matching
 * WorkspaceRow's grammar (issue #550 review): line 1 leads with the
 * work target — the live pane's terminal title — behind the unified
 * identity glyph; line 2 is muted meta (workspace/tab/machine context,
 * agent identity, pane disambiguator, auxiliary labels). The resolved
 * state name is icon/section/hover-card/aria only, never printed text
 * (issue #381).
 * Clicking jumps to the agent's workspace and focuses its pane
 * (`pane.focus` resolves across tabs and workspaces in herdr), mirroring
 * the TUI agent sidebar's click-to-focus.
 */
export function AgentRow({
  entry,
  multiMachine,
  showPaneId,
  pane,
  shelf,
  inboxReady,
  inboxReason,
  snoozedUntil,
  onDetails,
  onOrganize,
}: {
  entry: AgentListEntry;
  multiMachine: boolean;
  /** Sibling rows render identically without it — append the pane token (issue #165). */
  showPaneId: boolean;
  pane: PaneInfo | undefined;
  /** User-organize shelf the row currently sits in, if any (#173/#219). */
  shelf: "settled" | "snoozed" | undefined;
  /** Whether the host's inbox plugin can accept organize mutations. */
  inboxReady: boolean;
  inboxReason?: InboxUnavailableReason | undefined;
  /** Plugin-reported snooze deadline (snoozed rows only). */
  snoozedUntil?: string | undefined;
  onDetails: (entry: AgentListEntry, pane: PaneInfo) => void;
  onOrganize: (entry: AgentListEntry, action: AgentOrganizeAction, snoozeSpec?: string) => void;
}) {
  const { machine, agent } = entry;
  const stateLabel = agentStateLabel(agent);
  const displayName = agentDisplayName(agent);
  const workTarget = agentWorkTarget(agent, pane);
  const auxLabels = agentAuxStateLabels(agent);
  // Line 2 leads with the work target; the agent name joins the meta
  // only when it adds information beyond the title.
  const rowTitle = workTarget ?? displayName;
  // When the display name is just the agent kind (any spelling of it),
  // the trailing icon already carries that identity — repeating the
  // label as meta is noise, so drop it and give the title back the
  // width (issue #204 review, generalized in #335: independent of which
  // icon family renders, including the generic glyph and unknown kinds).
  const nameIsAgentKind = isAgentKindName(displayName, agent.agent);
  const metaParts = [
    workTarget !== null && workTarget !== displayName && !nameIsAgentKind
      ? displayName
      : null,
    showPaneId ? shortPaneId(agent.pane_id) : null,
    shelf === "snoozed" && snoozedUntil
      ? (() => {
          const until = formatSnoozeUntil(snoozedUntil);
          return until ? `until ${until}` : null;
        })()
      : null,
  ].filter((part): part is string => part !== null);
  // Line 1 keeps the where-the-agent-lives context (workspace · tab ·
  // machine); line 2 carries the work target plus identity/
  // disambiguation meta. The identity glyph is centered against the
  // whole two-line block (issue #550 review), not assigned to one line.
  const contextLine = [
    entry.workspaceTitle,
    entry.tabLabel,
    multiMachine ? machine.label : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const focusAgent = () => {
    requestFocusHandoff({
      machine: machine.id,
      workspaceId: agent.workspace_id,
    });
    selectWorkspace(machine.id, agent.workspace_id);
    void ensureMachine(machine.id).then(() =>
      callRpc(machine.id, "pane.focus", { pane_id: agent.pane_id }).catch(() => {}),
    );
  };
  const rowButton = (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row inside a composite list, same exception as workspace rows
    <button
      type="button"
      data-sidebar-row={agent.pane_id}
      onClick={focusAgent}
      className={cn(
        // `group/agent` lets the identity glyph react to row hover
        // (index.css `.group\/agent:hover .agent-identity`).
        "group/agent flex w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) py-1.5 text-left outline-none transition-colors",
        !agent.focused && "hover:bg-sidebar-row-hover",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        agent.focused &&
          "bg-sidebar-row-active font-medium text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70",
      )}
    >
      {/* Issue #550 review: the row is a flex pair — the identity glyph
          on the left, vertically centered against the whole two-line
          content block (context line + work-target line), so the icon
          reads as belonging to the row's content as a unit rather than
          to either line alone. The resolved state name stays
          icon-adjacent only via hover card / shelf / aria, never
          printed text (issue #381). */}
      {/* The unified identity/status glyph — brand provider mark led,
          agent_status carried by the perimeter ring plus a marker where
          the state asks for attention (working = rotating arc, blocked
          = centered red "!" disc, done/unknown = corner badge,
          idle = ring only). */}
      <AgentIdentityIcon agent={agent.agent} status={agent.agent_status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-2xs text-sidebar-muted-foreground leading-tight">
          {contextLine}
        </span>
        <span className="flex min-w-0 items-center gap-2 leading-tight">
          {/* Title and meta are separate flex items (issue #204 review):
              concatenating them inside one truncating node sliced mid-
              separator ("update onboarding docs ...") and dropped the
              agent name entirely on long titles. The title truncates;
              the meta keeps its own bounded width. */}
          <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
            {rowTitle}
          </span>
          {metaParts.length > 0 ? (
            // T3 SidebarThreadRow meta line: text-secondary-label text-xs —
            // text-2xs read as low-contrast gray on Windows light theme
            // (issue #417 Windows leg).
            <span className="max-w-40 shrink-0 truncate text-xs text-secondary-label">
              {metaParts.join(" · ")}
            </span>
          ) : null}
          {auxLabels.length > 0 ? (
            <span className="max-w-32 shrink-0 truncate text-xs text-secondary-label">
              {auxLabels.join(" · ")}
            </span>
          ) : null}
        </span>
      </span>
      <span className="sr-only">{stateLabel}</span>
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="w-full">
        {/* T3 ThreadHoverCard: hover/focus shows the facts the two-line row
            truncates (issue #154). The tooltip trigger renders the row
            button itself so there is no nested interactive element. */}
        <Tooltip>
          <TooltipTrigger render={rowButton} />
          <TooltipPopup
            side="right"
            align="start"
            sideOffset={16}
            variant="glass"
            className="text-left"
          >
            <AgentHoverCard entry={entry} multiMachine={multiMachine} pane={pane} />
          </TooltipPopup>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={focusAgent}>
          <MousePointerClickIcon /> Focus
        </ContextMenuItem>
        {pane ? (
          <ContextMenuItem onSelect={() => onDetails(entry, pane)}>
            <InfoIcon /> Details…
          </ContextMenuItem>
        ) : null}
        {/* User-side shelf organization (#173, plugin-backed per ADR-0011):
            herdr state is untouched; the host's rebuildup.inbox plugin owns
            organize state. Shelved rows can be restored or moved to the
            other shelf; natural-section rows offer Settle/Snooze. T3 keeps
            snoozed threads reachable for manual unsnooze — the Snoozed
            shelf mirrors that. When the host has no usable inbox plugin the
            actions are disabled with the reason, never silently local. */}
        <ContextMenuSeparator />
        {!inboxReady ? (
          <ContextMenuItem disabled>
            {INBOX_UNAVAILABLE_LABELS[inboxReason ?? "error"]}
          </ContextMenuItem>
        ) : (
          <>
            {shelf === "settled" || shelf === "snoozed" ? (
              <ContextMenuItem onSelect={() => onOrganize(entry, "restore")}>
                <RotateCcwIcon /> Restore
              </ContextMenuItem>
            ) : null}
            {shelf !== "snoozed" ? (
              <ContextMenuItem onSelect={() => onOrganize(entry, "settle")}>
                <CheckCheckIcon /> Settle
              </ContextMenuItem>
            ) : null}
            {shelf !== "settled" ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <MoonIcon /> Snooze
                </ContextMenuSubTrigger>
                <ContextMenuSubPopup>
                  {SNOOZE_PRESETS.map((preset) => (
                    <ContextMenuItem
                      key={preset.spec}
                      onSelect={() => onOrganize(entry, "snooze", preset.spec)}
                    >
                      {preset.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubPopup>
              </ContextMenuSub>
            ) : null}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(agent.pane_id)}
        >
          <CopyIcon /> Copy pane ID
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(agent.workspace_id)}
        >
          <CopyIcon /> Copy workspace ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
