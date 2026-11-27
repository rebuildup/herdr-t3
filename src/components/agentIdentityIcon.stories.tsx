import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AgentStatus } from "../../shared/protocol";
import { AgentIdentityIcon } from "./agentIdentityIcon";

const meta = {
  title: "Agents/IdentityIcon",
  component: AgentIdentityIcon,
} satisfies Meta<typeof AgentIdentityIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

const STATUSES: AgentStatus[] = [
  "working",
  "blocked",
  "done",
  "idle",
  "unknown",
  "sleeping",
];
const AGENTS = ["claude", "codex", "gemini", "devin", "amp", null] as const;

export const Statuses: Story = {
  args: { agent: "claude", status: "working" },
  render: () => (
    <div className="flex flex-col gap-4">
      {STATUSES.map((status) => (
        <div key={status} className="flex items-center gap-3">
          <span className="w-20 text-xs text-muted-foreground">{status}</span>
          <div className="flex items-center gap-2">
            {AGENTS.map((agent) => (
              <div key={String(agent)} className="flex flex-col items-center gap-1">
                <AgentIdentityIcon agent={agent} status={status} />
                <span className="text-4xs text-muted-foreground">
                  {agent ?? "generic"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

export const ZoomedWorkingRing: Story = {
  args: { agent: "claude", status: "working" },
  render: () => (
    <div className="flex items-center gap-8">
      <AgentIdentityIcon agent="claude" status="working" className="size-16" />
      <AgentIdentityIcon agent="codex" status="working" className="size-24" />
    </div>
  ),
};

/** Mock of the sidebar agent rows the ring leads — status name kept out of the row, as in the app. */
export const SidebarAgentRows: Story = {
  args: { agent: "claude", status: "working" },
  render: () => {
    const rows: { agent: string | null; status: AgentStatus; label: string }[] = [
      { agent: "claude", status: "working", label: "refactor auth flow" },
      { agent: "codex", status: "working", label: "fix flaky test" },
      { agent: "gemini", status: "blocked", label: "awaiting input" },
      { agent: "devin", status: "done", label: "bump deps" },
      { agent: "amp", status: "idle", label: "idle session" },
      { agent: null, status: "unknown", label: "unknown harness" },
    ];
    return (
      <div className="flex w-64 flex-col gap-0.5 rounded-lg border border-sidebar-border bg-sidebar p-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground"
          >
            <AgentIdentityIcon agent={row.agent} status={row.status} />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
          </div>
        ))}
      </div>
    );
  },
};
