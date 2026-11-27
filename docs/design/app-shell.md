# App shell spec — T3 Code canonical structure (ADR-0008)

Canonical UI structure for herdr-t3, reproduced from T3 Code @
`9cc4018c75ff4c61be8e86a6391d49a6c2d79830` (`docs/upstream.md`). This file
defines *what the screen is*; `rules.md` defines the lint-level rules;
`verification.md` defines how fidelity is proven.

T3 sources cited below live in `t3code/apps/web/src/` at the pinned commit.

## 1. Shell regions

The application is `AppSidebarLayout` (`components/AppSidebarLayout.tsx`):

```
SidebarProvider
├─ Sidebar (left, offcanvas, resizable)     ← navigation chrome
├─ SidebarInset children                     ← routed content
├─ SidebarControl                             ← floating trigger, fixed
└─ (Electron) window-controls inset handling
```

### 1.1 Sidebar

`collapsible="offcanvas"`, resizable via rail drag with min/max clamps and
persisted width, `SidebarRail` double-click resets width
(`components/threadSidebarWidth.ts` equivalents). Composition
(`components/sidebar/SidebarChrome.tsx` + `components/Sidebar.tsx`):

- **Header** — `h-[var(--workspace-topbar-height)]` (52px) row,
  `drag-region` on Electron. Contains: brand mark + wordmark (links to
  home route), history back/forward buttons (Electron only), optional
  environment-identification pill, mobile `SidebarTrigger`.
- **Body** — search field, primary "new item" action, then the item list:
  grouped sections with headers when grouping applies, flat list
  otherwise. Rows carry status icon, title, trailing meta; hover reveals
  actions; right-click opens a context menu; keyboard navigation
  (arrow keys / type-ahead) exists.
- **Agents section (v0.5.0, bottom-dock since #211)** — every agent
  section is a collapsible shelf docked at the sidebar bottom
  (Attention / Done / Working / Idle / Snoozed / Settled, top-to-bottom;
  Attention expanded by default) over herdr `AgentInfo`, two-line rows
  per `info-architecture.md` §6. It replaces the flat status-sorted list
  shipped in v0.4.0.
- **Footer** — utility icon row: Settings plus domain utilities (T3:
  Pull requests, Issues, Usage). Transient notices (undo, updates) sit
  beside them.

### 1.2 Content inset

`SidebarInset` fills the remaining area. Two page kinds:

- **Utility pages** (settings and peers): rendered inside a page
  container with its own section navigation (T3:
  `WorkspacePageContainer` + `components/settings/SettingsSidebarNav.tsx`).
- **Main view**: a 52px drag-region header containing a breadcrumb
  (project › thread in T3; machine › workspace in herdr-t3), in-view
  actions, and panel controls; below it the work canvas.
  v0.5.0: the header carries direct icon actions for the most frequent
  pane operations (split right/down, zoom) next to the overflow "⋯"
  menu, which keeps only lower-frequency pane actions; the tab strip
  items get hover-revealed close affordances and a restored context
  menu. Role split between direct controls, context menus and the
  overflow menu is defined in §4 (info-architecture.md §8).

The header is `WorkspacePageHeader` (`components/WorkspacePageHeader.tsx`,
already vendored) or the ChatView header equivalent: `drag-region`,
`wco:pr-(--workspace-native-controls-inset)` when Window Controls Overlay
is active, collapsed-sidebar titlebar inset class.

### 1.3 Window chrome (Electron)

From `apps/desktop/src/window/DesktopWindow.ts`:

- macOS: `titleBarStyle: "hiddenInset"`,
  `trafficLightPosition: { x: 16, y: topbarHeight/2 - buttonRadius }`.
  While not fullscreen the renderer sets
  `--workspace-controls-left: var(--desktop-window-controls-inset, 90px)`
  so the floating sidebar trigger clears the traffic lights; fullscreen
  restores the normal inset.
- Windows: `titleBarStyle: "hidden"` + `titleBarOverlay` whose color and
  symbol color follow the app theme (T3 syncs on
  `nativeTheme`/settings changes).
- `-webkit-app-region: drag` on header/sidebar-header rows;
  `no-drag` on interactive controls inside them.

**Titlebar ownership (issue #408, T3 `ownsDesktopTitleBar`).** Exactly
one top-right region may own the desktop titlebar row on Windows; the
mechanisms are inert elsewhere because every reservation is behind the
`.wco` class (toggled only while `navigator.windowControlsOverlay` is
visible) or `isElectron` drag regions, which macOS already uses inside
its 52px `hiddenInset` topbar:

- The **workspace header** is the default owner: on Electron it is a
  `drag-region` and reserves `wco:pr-(--workspace-native-controls-inset)`
  so its right-edge controls clear the caption buttons.
- When the **inline (wide) right panel** is open it takes ownership
  (`ownsDesktopTitleBar = isElectron && !narrow`): its tab bar becomes
  the `drag-region`, reserves the same `wco:` inset, switches the tab
  `ScrollArea` to `no-drag` while overflowing, marks each tab
  `no-drag`, and mounts the fixed `w-28` controls strip at
  `top/right-(--workspace-controls-*)`. While it owns the titlebar the
  workspace header drops `wco:pr-(--workspace-native-controls-inset)`
  (T3 `reserveNativeControls={!rightPanelOpen}`) — the caption strip
  sits over the panel's top-right corner, not the header's right edge.
- The **narrow right-panel sheet** never owns the titlebar; it only
  clears the caption strip vertically via
  `wco:mt/h/max-h-(--workspace-topbar-height)` (T3 `RightPanelSheet`).
- Dialogs, sheets, the command palette/Goto dialog, the settings modal
  and top-positioned toasts are `no-drag` overlays that already clear
  the caption strip (`--command-titlebar-height` /
  `useNativeTitlebarHeight`, `--app-modal-*-inset`,
  `--toast-header-offset: var(--workspace-topbar-height)`).

## 2. Herdr domain mapping

| herdr concept | T3 analogue | Placement |
| --- | --- | --- |
| Machine (connection endpoint) | environment | Sidebar header identification (pill/label); groups the workspace list; managed in Settings → Connections |
| Workspace | thread list entry | Sidebar item rows: status icon, title, tab/pane meta, context menu |
| Tab | — (in-workspace view) | Tab strip inside the content header of the selected workspace |
| Pane | — (work canvas region) | Pane grid inside the content canvas; operations via header overflow menu, context menus, command palette — never a row of raw API buttons |
| Agent status | thread/provider status | Status icons/badges on workspace rows, tab strip, pane chrome and header — never `agent_status` alone without the work-context surfaces (`info-architecture.md` §4) |
| Worktree (herdr) | project branch | Branch/repo shown in workspace identity (`info-architecture.md` §3); management UI per `herdr-parity.md` §3 |
| Agent collection | thread list filter / attention | Attention aggregate in status area; agent-level list reachable from sidebar/palette (`herdr-parity.md` §2) |
| herdr mode bar / status segments | header status cluster / toast | Endpoint state, attention count, transient notices — translated to GUI equivalents, not a literal 1-row bar (`herdr-parity.md` §2) |

v0.4.0 additions: information priority and surface roles are canonical in
`info-architecture.md`; interaction/motion/drag/a11y rules in
`interaction.md`; herdr capability contract in `herdr-parity.md`.

Rules:

- The sidebar lists **workspaces**, not machines-then-workspaces-then-tabs.
  Machines appear as group headers only when more than one machine is
  configured; a single-machine setup shows a flat workspace list like
  T3's single-project sidebar.
- Selecting a workspace navigates the content area (equivalent of
  selecting a thread). Tab/Pane state lives inside that view.
- Settings/Connections/Diagnostics are utility *routes* reachable from
  the sidebar footer. T3 renders them inside `AppRouteModal` — a routed
  overlay with its own section nav and breadcrumb — and herdr-t3 keeps
  that structure. "Not modal dialogs" means no ad-hoc per-feature
  configuration dialogs; settings themselves are one consistent routed
  surface.

## 3. Settings information architecture

Mirror `SettingsSidebarNav` + `settingsLayout.tsx`: left section nav,
right grouped settings pages. herdr-t3 sections:

- **General** — app behavior, launch options, in-app notification
  position (issue #428; four corners + edge centers, persisted under
  `herdr-t3:settings:notifications`, default top-right)
- **Appearance** — theme mode (system/dark/light), Ghostty theme sync,
  UI density where applicable
- **Connections** — machines: add/edit/remove SSH endpoints, status,
  reconnect (replaces the sidebar machine list and `AddMachineDialog`)
- **Terminal** — font, size, scrollback, cursor style (Ghostty surface
  settings that exist in herdr-t3)
- **Keybindings** — shortcut list/reference (if shipped)
- **Diagnostics** — bridge status, logs, version/commit
- **About** — version, licenses (THIRD_PARTY_NOTICES), upstream credits

Settings are a consistent app surface: no per-feature dialogs for
configuration; `AddMachineDialog`-style flows become Connections pages or
dialogs launched from them.

## 4. Navigation and commands

- Routes (client-side): `/` main view (last/active workspace),
  `/w/:workspaceId` workspace view, `/settings/*` utility pages.
  Browser/Electron navigation state must support back/forward like T3's
  `navigationHistory`.
- Command palette (⌘K / Ctrl+K): T3-style grouped results — actions
  (new workspace, new tab, split, toggle sidebar, open settings, theme),
  workspace search, machine operations. Every action reachable from
  palette is also reachable from visible UI.
- Keyboard: sidebar toggle shortcut, workspace/tab navigation,
  pane focus cycling — modeled on T3 `keybindings.ts` scope/context
  rules where they apply.
- Direct control vs menu split (v0.5.0, info-architecture.md §8):
  every row/tab exposes its primary action directly (click), its most
  frequent secondary action on hover, and the full action set on
  right-click context menu; the header "⋯" overflow holds only
  lower-frequency pane actions. These channels are additive, not
  mutually exclusive — the same operation may appear in more than one.

## 5. Milestones and acceptance

### M1 — Shell reproduction (fixture data)

Fixed dummy data only; no herdr RPC. Must show: full sidebar chrome
(header/body/footer) with fixture machines+workspaces, main view with
breadcrumb + tab strip + pane grid placeholder surfaces, settings pages,
command palette, light/dark, macOS traffic-light layout and Windows WCO
code paths, responsive/narrow sheet behavior.

Acceptance: side-by-side captures vs T3 Code at identical viewport,
theme, and sidebar state are reviewed by an image-capable model for
structure/density/operability; `./scripts/ci.sh` passes; no herdr
backend behavior changes.

### M2 — Herdr mapping

Fixture store swapped for bridge snapshot behind the same shell
contracts. Workspace selection, tab strip, pane grid with real
`PaneTerminal`s, agent status, reconnect/draft invariants preserved.
Acceptance: existing bridge invariants hold (AGENTS.md §3); state-by-state
captures vs M1 fixtures show equivalent structure with real data.

### M3 — Settings & connections UX

Real settings persistence and machine management per §3. Replaces
`AddMachineDialog`, sidebar appearance select, ad-hoc dialogs.
Acceptance: every settings surface round-trips; Connections manages the
same machine list the bridge uses.

### M4 — Release candidate

Full visual review per `verification.md`, Windows 11 + macOS real-machine
acceptance, evidence under `docs/design/evidence/<issue>/`.

## 6. Explicit non-goals

- No T3 threads/projects/providers/PR/issues/usage domain concepts.
- No Effect/atom/TanStack-router/i18n stack adoption.
- No fabricated conversation/composer UI; herdr panes stay terminals.
- No changes to bridge protocol, Ghostty engine, or session ownership.
