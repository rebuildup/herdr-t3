# Contract: workspace / tab / pane operations (B2→B3)

Version: 1. Scope: the herdr RPC surface the client drives —
`workspace.*`, `tab.*`, `pane.*`, `layout.*`, `agent.*`, `worktree.*`
(`RPC_METHODS` in `shared/protocol.ts`) — and the snapshot-derived views
the UI renders (`src/shell/*`, `src/lib/workspace.ts`).

## Operations

- Workspace: `workspace.create/focus/close/rename/move` + list via
  snapshot. Close may require confirmation when panes remain
  (`confirmCloseWorkspace` setting).
- Tab: `tab.create/focus/close/rename/move`; per-tab agent status and
  label resolution.
- Pane: `pane.split/close/focus/rename/zoom/move/swap/resize/scroll/
  clear/send_text/send_keys`, `layout.set_split_ratio`,
  `pane.focus_direction`, `pane.process_info`, `pane.link.resolve/
  activate`.
- Agent: `agent.get/prompt/rename/start/read/explain` — prompt answers
  only via the prompt API.
- Worktree: `worktree.list/create/open/remove` (UI: WorktreesDialog).

## Ordering and semantics

- All mutations are RPCs answered by `rpc_result`; the UI updates from
  subsequent `snapshot`/`event` frames, never from assumed local
  success.
- Ordering-sensitive operations (move/swap with `insert_index`, split
  ratios) must match herdr's semantics exactly — the client computes
  pre-removal indices (`src/lib/reorder.ts`) and the result is verified
  against the returned snapshot.
- Derived views are pure functions of the snapshot: agent shelves
  (Attention→Working→Done→Idle + organize overlays), workspace title
  fallback chain (label → worktree repo → id), pane title fallback
  (stripped terminal title → pane metadata), goto rows. Same snapshot
  in → same view out.
- Single-tab workspaces hide the tab label; multi-machine snapshots are
  namespaced by `machine` and never merged.

## Malformed input (projection adapter boundary)

- `deriveWorkspace` assumes the snapshot carries `workspaces`,
  `layouts` and related arrays. On sparse or non-object snapshots the
  TS implementation throws (`snapshot?.layouts.find` on a missing
  `layouts`); the Rust port returns an empty workspace projection.
  Contract-conforming herdr snapshots always include these arrays, so
  the divergence is unreachable in production — documented as
  intentional (#288), not mirrored.

## Errors

- RPC failure → `rpc_result.ok=false` with herdr's code; UI surfaces a
  notice, does not silently retry mutations.
- Stale machine/pane/tab ids (snapshot moved on) → error surfaced;
  client must not fabricate the object.
- `pane.process_info` requires `pane_id`; using `target` silently
  answers for the focused pane (forbidden — AGENTS.md §3).

## Negative cases

- local state mutation without a corresponding snapshot change being
  treated as success;
- cross-machine id collisions merged into one view;
- guessed digit-key answers to agent prompts;
- organize overlay (settle/snooze) diverging from plugin state —
  plugin is authoritative (ADR-0011).

## Evidence today

`src/shell/agents.test.ts`, `attention.test.ts`, `goto.test.ts`,
`git.test.ts`, `worktrees.test.ts`, `view.test.ts`,
`src/lib/workspace.test.ts`, `paneOrder.test.ts`, `reorder.test.ts`;
`server/herdr.test.ts` for transport. UI-level scenarios: #238.
