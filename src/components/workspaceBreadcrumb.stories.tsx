import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "./WorkspaceBreadcrumb";
import { MiddleTruncate } from "./ui/middle-truncate";

const meta = {
  title: "Workspace/Breadcrumb",
  component: WorkspaceBreadcrumb,
} satisfies Meta<typeof WorkspaceBreadcrumb>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { ariaLabel: "Workspace path", children: null },
  render: () => (
    <WorkspaceBreadcrumb ariaLabel="Workspace path">
      <WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbText>mbp</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <WorkspaceBreadcrumbItem current>
        <WorkspaceBreadcrumbText>
          <MiddleTruncate value="auth-refactor · main" />
        </WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  ),
};

/** Long workspace title: MiddleTruncate keeps both ends readable. */
export const LongTitle: Story = {
  args: { ariaLabel: "Workspace path", children: null },
  render: () => (
    <div className="w-72">
      <WorkspaceBreadcrumb ariaLabel="Workspace path">
        <WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbText>work-laptop-02</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <WorkspaceBreadcrumbText>
            <MiddleTruncate value="feature/very-long-workspace-name-that-overflows · topic/agent-status-indicator-unification" />
          </WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </div>
  ),
};
