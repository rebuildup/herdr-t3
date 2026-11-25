# UI conformance scenario format (issue #238)

Framework-independent UI scenarios shared by the current Electron client
and the future GPUI host. A scenario is **data**: a semantic initial
fixture, an ordered list of semantic actions, wait conditions, and
semantic assertions. It must never contain DOM selectors, React
component names, or Rust-internal types — adapters translate semantic
targets to their platform's reality.

Canonical behavior contracts: `docs/migration/contracts/ui-shell.md`
and siblings; capabilities: `docs/migration/capabilities.json`.

## Files

```
harness/ui/
  targets.json            semantic target registry (stable IDs)
  scenarios/<area>/*.json versioned scenarios
  lib/                    runner + adapter interface (types.ts, runner.ts)
  adapters/electron.ts    real-app driver over CDP (Input.dispatch* + uiObserve)
  adapters/gpui.ts        JSON-lines client for the GPUI test host
  evidence/<adapter>/     recorded run results (herdr-t3/ui-evidence v1)
  run.ts                  scenario runner CLI
crates/ui-test-host/      durable GPUI test host (real gpui window + input)
scripts/ui-electron.sh    full-stack launcher: fixture herdr session -> bridge -> vite -> electron -> scenarios
scripts/check-ui-scenarios.ts   validator (CI)
```

## Scenario format v1

```json
{
  "format": "herdr-t3/ui-scenario",
  "version": 1,
  "id": "shell.session-switch-preserves-state",
  "capability": "ui.shell",
  "contract": "ui-shell@1",
  "fixture": "two-workspaces-two-panes",
  "os": ["macos", "windows-11"],
  "steps": [
    { "action": "select", "target": "workspace.item", "params": { "id": "w1" } },
    { "action": "terminal.scroll", "target": "terminal.pane", "params": { "rows": -10 } },
    { "action": "select", "target": "workspace.item", "params": { "id": "w2" } },
    { "action": "select", "target": "workspace.item", "params": { "id": "w1" } },
    { "assert": "state.selected_workspace", "equals": "w1" },
    { "assert": "terminal.scroll_offset", "target": "terminal.pane", "params": { "id": "p1" }, "equals": -10 }
  ]
}
```

- `fixture` names an initial-state fixture (isolated herdr test
  profile; never the user's live session — AGENTS.md §3).
- `action`/`assert` come from the closed vocabularies in
  `scripts/check-ui-scenarios.ts`; `target` must exist in
  `targets.json`.
- `wait` (optional per step): `{ "until": "<assert-id>", "timeout_ms": N }`
  — assertions double as wait conditions.
- Assertions are **semantic**: selected workspace, scroll offset,
  focus location, visibility, enabled state — not pixels. Visual
  quality stays with the existing evidence/visual-review process;
  screenshot comparison (when added) fixes viewport/theme/font/DPI and
  complements, never replaces, structural assertions.

## Status

- **Electron adapter: implemented.** `harness/ui/adapters/electron.ts`
  drives the real app over CDP (`Input.dispatchMouseEvent` for clicks and
  wheel, `Runtime.evaluate` for observation via the read-only
  `window.__herdrT3Ui.observe()` bridge in `src/lib/uiObserve.ts`). Launch
  the stack with `scripts/ui-electron.sh`, which seeds an isolated herdr
  fixture session — never the user's live session (AGENTS.md §3).
- **GPUI adapter: implemented.** `crates/ui-test-host` is a durable test
  host (not a throwaway demo): a real gpui window view with
  `debug_selector`s matching the semantic targets, driven through
  `TestAppContext` input simulation (`simulate_click`, `ScrollWheelEvent`
  over `debug_bounds`). `harness/ui/adapters/gpui.ts` speaks JSON-lines
  over stdio; `UI_INJECT_FAULT` mirrors the Electron fault names.
- **Same scenarios, same verdicts.** `bun harness/ui/run.ts --adapter
  electron|gpui` replays every scenario on both implementations and
  records `herdr-t3/ui-evidence` v1 files under `harness/ui/evidence/`.
- **Fault-injection proven.** `--inject-fault scroll-not-preserved` and
  `--inject-fault selection-lost` make the session-switch scenario FAIL
  on both adapters while unrelated scenarios still pass — the harness
  detects real misbehavior rather than rubber-stamping. The readiness
  gate (`scripts/check-migration-readiness.ts`, `ui-conformance`) requires
  committed PASS evidence for every scenario on BOTH adapters plus FAIL
  evidence for both faults before it reports PASS.
- **Observation note.** Terminal scroll offsets are read from herdr's
  `pane.scroll.offset_from_bottom` via `session.snapshot` — herdr owns
  scrollback and `AttachScroll` moves the pane viewport server-side; the
  local ghostty engine on an attach client never scrolls its own
  viewport, so local engine state cannot observe it.
