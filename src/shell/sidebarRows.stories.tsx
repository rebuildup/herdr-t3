/*
 * Real sidebar rows (issue #550): AgentRow / WorkspaceRow extracted from
 * WorkspaceSidebar so the actual components — identity glyph, two-line
 * hierarchy, hover card, context menu hooks — are Storybook-reviewable.
 * AgentShelves composes the same CollapsibleSectionHeader the sidebar
 * uses for the Working / Attention / Settled / Snoozed shelves.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentInfo, MachineInfo, PaneInfo, WorkspaceInfo } from "../../shared/protocol";
import type { AgentListEntry } from "./agents";
import { AgentRow, type AgentOrganizeAction } from "./AgentRow";
import { WorkspaceRow } from "./WorkspaceRow";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { TooltipProvider } from "~/components/ui/tooltip";

const machine: MachineInfo = {
  id: "local",
  label: "mbp",
  kind: "local",
  enabled: true,
  status: "online",
};

function workspace(id: string, label: string, status: WorkspaceInfo["agent_status"], overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    active_tab_id: `${id}-t1`,
    agent_status: status,
    focused: false,
    label,
    number: 1,
    pane_count: 2,
    tab_count: 1,
    workspace_id: id,
    ...overrides,
  };
}

function agent(paneId: string, status: AgentInfo["agent_status"], overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    agent: "claude",
    agent_status: status,
    focused: false,
    pane_id: paneId,
    revision: 1,
    tab_id: `${paneId}-t`,
    terminal_id: paneId,
    title: "refactor auth flow",
    workspace_id: "w1",
    ...overrides,
  };
}

function pane(paneId: string, overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    agent_status: "working",
    focused: false,
    pane_id: paneId,
    revision: 1,
    tab_id: `${paneId}-t`,
    terminal_id: paneId,
    workspace_id: "w1",
    ...overrides,
  };
}

function entry(
  id: string,
  status: AgentInfo["agent_status"],
  overrides: { agent?: Partial<AgentInfo>; pane?: Partial<PaneInfo> | null; wsTitle?: string; tabLabel?: string | null; focused?: boolean } = {},
): AgentListEntry {
  const { agent: agentOverrides, pane: paneOverrides, ...rest } = overrides;
  return {
    machine,
    agent: agent(id, status, { ...agentOverrides, focused: overrides.focused ?? false }),
    workspace: workspace("w1", "my-app", "working"),
    pane: paneOverrides === null ? undefined : pane(id, paneOverrides),
    workspaceTitle: overrides.wsTitle ?? "my-app",
    tabLabel: overrides.tabLabel ?? null,
  };
}

const noop = () => {};
const organize = (_e: AgentListEntry, _a: AgentOrganizeAction, _s?: string) => {};

function RowList({ children }: { children: React.ReactNode }) {
  return <div className="w-72 space-y-0.5 rounded-lg border border-sidebar-border bg-sidebar p-2">{children}</div>;
}

function AgentRowEl({ e, shelf }: { e: AgentListEntry; shelf?: "settled" | "snoozed" }) {
  return (
    <AgentRow
      entry={e}
      multiMachine={false}
      showPaneId={false}
      pane={e.pane}
      shelf={shelf}
      inboxReady
      onDetails={noop}
      onOrganize={organize}
    />
  );
}

const meta: Meta = {
  title: "Shell/SidebarRows",
  decorators: [(Story) => <TooltipProvider><Story /></TooltipProvider>],
};
export default meta;
type Story = StoryObj;

/** Workspace rows across aggregate statuses. */
export const WorkspaceRows: Story = {
  render: () => (
    <RowList>
      <WorkspaceRow machine={machine} workspace={workspace("w1", "my-app", "working", { focused: true })} isActive onNewWorkspace={noop} onRename={noop} onClose={noop} />
      <WorkspaceRow machine={machine} workspace={workspace("w2", "api-service", "done", { tab_count: 3, pane_count: 5 })} isActive={false} onNewWorkspace={noop} onRename={noop} onClose={noop} />
      <WorkspaceRow machine={machine} workspace={workspace("w3", "docs-site", "blocked")} isActive={false} onNewWorkspace={noop} onRename={noop} onClose={noop} />
      <WorkspaceRow machine={machine} workspace={workspace("w4", "scratch", "idle")} isActive={false} onNewWorkspace={noop} onRename={noop} onClose={noop} />
    </RowList>
  ),
};

/** Agent rows across every status; hover a row to see glyph + hover card. */
export const AgentRows: Story = {
  render: () => (
    <RowList>
      <AgentRowEl e={entry("w1:p1", "working", { focused: true, pane: { terminal_title_stripped: "bun test src/" } })} />
      <AgentRowEl e={entry("w1:p2", "blocked", { agent: { agent: "codex" }, pane: { terminal_title_stripped: "waiting for approval" } })} />
      <AgentRowEl e={entry("w1:p3", "done", { agent: { agent: "gemini" }, pane: { terminal_title_stripped: "PR #512 merged" } })} />
      <AgentRowEl e={entry("w1:p4", "idle", { pane: null })} />
      <AgentRowEl e={entry("w1:p5", "unknown", { agent: { agent: "opencode" }, pane: null })} />
    </RowList>
  ),
};

/**
 * The real shelf composition: collapsible section headers (Attention /
 * Working) with agent rows beneath — the "collapsed status shelf" shape.
 */
export const AgentShelves: Story = {
  render: () => (
    <div className="w-72 space-y-0.5 rounded-lg border border-sidebar-border bg-sidebar p-2">
      <CollapsibleSectionHeader expanded tone="warning" chevron="leading" accessory={<span className="text-2xs tabular-nums text-sidebar-muted-foreground">2</span>}>
        Attention
      </CollapsibleSectionHeader>
      <AgentRowEl e={entry("w1:p2", "blocked", { agent: { agent: "codex" }, pane: { terminal_title_stripped: "waiting for approval" } })} />
      <AgentRowEl e={entry("w2:p1", "done", { agent: { agent: "gemini" }, wsTitle: "api-service", pane: { terminal_title_stripped: "PR #512 merged" } })} />
      <CollapsibleSectionHeader expanded tone="accent" chevron="leading" accessory={<span className="text-2xs tabular-nums text-sidebar-muted-foreground">3</span>}>
        Working
      </CollapsibleSectionHeader>
      <AgentRowEl e={entry("w1:p1", "working", { focused: true, pane: { terminal_title_stripped: "bun test src/" } })} />
      <AgentRowEl e={entry("w3:p1", "working", { agent: { agent: "opencode", title: "migrate store" }, wsTitle: "docs-site", pane: { terminal_title_stripped: "vitest watch" } })} />
      <AgentRowEl e={entry("w3:p2", "idle", { wsTitle: "docs-site", pane: null })} />
      <CollapsibleSectionHeader expanded={false} chevron="leading" accessory={<span className="text-2xs tabular-nums text-sidebar-muted-foreground">1</span>}>
        Settled
      </CollapsibleSectionHeader>
    </div>
  ),
};

/**
 * Long-content stress (issue #550): unbroken tokens, CJK strings and
 * max-length fields must truncate inside the row — never overflow the
 * sidebar width or push the meta/aux columns out. The guarantee is
 * structural: `min-w-0` on every flex child, `truncate` on each text
 * run, `max-w-*` caps on the trailing meta spans.
 */
export const LongText: Story = {
  render: () => (
    <RowList>
      <AgentRowEl e={entry("w1:p9", "working", {
        focused: true,
        agent: { title: "refactor the authentication and authorization middleware pipeline end-to-end" },
        pane: { terminal_title_stripped: "bunx vitest run --reporter=verbose src/auth/session-refresh.test.ts --no-color" },
        wsTitle: "extremely-long-workspace-name-that-keeps-going-and-going",
        tabLabel: "feature/very-long-branch-name-for-stress-testing",
      })} />
      <AgentRowEl e={entry("w1:p10", "blocked", {
        agent: { agent: "codex", title: "待機中：承認が必要な破壊的マイグレーション手順" },
        pane: null,
        wsTitle: "my-app",
      })} />
      <WorkspaceRow
        machine={machine}
        workspace={workspace("w9", "a-very-long-workspace-title-that-should-truncate-instead-of-overflowing-the-sidebar", "done", { tab_count: 12, pane_count: 34 })}
        isActive={false}
        onNewWorkspace={noop}
        onRename={noop}
        onClose={noop}
      />
    </RowList>
  ),
};
