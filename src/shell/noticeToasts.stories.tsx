import { useEffect } from "react";
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
              agent: "claude",
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
              agent: "codex",
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
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "attention",
              status: "blocked",
              agent: "claude",
              title:
                "Agent needs input: waiting on approval for the destructive migration step in the checkout retry refactor",
              // Unbroken tokens (URL-ish, CJK) stress overflow-wrap;
              // spaces + punctuation stress normal wrapping.
              body: "claude-code・長いワークスペース名とブランチ名を含む行 — https://example.com/a/very/long/path/that/keeps/going/and/going/without/spacesOrBreaks",
              context:
                "extremely-long-workspace-name-that-keeps-going · very-long-machine-label · feature/very-long-branch-name-for-stress-testing",
            })
          }
        >
          Long attention
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            pushNotice({
              kind: "info",
              title: "A title with no spaces whatsoeverinitshouldstillwrapcleanly",
              body: "Supercalifragilisticexpialidocious".repeat(6),
              action: { label: "A very long action label", run: () => {} },
            })
          }
        >
          Long + action
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

/**
 * Long-content stress (issue #550): pushes on mount so the worst cases
 * are visible without clicking — unbroken tokens, CJK strings, max-length
 * context, an action, and a stacked mix. The layout contract is: icon
 * column `shrink-0`, text column `min-w-0` with wrap-break-word titles/
 * descriptions and a truncating meta line, action `shrink-0` — nothing
 * may push siblings out or overflow horizontally.
 */
export const LongContentStress: Story = {
  render: () => {
    useEffect(() => {
      pushNotice({
        kind: "attention",
        status: "blocked",
        agent: "claude",
        title:
          "Agent needs input: waiting on approval for the destructive migration step in the checkout retry refactor",
        body: "claude-code・長いワークスペース名とブランチ名を含む行 — https://example.com/a/very/long/path/that/keeps/going/and/going/without/spacesOrBreaks",
        context:
          "extremely-long-workspace-name-that-keeps-going · very-long-machine-label · feature/very-long-branch-name-for-stress-testing",
      });
      pushNotice({
        kind: "info",
        title: "A title with no spaces whatsoeverinitshouldstillwrapcleanly",
        body: "Supercalifragilisticexpialidocious".repeat(6),
        context: "ctx",
        action: { label: "A very long action label", run: () => {} },
      });
      pushNotice({
        kind: "error",
        title: "err",
        body: "x".repeat(400),
      });
    }, []);
    return <ToastProvider position="top-right" timeout={0} limit={MAX_NOTICES} />;
  },
};
