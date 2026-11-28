/**
 * Operational-efficiency catalogue (issue #640).
 *
 * "Can hoxay replace the TUI for daily work" is partly a question of how
 * many user actions a common task costs. The TUI side is *derived* from
 * the keybinding inventory (`quality/tui-parity/tui/inventory.json`,
 * itself generated from the installed herdr binary). The hoxay side is
 * a curated table with a named source for every count, so a UI change
 * that adds a step shows up as a diff here.
 *
 * Count conventions:
 *   - TUI: one keystroke = one action. A prefix sequence (`ctrl+b` then
 *     `v`) is two actions; typing a search term counts per keystroke.
 *   - hoxay: one pointer gesture (click / drag) = one action; a
 *     keyboard shortcut = one action.
 *
 * Text entry is NOT counted: entering a name or a search term costs the
 * same on both clients and would only add noise. The counts therefore
 * measure *how a task is reached*, not what is typed into it.
 */
export interface EfficiencyTask {
  id: string;
  task: string;
  /** action count on the TUI, with the derivation */
  tui: { actions: number; how: string };
  /** action count in hoxay, with the source of the count */
  hoxay: { actions: number; how: string };
  /** the TUI binding the count was derived from (inventory key) */
  tuiBinding?: string;
}

export const EFFICIENCY_TASKS: EfficiencyTask[] = [
  {
    id: "switch-workspace",
    task: "switch to another workspace",
    tui: { actions: 3, how: "ctrl+b, w (workspace picker), pick the row" },
    hoxay: { actions: 1, how: "click the workspace row in the sidebar" },
    tuiBinding: "workspace_picker",
  },
  {
    id: "create-workspace",
    task: "create a workspace",
    tui: { actions: 2, how: "ctrl+b, shift+n" },
    hoxay: { actions: 2, how: "command palette (⌘K) → 'New workspace'" },
    tuiBinding: "new_workspace",
  },
  {
    id: "rename-workspace",
    task: "rename a workspace",
    tui: { actions: 2, how: "ctrl+b, shift+w" },
    hoxay: { actions: 2, how: "right-click the row → Rename…" },
    tuiBinding: "rename_workspace",
  },
  {
    id: "close-workspace",
    task: "close a workspace",
    tui: { actions: 2, how: "ctrl+b, shift+d" },
    hoxay: { actions: 2, how: "right-click the row → Close" },
    tuiBinding: "close_workspace",
  },
  {
    id: "new-tab",
    task: "open a new tab",
    tui: { actions: 2, how: "ctrl+b, c" },
    hoxay: { actions: 1, how: "click '+' in the tab strip" },
    tuiBinding: "new_tab",
  },
  {
    id: "switch-tab",
    task: "switch to another tab",
    tui: { actions: 2, how: "ctrl+b, 1..9" },
    hoxay: { actions: 1, how: "click the tab" },
    tuiBinding: "switch_tab",
  },
  {
    id: "split-pane",
    task: "split the focused pane",
    tui: { actions: 2, how: "ctrl+b, v (vertical)" },
    hoxay: { actions: 1, how: "click the pane's split control" },
    tuiBinding: "split_vertical",
  },
  {
    id: "close-pane",
    task: "close the focused pane",
    tui: { actions: 2, how: "ctrl+b, x" },
    hoxay: { actions: 1, how: "click the pane's close control" },
    tuiBinding: "close_pane",
  },
  {
    id: "zoom-pane",
    task: "zoom / unzoom the focused pane",
    tui: { actions: 2, how: "ctrl+b, z" },
    hoxay: { actions: 1, how: "click the pane's zoom control" },
    tuiBinding: "zoom",
  },
  {
    id: "focus-pane",
    task: "move focus to the neighbouring pane",
    tui: { actions: 2, how: "ctrl+b, h/j/k/l" },
    hoxay: { actions: 1, how: "click the target pane" },
    tuiBinding: "focus_pane_left",
  },
  {
    id: "resize-pane",
    task: "resize a pane",
    tui: { actions: 3, how: "ctrl+b, r (resize mode), arrow" },
    hoxay: { actions: 1, how: "drag the split boundary" },
    tuiBinding: "resize_mode",
  },
  {
    id: "goto-search",
    task: "jump to a workspace, tab or pane by name",
    tui: { actions: 4, how: "ctrl+b, g, type a name, Enter" },
    hoxay: { actions: 4, how: "⌘K, type a name, Enter" },
    tuiBinding: "goto",
  },
  {
    id: "new-worktree",
    task: "create a worktree-backed workspace",
    tui: { actions: 2, how: "ctrl+b, shift+g" },
    hoxay: { actions: 2, how: "command palette → 'New worktree'" },
    tuiBinding: "new_worktree",
  },
  {
    id: "search-scrollback",
    task: "search inside the focused pane's scrollback",
    tui: { actions: 2, how: "ctrl+b, e (copy/edit mode), then the search keys" },
    hoxay: { actions: 2, how: "⌘F, type the needle" },
    tuiBinding: "edit_scrollback",
  },
  {
    id: "help-overlay",
    task: "look up the available keybindings",
    tui: { actions: 2, how: "ctrl+b, ?" },
    hoxay: { actions: 2, how: "⌘K → 'Keyboard shortcuts'" },
    tuiBinding: "help",
  },
];

export interface EfficiencyComparison {
  id: string;
  task: string;
  tuiActions: number;
  hoxayActions: number;
  /** hoxay is no worse than the TUI */
  pass: boolean;
  delta: number;
}

export function compareEfficiency(tasks: EfficiencyTask[] = EFFICIENCY_TASKS): EfficiencyComparison[] {
  return tasks.map((t) => ({
    id: t.id,
    task: t.task,
    tuiActions: t.tui.actions,
    hoxayActions: t.hoxay.actions,
    delta: t.tui.actions - t.hoxay.actions,
    pass: t.hoxay.actions <= t.tui.actions,
  }));
}
