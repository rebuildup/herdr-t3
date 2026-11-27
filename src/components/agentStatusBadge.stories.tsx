import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AgentStatus } from "../../shared/protocol";
import { AgentStatusBadge } from "./AgentStatusBadge";

const meta = {
  title: "Agents/StatusBadge",
  component: AgentStatusBadge,
} satisfies Meta<typeof AgentStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

const STATUSES: AgentStatus[] = [
  "working",
  "blocked",
  "done",
  "idle",
  "unknown",
];

/** Label + unified glyph (AgentIdentityIcon, `sm` density) per status. */
export const Statuses: Story = {
  args: { status: "working", agent: "claude" },
  render: () => (
    <div className="flex flex-col items-start gap-3">
      {STATUSES.map((status) => (
        <div key={status} className="flex items-center gap-6">
          <span className="w-24 text-xs text-muted-foreground">{status}</span>
          <AgentStatusBadge status={status} agent="claude" />
          <AgentStatusBadge status={status} />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        left: provider mark (claude) · right: generic mark
      </p>
    </div>
  ),
};
