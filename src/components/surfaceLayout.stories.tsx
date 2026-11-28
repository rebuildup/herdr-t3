import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  SurfaceLoadingRow,
  SurfaceLoadingRows,
  SurfaceSkeletonRows,
} from "./surfaceLayout";

const meta = {
  title: "Surfaces/Loading",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingRows: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">rows=2</p>
        <SurfaceLoadingRows label="Loading git status" rows={2} />
      </div>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">rows=5</p>
        <SurfaceLoadingRows label="Loading pull requests" rows={5} />
      </div>
    </div>
  ),
};

export const SkeletonRows: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">SurfaceSkeletonRows rows=3</p>
        <SurfaceSkeletonRows rows={3} />
      </div>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">SurfaceLoadingRow</p>
        <SurfaceLoadingRow>
          <span className="text-sm text-muted-foreground">row content placeholder</span>
        </SurfaceLoadingRow>
      </div>
    </div>
  ),
};
