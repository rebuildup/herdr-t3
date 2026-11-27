import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Spinner } from "./spinner";

const meta = {
  title: "UI/Spinner",
  component: Spinner,
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

const SIZES = ["xs", "sm", "md", "lg"] as const;
const TONES = ["current", "muted"] as const;

export const SizesAndTones: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {TONES.map((tone) => (
        <div key={tone} className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">tone: {tone}</p>
          <div className="flex items-end gap-4">
            {SIZES.map((size) => (
              <div key={size} className="flex flex-col items-center gap-1">
                <Spinner size={size} tone={tone} />
                <span className="text-2xs text-muted-foreground">{size}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

export const InButtons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" disabled>
        <Spinner /> Saving…
      </Button>
      <Button size="xs" variant="secondary" disabled>
        <Spinner /> Loading…
      </Button>
      <Button size="icon-sm" variant="ghost" disabled aria-label="Refreshing">
        <Spinner />
      </Button>
    </div>
  ),
};

export const InlineWithText: Story = {
  render: () => (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex items-center gap-2">
        <Spinner size="sm" tone="muted" /> Indexing transcripts…
      </p>
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner size="sm" /> Connecting to bridge…
      </p>
    </div>
  ),
};
