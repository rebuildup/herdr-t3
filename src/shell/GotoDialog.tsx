/*
 * "Go to" picker (issue #114): the GUI counterpart of herdr's TUI
 * navigator (`prefix+g`). Rows come from the pure builder in ./goto —
 * workspace / tab / pane jump targets across every live machine,
 * workspace-grouped, multi-word AND search, and a leading status token
 * (`blocked`, `working`, `idle`, `done` or `b`/`w`/`i`/`d`) filters panes
 * by agent status while keeping their workspace/tab ancestors as headers.
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Columns2,
  MonitorIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";
import { AgentIdentityIcon } from "~/components/agentIdentityIcon";
import { buildGotoRows, filterGotoRows, type GotoRow } from "./goto";
import {
  callRpc,
  ensureMachine,
  machineListOf,
  selectWorkspace,
  useBridgeState,
} from "./bridge";
import { machineStale } from "./view";
import { focusPaneTerminal } from "~/lib/focusHandoff";
import { useWorkspaceBranchIndex } from "./worktrees";

function rowIcon(row: GotoRow) {
  if (row.kind === "workspace") return <MonitorIcon className="size-4" />;
  if (row.kind === "tab") return <Columns2 className="size-4" />;
  // Pane rows carry the unified agent-work glyph (brand mark when the
  // row knows the provider kind, generic mark otherwise).
  return (
    <AgentIdentityIcon
      agent={row.agentKind}
      status={row.status ?? "unknown"}
      size="sm"
    />
  );
}

function jumpTo(row: GotoRow): void {
  selectWorkspace(row.machine, row.workspaceId);
  if (row.kind === "workspace") return;
  void ensureMachine(row.machine)
    .then(() => {
      if (row.kind === "tab" && row.tabId) {
        return callRpc(row.machine, "tab.focus", { tab_id: row.tabId });
      }
      if (row.kind === "pane" && row.paneId) {
        return callRpc(row.machine, "pane.focus", { pane_id: row.paneId });
      }
      return undefined;
    })
    .catch(() => {});
}

interface GotoGroup {
  key: string;
  label: string;
  rows: GotoRow[];
}

/** Group consecutive rows under their workspace header. */
function groupRows(rows: GotoRow[], multiMachine: boolean): GotoGroup[] {
  const groups: GotoGroup[] = [];
  for (const row of rows) {
    const key = `${row.machine}:${row.workspaceId}`;
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const wsRow = row.kind === "workspace" ? row : undefined;
      group = {
        key,
        label: wsRow
          ? `${multiMachine ? `${row.machineLabel} · ` : ""}${row.label}`
          : `${multiMachine ? `${row.machineLabel} · ` : ""}${row.detail ?? key}`,
        rows: [],
      };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

export function GotoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bridge = useBridgeState();
  const branchIndex = useWorkspaceBranchIndex();
  const [query, setQuery] = useState("");

  // Closing must return focus to the working terminal: the dialog was
  // opened from the palette whose own focus restore target is gone by
  // then, so without this focus drops to <body> (issue #134).
  const close = useCallback(() => {
    onOpenChange(false);
    setTimeout(() => focusPaneTerminal(), 0);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const machines = machineListOf(bridge);
  const rows = useMemo(
    () =>
      buildGotoRows(
        machines
          .filter((m) => !machineStale(m))
          .map((m) => ({
            machine: m,
            snapshot: bridge.snapshots[m.id],
            branchIndex,
          }))
          .filter(
            (e): e is typeof e & { snapshot: NonNullable<typeof e.snapshot> } =>
              e.snapshot !== undefined,
          ),
      ),
    [machines, bridge.snapshots, branchIndex],
  );
  const filtered = useMemo(() => filterGotoRows(rows, query), [rows, query]);
  const groups = useMemo(
    () => groupRows(filtered, machines.length > 1),
    [filtered, machines.length],
  );

  return (
    <CommandDialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <CommandDialogPopup aria-label="Go to" data-command-palette="true" data-goto-dialog="true">
        <Command mode="none" value={query} onValueChange={setQuery}>
          <div className="relative">
            <CommandInput
              data-goto-input="true"
              placeholder="Go to workspace, tab or pane — status: blocked/working/idle/done"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <CommandPanel className="flex max-h-[min(28rem,70vh)] min-h-0 flex-col">
            <CommandList>
              {groups.map((group) => (
                <CommandGroup key={group.key}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  {group.rows.map((row) => (
                    <CommandItem
                      key={row.id}
                      value={row.id}
                      data-goto-row={row.id}
                      onClick={() => {
                        jumpTo(row);
                        close();
                      }}
                    >
                      <span
                        className={cn(
                          "flex items-center justify-center",
                          row.kind === "pane" && "ms-8 size-4",
                          row.kind === "tab" && "ms-4",
                        )}
                      >
                        {rowIcon(row)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate">{row.label}</span>
                          {row.meta ? (
                            <span className="max-w-40 truncate text-2xs text-muted-foreground">
                              {row.meta}
                            </span>
                          ) : null}
                        </span>
                        {row.detail ? (
                          <span className="truncate text-2xs text-muted-foreground/70">
                            {row.detail}
                            {row.current ? " · current" : ""}
                          </span>
                        ) : row.current ? (
                          <span className="text-2xs text-muted-foreground/70">current</span>
                        ) : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No matches.
                </p>
              ) : null}
            </CommandList>
          </CommandPanel>
          <CommandFooter className="max-sm:flex-col max-sm:items-start">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <KbdGroup>
                <Kbd>
                  <ArrowUpIcon />
                </Kbd>
                <Kbd>
                  <ArrowDownIcon />
                </Kbd>
                <span>Navigate</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>Jump</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>Esc</Kbd>
                <span>Close</span>
              </KbdGroup>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
