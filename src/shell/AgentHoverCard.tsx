/*
 * Agent row hover details (issue #154, T3 `ThreadHoverCard`): a glass
 * tooltip card whose title is the pane's terminal title and whose rows
 * are the herdr-sourced facts the row itself truncates — status, agent
 * identity with provider artwork, workspace/tab/machine location,
 * working directory and pane id. Nothing here is derived state: every
 * field comes from AgentInfo / PaneInfo as herdr reported it.
 */
import {
  FolderOpenIcon,
  MapPinIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { PaneInfo } from "../../shared/protocol";
import { isAgentKindName } from "~/components/agentKind";
import { AgentProviderIcon } from "~/components/agentIcons";
import { AgentIdentityIcon } from "~/components/agentIdentityIcon";
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
      {/* `[&>svg]` sizes only direct-child glyphs: composite components
          like AgentIdentityIcon own their inner svg sizing. */}
      <span className="flex size-3 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3">
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
  // Title resolves through agentWorkTarget — the live pane terminal
  // title when present, never the raw pane id fallback paneTitle()
  // would produce for untitled panes (issue #204 review: "w1:p7" as a
  // heading duplicated the pane-id row and contradicted the row label).
  const workTarget = agentWorkTarget(agent, pane) ?? agentDisplayName(agent);
  // Agent CLIs prefix their terminal titles with the kind ("devin: …"),
  // which printed the provider name twice — once in the heading and
  // again on the identity row below (issue #417). Strip a leading
  // "<kind>:" echo; the row keeps the canonical provider label.
  const kindPrefix = agent.agent ? `${agent.agent.toLowerCase()}:` : null;
  const stripped =
    kindPrefix !== null && workTarget.toLowerCase().startsWith(kindPrefix)
      ? workTarget.slice(kindPrefix.length).trimStart()
      : "";
  const title = stripped.length > 0 ? stripped : workTarget;
  const displayName = agentDisplayName(agent);
  const stateLabel = agentStateLabel(agent);
  const auxLabels = agentAuxStateLabels(agent);
  const location = [entry.workspaceTitle, entry.tabLabel, multiMachine ? machine.label : null]
    .filter(Boolean)
    .join(" · ");
  const directory =
    agent.foreground_cwd ?? agent.cwd ?? pane?.foreground_cwd ?? pane?.cwd ?? null;
  // Agent identity dedupes against the title (issue #165): when the pane
  // title already is the agent name, "pi · pi" adds nothing.
  const agentParts = [displayName];
  if (agent.agent && !isAgentKindName(displayName, agent.agent)) agentParts.push(agent.agent);
  const agentLabel = agentParts.join(" · ");

  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs font-medium leading-tight text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        <DetailRow
          icon={
            <AgentIdentityIcon
              agent={agent.agent}
              status={agent.agent_status}
              size="sm"
            />
          }
        >
          {stateLabel}
          {auxLabels.length > 0 ? ` · ${auxLabels.join(" · ")}` : null}
        </DetailRow>
        {/* The provider row stays even when its label duplicates the title:
            the brand mark is the row's payload, and a card whose row count
            changes with title luck reads as broken (issue #204 review). */}
        <DetailRow
          icon={
            <AgentProviderIcon agent={agent.agent} className="size-3" />
          }
        >
          {agentLabel}
        </DetailRow>
        {location ? <DetailRow icon={<MapPinIcon />}>{location}</DetailRow> : null}
        {directory ? <DetailRow icon={<FolderOpenIcon />}>{directory}</DetailRow> : null}
        {/* The card is where the full workspace-prefixed address belongs
            — the row shows only the short disambiguation token. */}
        <DetailRow icon={<SquareTerminalIcon />}>{agent.pane_id}</DetailRow>
      </div>
    </div>
  );
}
