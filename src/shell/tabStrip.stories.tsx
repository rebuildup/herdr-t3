import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AgentStatus, TabInfo } from "../../shared/protocol";
import { TabStrip, type TabStripRpc } from "./TabStrip";

const meta = {
  title: "Shell/TabStrip",
  component: TabStrip,
} satisfies Meta<typeof TabStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

const WORKSPACE_ID = "ws-demo";

function makeTab(
  id: string,
  number: number,
  label: string,
  agentStatus: AgentStatus,
): TabInfo {
  return {
    tab_id: id,
    number,
    label,
    agent_status: agentStatus,
    focused: false,
    pane_count: 1,
    workspace_id: WORKSPACE_ID,
  };
}

const DEFAULT_TABS: TabInfo[] = [
  makeTab("tab-1", 1, "refactor auth flow", "working"),
  makeTab("tab-2", 2, "fix flaky test", "blocked"),
  makeTab("tab-3", 3, "bump deps", "done"),
  makeTab("tab-4", 4, "", "idle"),
];

const MANY_TABS: TabInfo[] = [
  ...DEFAULT_TABS,
  makeTab("tab-5", 5, "review PR #512", "working"),
  makeTab("tab-6", 6, "docs update", "idle"),
  makeTab("tab-7", 7, "migrate settings", "unknown"),
  makeTab("tab-8", 8, "investigate crash", "blocked"),
  makeTab("tab-9", 9, "release notes", "done"),
  makeTab("tab-10", 10, "scratch", "idle"),
];

/**
 * Mock bridge: applies the same state transitions herdr would push back
 * (focus/move/close/create/rename) so the real component is fully
 * interactive — drag to reorder, double-click to rename, right-click
 * for the context menu.
 */
function useTabStripMock(initial: TabInfo[]) {
  const [tabs, setTabs] = useState(initial);
  const [activeId, setActiveId] = useState(
    () => initial[0]?.tab_id ?? "",
  );
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const seq = useRef(100);

  const rpc: TabStripRpc = async (method, params = {}) => {
    switch (method) {
      case "tab.focus":
        setActiveId(String(params.tab_id));
        break;
      case "tab.move": {
        const id = String(params.tab_id);
        const insert = Number(params.insert_index);
        setTabs((current) => {
          const from = current.findIndex((t) => t.tab_id === id);
          if (from < 0) return current;
          const next = [...current];
          const [moved] = next.splice(from, 1);
          // herdr insert_index is a pre-removal insertion point.
          const at = Math.min(
            Math.max(insert > from ? insert - 1 : insert, 0),
            next.length,
          );
          next.splice(at, 0, moved!);
          return next;
        });
        break;
      }
      case "tab.close": {
        const id = String(params.tab_id);
        setTabs((current) => current.filter((t) => t.tab_id !== id));
        setActiveId((current) =>
          current === id
            ? (tabs.find((t) => t.tab_id !== id)?.tab_id ?? "")
            : current,
        );
        break;
      }
      case "tab.create": {
        seq.current += 1;
        const number = Math.max(...tabs.map((t) => t.number), 0) + 1;
        const id = `tab-new-${seq.current}`;
        setTabs((current) => [
          ...current,
          {
            tab_id: id,
            number,
            label: "",
            agent_status: "idle",
            focused: true,
            pane_count: 1,
            workspace_id: WORKSPACE_ID,
          },
        ]);
        setActiveId(id);
        break;
      }
      case "tab.rename":
        setTabs((current) =>
          current.map((t) =>
            t.tab_id === params.tab_id
              ? { ...t, label: String(params.label ?? "") }
              : t,
          ),
        );
        break;
      default:
        break;
    }
  };

  const startRename = (tab: TabInfo) => {
    setDraft(tab.label || `Tab ${tab.number}`);
    setRenamingTabId(tab.tab_id);
  };
  const commitRename = (tab: TabInfo) => {
    setRenamingTabId(null);
    const label = draft.trim();
    if (label) void rpc("tab.rename", { tab_id: tab.tab_id, label });
  };

  return {
    tabs,
    activeId,
    rpc,
    renamingTabId,
    draft,
    setDraft,
    startRename,
    commitRename,
    cancelRename: () => setRenamingTabId(null),
  };
}

function StripStage({
  tabs,
  widthClass = "w-full max-w-3xl",
}: {
  tabs: TabInfo[];
  widthClass?: string;
}) {
  const mock = useTabStripMock(tabs);
  return (
    <div className={`flex h-13 items-center gap-3 border-b border-border bg-background px-4 ${widthClass}`}>
      <span className="shrink-0 text-xs text-muted-foreground">
        my-app › auth-refactor
      </span>
      <TabStrip
        tabs={mock.tabs}
        activeTabId={mock.activeId}
        machine="local"
        workspaceId={WORKSPACE_ID}
        rpc={mock.rpc}
        renamingTabId={mock.renamingTabId}
        renameDraft={mock.draft}
        onRenameDraftChange={mock.setDraft}
        onRenameStart={mock.startRename}
        onRenameCommit={mock.commitRename}
        onRenameCancel={mock.cancelRename}
      />
    </div>
  );
}

export const Default: Story = {
  args: { tabs: DEFAULT_TABS, activeTabId: "tab-1", machine: "local", workspaceId: WORKSPACE_ID, rpc: async () => {}, renamingTabId: null, renameDraft: "", onRenameDraftChange: () => {}, onRenameStart: () => {}, onRenameCommit: () => {}, onRenameCancel: () => {} },
  render: () => <StripStage tabs={DEFAULT_TABS} />,
};

/** Narrow stage: the strip scrolls internally and the right edge fades. */
export const Overflow: Story = {
  args: Default.args,
  render: () => <StripStage tabs={MANY_TABS} widthClass="w-full max-w-xl" />,
};

/** Single tab + an unlabeled tab (renders as "Tab N"). */
export const Sparse: Story = {
  args: Default.args,
  render: () => (
    <StripStage
      tabs={[makeTab("tab-1", 1, "only tab", "working"), makeTab("tab-2", 2, "", "idle")]}
    />
  ),
};
