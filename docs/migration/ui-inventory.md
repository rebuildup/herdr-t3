# UI inventory — boundary 5 (pane/UI/settings shell), issue #305

Classification of every non-test source file under `src/` for the
Electron→GPUI migration. Categories:

- **VM** — pure view-model / derivation logic; port to Rust as data
  (some already covered by `state-projections`)
- **VIEW** — DOM/React rendering; becomes a GPUI view (semantics pinned
  by `ui-shell@1` + ui-conformance scenarios, not DOM structure)
- **BRIDGE** — transport/consumer side of B1 protocol; depends on the
  transitional Rust host (#314) before it can consume Rust crates
- **DONE** — already ported/contracted (terminal pipeline, projections)

## Shell views (`src/shell/`)

| File | Kind | Notes / target |
|---|---|---|
| `AppShell.tsx` | VIEW | root layout, view switching (router state) |
| `WorkspaceCanvas.tsx` | VIEW | pane grid composition; depends on pane order/focus VM |
| `WorkspaceHeader.tsx` | VIEW | breadcrumb + workspace actions |
| `WorkspaceSidebar.tsx` | VIEW | workspace/tab/pane tree, agent badges |
| `SidebarChrome.tsx` | VIEW | sidebar collapse/resize chrome |
| `CommandMenu.tsx` | VIEW | command palette shell (logic in goto/shortcuts) |
| `GotoDialog.tsx` | VIEW | "go to" picker renderer (model: `goto.ts`) |
| `SettingsModal.tsx` | VIEW | settings sections host |
| `NoticeToasts.tsx` | VIEW | toast stack renderer (model: `notices.ts`) |
| `AgentHoverCard.tsx` | VIEW | hover card (data: `agents.ts`) |
| `agents.ts` | VM | agent entries/partition — **DONE** (`state-projections`, #281) |
| `agentOrganizeStore.ts` | VM | organize record accumulation — DONE (projection abnormal-inputs cover records) |
| `attention.ts` | VM | attention/ badge derivation — port candidate |
| `goto.ts` | VM | go-to row building + matching — **first vertical slice** (pure, tested) |
| `inbox.ts` | VM | agent inbox prompt-answer routing — check plugin boundary (ADR-0011) |
| `notices.ts` | VM | notice/toast model — port candidate |
| `projects.ts` | VM | project list derivation — port candidate |
| `projectScripts.ts` | VM | project script runner state — port candidate |
| `worktrees.ts` | VM | worktree list/index (`branchIndex` feeds goto) — port candidate |
| `checkpoints.ts` | VM | checkpoint list/dialog model — port candidate |
| `git.ts` | VM | git status/diff dialog model — port candidate |
| `router.ts` | VM | route/view state machine — port candidate (small) |
| `view.ts` | VM | top-level view selection — port candidate (small) |
| `bridge.ts` | BRIDGE | window→main frame transport — consumer of protocol.codec |

## Components (`src/components/`)

| File | Kind | Notes |
|---|---|---|
| `PaneTerminal.tsx` | VIEW | the only `GhosttySurface` consumer — terminal surface host |
| `WorkspaceBreadcrumb.tsx` | VIEW | header breadcrumb |
| `AgentStatusBadge.tsx`, `agentIcons.tsx`, `statusIcons.tsx`, `agentIconData.ts` | VIEW | status iconography (icons are assets, semantics in contract) |
| `ThemeModeTiles.tsx` | VIEW | appearance picker (settings-persistence contract) |
| `CheckpointsDialog.tsx` … `WorktreesDialog.tsx`, `RenameDialog.tsx`, `PaneDetailsDialog.tsx`, `PaneMessageDialog.tsx`, `MachineDialog.tsx`, `ProjectsDialog.tsx`, `ProjectScriptsDialog.tsx`, `GitDialog.tsx` | VIEW | dialog suite; models live in `src/shell/*.ts` |
| `ui/*` (19 primitives: button, dialog, menu, select, input, sidebar, command, …) | VIEW | T3 Code design-system primitives — GPUI equivalents; semantics canonical in `docs/design/`, DOM structure is not |

## Lib (`src/lib/`)

| File | Kind | Notes |
|---|---|---|
| `settings.ts`, `persistence-compat.boot.ts`, `localStorage.ts` | VM | settings/persistence — contract `settings-persistence@1`; Rust side owns schema |
| `theme.ts`, `windowControlsOverlay.ts` | VIEW-adj | theme resolution + chrome — OS-integration boundary (B7) |
| `shortcuts.ts`, `paneFocus.ts`, `paneOrder.ts`, `reorder.ts`, `sidebarListMotion.ts`, `visibleAnimation.ts` | VM | interaction models — port candidates (small, testable) |
| `workspace.ts` | VM | `workspaceTitle`/`paneTitle` — **DONE** (`derive_workspace`) |
| `ghostty/*` | DONE | engine/session/scene/input/surface — all `rust-implemented` (#286/#294/#298/#304/#301) |
| `api.ts`, `env.ts`, `accessibility.ts`, `uiObserve.ts`, `observeResize.ts`, `utils.ts` | VIEW/host | DOM/host services — replaced by GPUI platform layer, not ported |

## Dependency graph (consumer direction)

```
App.tsx / main.tsx
└─ AppShell (VIEW)
   ├─ WorkspaceSidebar (VIEW) ─ agents.ts ─► agent.projection (Rust DONE)
   │                                      └ attention.ts (VM→port)
   ├─ WorkspaceCanvas (VIEW) ─ paneFocus/paneOrder/reorder (VM→port)
   │   └─ PaneTerminal (VIEW) ─ GhosttySurface ─► terminal.{engine,scene,input,surface} (Rust DONE)
   ├─ WorkspaceHeader/Breadcrumb (VIEW)
   ├─ CommandMenu/GotoDialog (VIEW) ─ goto.ts (VM→port, slice #1)
   │                                 └ worktrees.ts branchIndex
   ├─ SettingsModal (VIEW) ─ settings.ts ─► settings-persistence (contract exists)
   ├─ *Dialog suite (VIEW) ─ shell/*.ts models (VM→port)
   └─ bridge.ts (BRIDGE) ─► protocol.codec (Rust DONE) ─► B1 frames ─► herdr
```

Edges denote "feeds". Nothing in `src/` reaches herdr except through
`bridge.ts`; the Rust core never depends back on this tree (ADR-0013 §3).

## Sub-issue decomposition (filed under #305)

1. **ui-primitives**: GPUI design-system primitives matching
   `components/ui/*` semantics (contract `ui-shell@1`)
2. **app-shell-chrome**: AppShell + sidebar chrome + header/breadcrumb +
   toasts
3. **workspace-canvas**: pane grid, focus/order/reorder models, and the
   PaneTerminal host wiring to `terminal-surface`
4. **workspace-sidebar**: tree view + agent badges + attention model
5. **dialogs-suite**: all `*Dialog.tsx` + their `shell/*.ts` models
6. **settings-modal**: settings sections + `settings-persistence`
   read/write path on the Rust side
7. **goto-picker (vertical slice #1)**: port `goto.ts` to Rust, host a
   picker view in `ui-test-host`, add ui-conformance scenario
8. **bridge-consumer**: `bridge.ts` transport on the transitional Rust
   host (#314) — gates every BRIDGE-side switch (#315/#316)

Order: 7 first (pure, already-tested logic, proves the VM→GPUI-view
pattern), then 1 (primitives everything else needs), 2/3/4 parallel
after 1, 5/6 after their models port, 8 gated on #314.
