/*
 * Workspace canvas — the pane grid area for the M1 fixture shell
 * (issue #83). Renders fixture panes as terminal-surface placeholders;
 * M2 mounts real PaneTerminal surfaces here.
 */
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { statusIcon } from "~/components/statusIcons";
import { fixtureWorkspace } from "./fixtures";
import { useRoute } from "./router";
import { activeTabOf, useShellState } from "./store";
import type { FixturePane } from "./fixtures";

function FixturePaneSurface({ pane }: { pane: FixturePane }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="flex size-3.5 items-center justify-center">
          {statusIcon(pane.agentStatus)}
        </span>
        <span className="truncate text-xs text-secondary-label">
          {pane.title}
          {pane.agent ? ` · ${pane.agent}` : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3 font-mono text-2xs leading-5 text-muted-foreground">
        <p>{"rebui@studio ~ %"}</p>
        <p className="text-foreground/80">{"$ herdr-t3 dev"}</p>
        <p>{"  vite v8.3.4  ready in 412 ms"}</p>
        <p>{"  ➜  Local:   http://localhost:5737/"}</p>
        <p className="mt-2 flex items-center gap-1">
          <span className="text-foreground">{"$"}</span>
          <span className="inline-block h-3.5 w-1.5 animate-pulse bg-foreground/70" />
        </p>
      </div>
    </div>
  );
}

export function WorkspaceCanvas() {
  const route = useRoute();
  const shell = useShellState();
  const workspace = fixtureWorkspace(
    route.name === "workspace" ? route.workspaceId : null,
  );
  const tab = workspace ? activeTabOf(workspace, shell) : undefined;
  const zoomed = tab !== undefined && shell.zoomedTab === tab.id;

  const panes = useMemo(() => {
    if (!tab) return [];
    return zoomed ? tab.panes.slice(0, 1) : tab.panes;
  }, [tab, zoomed]);

  if (!tab || panes.length === 0) {
    return <div className="min-h-0 flex-1" />;
  }

  const gridClass =
    panes.length === 1
      ? "grid-cols-1"
      : panes.length === 2
        ? "grid-cols-2"
        : panes.length === 3
          ? "grid-cols-[2fr_1fr] grid-rows-2 [&>*:first-child]:row-span-2"
          : "grid-cols-2 grid-rows-2";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 p-3">
      <div className={cn("grid h-full w-full gap-2", gridClass)}>
        {panes.map((pane) => (
          <FixturePaneSurface key={pane.id} pane={pane} />
        ))}
      </div>
    </div>
  );
}
