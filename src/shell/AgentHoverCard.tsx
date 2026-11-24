/*
 * Agent row hover details (issue #154, T3 `ThreadHoverCard`): a glass
 * tooltip card whose title is the work target and whose rows are the
 * herdr-sourced facts the row itself truncates — status, agent identity,
 * workspace/tab/machine location, working directory and pane title.
 * Nothing here is derived state: every field comes from AgentInfo /
 * PaneInfo as herdr reported it.
 */
import {
  BotIcon,
  FolderIcon,
  FolderOpenIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { PaneInfo } from "../../shared/protocol";
import { statusIcon } from "~/components/statusIcons";
import {
  agentAuxStateLabels,
  agentDisplayName,
  agentStateLabel,
  agentWorkTarget,
  type AgentListEntry,
} from "./agents";

function DetailRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3">
        {icon}
      </span>
      <span className="min-w-0 truncate text-foreground/75">{children}</span>
    </div>
  );
}

export function AgentHoverCard({
  entry,
  multiMachine,
  pane,
}: {
  entry: AgentListEntry;
  multiMachine: boolean;
  pane: PaneInfo | undefined;
}) {
  const { machine, agent } = entry;
  const title = agentWorkTarget(agent) ?? agentDisplayName(agent);
  const displayName = agentDisplayName(agent);
  const stateLabel = agentStateLabel(agent);
  const auxLabels = agentAuxStateLabels(agent);
  const location = [entry.workspaceTitle, entry.tabLabel, multiMachine ? machine.label : null]
    .filter(Boolean)
    .join(" · ");
  const directory =
    agent.foreground_cwd ?? agent.cwd ?? pane?.foreground_cwd ?? pane?.cwd ?? null;
  const paneTitle =
    pane?.terminal_title_stripped ??
    pane?.terminal_title ??
    pane?.title ??
    pane?.label ??
    null;
  // Agent identity dedupes against the title (issue #165): when the pane
  // title already is the agent name, "pi · pi" adds nothing.
  const agentParts = [displayName];
  if (agent.agent && agent.agent !== displayName) agentParts.push(agent.agent);
  const agentLabel = agentParts.join(" · ");
  // The pane row always carries the pane id — the disambiguator the
  // truncated row cannot show — plus the pane title when it adds info.
  const paneParts = [
    paneTitle && paneTitle !== title && paneTitle !== displayName ? paneTitle : null,
    agent.pane_id,
  ].filter((p): p is string => p !== null);

  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs font-medium leading-tight text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        <DetailRow icon={statusIcon(agent.agent_status)}>
          {stateLabel}
          {auxLabels.length > 0 ? ` · ${auxLabels.join(" · ")}` : null}
        </DetailRow>
        {agentLabel !== title ? (
          <DetailRow icon={<BotIcon />}>{agentLabel}</DetailRow>
        ) : null}
        {location ? <DetailRow icon={<FolderIcon />}>{location}</DetailRow> : null}
        {directory ? <DetailRow icon={<FolderOpenIcon />}>{directory}</DetailRow> : null}
        <DetailRow icon={<SquareTerminalIcon />}>{paneParts.join(" · ")}</DetailRow>
      </div>
    </div>
  );
}
