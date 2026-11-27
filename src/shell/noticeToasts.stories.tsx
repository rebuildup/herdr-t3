import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "~/components/ui/button";
import { ToastProvider, type ToastPosition } from "~/components/ui/toast";
import { MAX_NOTICES, pushNotice } from "./notices";

const meta: Meta<{ position: ToastPosition }> = {
  title: "Notifications/NoticeToasts",
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The real notice path: pushNotice feeds the shared Base UI toast
 * primitive exactly as attention.ts and the shell surfaces do. Toasts
 * auto-dismiss after 10s of visible time; hovering pauses the timer.
 */
export const Playground: Story = {
  render: (args) => (
    <ToastProvider position={args.position} timeout={0} limit={MAX_NOTICES}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "attention",
              status: "blocked",
              title: "Agent needs input",
              body: "claude · refactor auth flow",
              context: "my-app · mbp · main",
            })
          }
        >
          Agent blocked
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "attention",
              status: "done",
              title: "Agent finished",
              body: "codex · fix flaky test",
              context: "my-app · mbp · main",
            })
          }
        >
          Agent done
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "info",
              title: "Workspace created",
              body: "auth-refactor is ready",
              context: "my-app · mbp",
            })
          }
        >
          Info
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "error",
              title: "RPC failed",
              body: "pane.split timed out",
            })
          }
        >
          Error
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "info",
              title: "Tab closed",
              body: "scratch",
              action: { label: "Undo", run: () => {} },
            })
          }
        >
          With action
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            for (let i = 0; i < 4; i += 1) {
              pushNotice({
                kind: "info",
                title: `Notice ${i + 1}`,
                body: "stacked collapse preview",
              });
            }
          }}
        >
          Stack 4
        </Button>
      </div>
    </ToastProvider>
  ),
  args: { position: "top-right" as ToastPosition },
  argTypes: {
    position: {
      control: "select",
      options: [
        "top-left",
        "top-center",
        "top-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
      ],
    },
  },
};
