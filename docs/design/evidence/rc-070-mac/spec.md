# RC evidence: herdr-t3 0.7.0 candidate @ 98cd4f5 (macOS, electron adapter)

Candidate SHA: `98cd4f510dd44e93e91f42d3f63c1634e0769fbc` (release-0-7-0 HEAD at capture time).

## Capture conditions

- Adapter: vite dev server (`bun --bun vite`, port 5737) + bridge (`bun run server`, port 4743)
  against isolated herdr session `ht3rc` seeded with scrollback workspaces. No live session used.
- Browser: headless Chrome via CDP, 1440x900 @2x desktop; 480x800 @2x mobile emulation for narrow shots.
- Script: `scripts/capture-evidence.ts` (all DOM assertions passed; see run log in issue #413).
- Theme shots use persisted `herdr-t3:appearance` + reload.

## Files

- `01-sidebar-populated` — sidebar with seeded workspaces, hoxay wordmark
- `02-sidebar-collapsed` — collapsed rail state
- `03-command-palette` — Ctrl+K palette (actions + workspace search)
- `04-sidebar-context-menu` / `05-pane-context-menu` — context menus
- `07-pane-split` / `08-pane-zoomed` — split + zoom states (DOM-verified pane counts)
- `09-dark` / `10-light` — appearance modes
- `11-narrow` / `12-narrow-sheet` — mobile-width layout + sidebar sheet

## Known capture caveats

- `10-light` was captured immediately after theme apply; the bridge reconnect
  line ("Connecting to local...") may still be visible — transient state, not a defect.
- This set covers shell-level surfaces. Per-surface deep captures (Settings sections,
  Usage/Handoffs/StatusBadge conversions) are tracked under #534 verification and the
  ui-scenario evidence in `harness/ui/evidence/electron/`.
