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

## Status (honest record — do not overstate)

- **Electron adapter: not yet implemented.** Requires a driver
  decision (CDP vs Playwright vs accessibility tree). Scenarios are
  currently spec-only; the validator keeps them well-formed.
- **GPUI adapter: not built.** No GPUI test host exists in this repo;
  per #238 acceptance, the "same scenario runs on a minimal GPUI test
  host" evidence is **absent** and both-OS GPUI verification is
  **unproven** — the UI conformance gate stays **BLOCKED** in the
  readiness check (#241) until a spike produces that evidence.
- Fault-injection coverage (focus loss, state not preserved, clipping)
  is expressed as negative scenarios once adapters exist; until then
  only format validation runs in CI.
