/*
 * Fixture data for the M1 shell reproduction (issue #83, ADR-0008).
 * Fixed dummy content only — no herdr RPC. M2 replaces this store with
 * the bridge snapshot behind the same shell contracts.
 */
import type { AgentStatus } from "../../shared/protocol";

export type FixtureMachineStatus = "online" | "connecting" | "offline" | "auth_required";

export interface FixtureMachine {
  id: string;
  label: string;
  kind: "local" | "ssh";
  status: FixtureMachineStatus;
  detail?: string;
}

export interface FixturePane {
  id: string;
  title: string;
  agent?: string;
  agentStatus: AgentStatus;
}

export interface FixtureTab {
  id: string;
  workspaceId: string;
  label: string;
  number: number;
  agentStatus: AgentStatus;
  panes: FixturePane[];
}

export interface FixtureWorkspace {
  id: string;
  machineId: string;
  title: string;
  agentStatus: AgentStatus;
  tabs: FixtureTab[];
}

export const FIXTURE_MACHINES: FixtureMachine[] = [
  { id: "local", label: "This Mac", kind: "local", status: "online" },
  { id: "studio", label: "studio-mac", kind: "ssh", status: "online", detail: "via tailscale" },
  { id: "build", label: "build-server", kind: "ssh", status: "offline", detail: "unreachable" },
];

export const FIXTURE_WORKSPACES: FixtureWorkspace[] = [
  {
    id: "ws-herdr-t3",
    machineId: "local",
    title: "herdr-t3",
    agentStatus: "working",
    tabs: [
      {
        id: "tab-ht3-main",
        workspaceId: "ws-herdr-t3",
        label: "shell",
        number: 1,
        agentStatus: "working",
        panes: [
          { id: "p-ht3-1", title: "zsh", agentStatus: "idle" },
          {
            id: "p-ht3-2",
            title: "devin",
            agent: "devin",
            agentStatus: "working",
          },
        ],
      },
      {
        id: "tab-ht3-logs",
        workspaceId: "ws-herdr-t3",
        label: "logs",
        number: 2,
        agentStatus: "idle",
        panes: [{ id: "p-ht3-3", title: "bun run dev", agentStatus: "idle" }],
      },
    ],
  },
  {
    id: "ws-dotfiles",
    machineId: "local",
    title: "dotfiles",
    agentStatus: "idle",
    tabs: [
      {
        id: "tab-df-1",
        workspaceId: "ws-dotfiles",
        label: "main",
        number: 1,
        agentStatus: "idle",
        panes: [{ id: "p-df-1", title: "nvim", agentStatus: "idle" }],
      },
    ],
  },
  {
    id: "ws-ovis",
    machineId: "local",
    title: "ovis",
    agentStatus: "done",
    tabs: [
      {
        id: "tab-ov-1",
        workspaceId: "ws-ovis",
        label: "review",
        number: 1,
        agentStatus: "done",
        panes: [
          { id: "p-ov-1", title: "claude", agent: "claude", agentStatus: "done" },
          { id: "p-ov-2", title: "git diff", agentStatus: "idle" },
        ],
      },
    ],
  },
  {
    id: "ws-api",
    machineId: "studio",
    title: "api-server",
    agentStatus: "blocked",
    tabs: [
      {
        id: "tab-api-1",
        workspaceId: "ws-api",
        label: "main",
        number: 1,
        agentStatus: "blocked",
        panes: [
          { id: "p-api-1", title: "codex", agent: "codex", agentStatus: "blocked" },
          { id: "p-api-2", title: "cargo test", agentStatus: "working" },
        ],
      },
      {
        id: "tab-api-2",
        workspaceId: "ws-api",
        label: "db",
        number: 2,
        agentStatus: "idle",
        panes: [{ id: "p-api-3", title: "psql", agentStatus: "idle" }],
      },
    ],
  },
  {
    id: "ws-blog",
    machineId: "studio",
    title: "blog",
    agentStatus: "idle",
    tabs: [
      {
        id: "tab-blog-1",
        workspaceId: "ws-blog",
        label: "main",
        number: 1,
        agentStatus: "idle",
        panes: [{ id: "p-blog-1", title: "zsh", agentStatus: "idle" }],
      },
    ],
  },
];

export function fixtureWorkspace(id: string | null): FixtureWorkspace | undefined {
  if (!id) return FIXTURE_WORKSPACES[0];
  return FIXTURE_WORKSPACES.find((w) => w.id === id);
}

export function fixtureMachine(id: string): FixtureMachine | undefined {
  return FIXTURE_MACHINES.find((m) => m.id === id);
}
