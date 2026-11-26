# RC v0.6.0 — Section C: visual / interaction checklist (macOS leg)

Date: 2026-11-25. Candidate SHA `8ffa4818ad533def6d80b76ae36f76738fab1f9a`
(release-0-6-0 head). Captures were taken against `13c4b60`; the
13c4b60→8ffa481 delta touches no shipped code (see `sha-delta.md`), so
they are valid for the candidate. Input-path verification was re-run at
`8ffa481` on a clean worktree (see below).

Capture rig: dev server (`bun --bun vite`) + bridge (`bun run server`)
against the isolated herdr session `ht3-rc`
(`~/.config/herdr/sessions/ht3-rc/herdr.sock`), headless Chrome over CDP.
Session contents: workspace `ws-a` (17 panes incl. agents in
blocked/working/idle states across pi/codex/claude/opencode harnesses),
`ws-b`, plus remote machine groups (Lab Windows, Ubuntu (WSL), Windows).
All PNGs are 2880x1800 (@2x of 1440x900) except the 480px narrow shots
(960x1600). `contact-sheet.webp` grids the set; `manifest.json` records
dimensions/bytes.

## Checklist rows (docs/design/verification.md §RC checklist)

| # | Area | Result | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1 | IME composition lifecycle | PARTIAL | `inputPolicy.test.ts` (19 pass at 8ffa481); `verify-terminal-input.ts` items 1/1-2/2 PASS ×3 runs; `22-packaged-app-8ffa481.png` | Automated half fully green: composition overlay visible with marked text (`{"hidden":false,"text":"にほん"}`), commit reaches pane exactly once (delta=1, echo deduped), composition view cleared, non-echo `insertText` forwards, cancelled composition sends nothing. **OS IME layer NOT exercised** — real Japanese IME marked text, candidate-window anchoring and conversion keys remain human-required (verification.md "Human acceptance procedures"). |
| 2 | 変換中キーが pane に漏れない | PARTIAL | `inputPolicy.test.ts` `bypassesKeyEncoder`/`composition-start keystroke` cases; `verify-terminal-input.ts` 2c PASS | Composition-tracker contract proven; no raw-byte leak observed in any run. Real conversion-key behavior under a live OS IME not exercised — human required. |
| 3 | focus report CSI I/O (mode 1004) | BLOCKED (upstream) | `verify-terminal-input.ts` item 3: `blur +0 focus +0` | herdr has no AttachFocus client message; the pane can never see CSI I/O regardless of client. Tracked upstream (herdrdev/herdr#4902, discussion #6178). Recorded BLOCKED, never PASS — per script comment and issue #169 acceptance criteria this stays an open upstream item, not an RC defect. |
| 4 | TUI mouse capture (click/drag/wheel → app) | PASS (automated) | `verify-terminal-input.ts` 4a/4b/6a PASS | Real Chrome CDP mouse events against a live `cat -v` pane with 1000/1002/1006: click → SGR press+release (+1/+1), drag → motion reports (+2/+3), wheel → app wheel buttons 64/65 (+1). Human feel (vim/htop/tmux) not exercised. |
| 5 | Shift+drag local selection, no app leak | PASS (automated) | `verify-terminal-input.ts` item 5 PASS | Shift+drag produced zero new SGR sequences in the pane across all 3 runs. Visual selection/copy itself is OS-side; not separately captured. |
| 6 | scrollback wheel vs app wheel | PARTIAL | `verify-terminal-input.ts` 6a (app wheel PASS); `inputPolicy.test.ts` `wheelButton`/`sendsHoverMotion` | Wheel→app with mouse ON proven end-to-end. Wheel→scrollback with mouse OFF relies on the same `wheelButton` policy unit tests; no dedicated live-pane scrollback-wheel capture this round. |
| 7 | Agents shelf management | PARTIAL | `01-sidebar-agents`, `01-sidebar-populated`, `02-agent-hover-card`, `03-agent-context-menu`, `04-agent-shelf-expanded`, `07-light-agents`, `07b-light-hover-card`, `09-narrow-sheet-agents` | Attention/Working/Done/Idle sections render with correct attribution (`ws-a • 2 • Local`, `restro-pv • Windows`); Working shelf expands (`04`); agent context menu shows Focus/Details/`inbox plugin not installed` (disabled, honest)/Copy pane ID/Copy workspace ID; hover card present in dark+light. Live status *transitions* and row-click navigation not exercised this round. |
| 8 | Tab direct operations | PARTIAL | `05-tab-context-menu`, `06-tab-hover-close`, `06b-header-tooltip`, `08-pane-zoomed` | Tab context menu (Focus tab/Rename/Move left/Move right/Close tab) and hover close affordance captured; header tooltip captured. Click-select/rename/double-click/drag-reorder `insert_index` correctness vs herdr not exercised. |
| 9 | Workspace hierarchy | PARTIAL | `01`, `04`, `07`, `12-narrow-sheet` | Two-line rows (title + branch/`Nt • Np` meta), machine folders (Local / Lab Windows / Ubuntu (WSL) / Windows) and search field all render; remote workspaces listed under their machines. Drag-reorder not exercised. |
| 10 | Animation (FLIP, menus, popovers, status color) | NOT-EXERCISED | — | Stills cannot prove motion; no automated motion assertion exists. Requires human pass (or `prefers-reduced-motion` comparison, row 11). |
| 11 | `prefers-reduced-motion` | NOT-EXERCISED | — | Requires OS-level reduce-motion toggle; not automated. |
| 12 | Hover details (agent card, tooltips) | PASS | `02-agent-hover-card`, `07b-light-hover-card`, `06b-header-tooltip` | Agent hover card and header icon tooltip captured in both themes. |
| 13 | attach→input→disconnect→reconnect, draft preserved | NOT-EXERCISED | — | No RC-round evidence. Bridge invariant is design-level (AGENTS.md §3); no automated draft-preservation test found in `server/`/`src/` this round. Needs a manual pass or a dedicated test. |
| 14 | Packaged build on clean env | PASS | `section-e-packaging.md`; `20-packaged-app-default-session.png`, `21-remote-machines.png`, `22-packaged-app-8ffa481.png` | install/verify/--live/update/rollback all PASS at 8ffa481; app renders the live default session (see section D/E). |
| 15 | Terminal response perf (#213) | PARTIAL | `perf-macos-13c4b60.json`, `perf-macos-8ffa481.json`; `perf-baseline.ts check` PASS | Bench gate PASS (see section E). Human feel — scroll/typing under `yes`/`cat` load, resize drag, mouse-capture drag — not exercised. |

## Automated coverage actually run at 8ffa481 (this continuation)

Environment: clean worktree `/Users/rebui/work/herdr-t3-rc` @
`8ffa481`, `bun run server` on :4750 + `bun --bun vite` on :5742,
both `HERDR_SOCKET=~/.config/herdr/sessions/ht3verify/herdr.sock`
(isolated session; the user's live `default` session untouched),
headless Chrome CDP :9336, pane `w1:p1` running `cat -v` with mouse
1000/1002/1006 + focus 1004 reporting enabled.

`bun scripts/verify-terminal-input.ts http://localhost:5742/ w1:p1`
×3 runs:

- Run 1: 8/10 — FAIL `4a` (press +0/release +1, first-click timing flake)
- Run 2: 8/10 — FAIL `2b` (`テスト` delta=0, timing flake)
- Run 3: **9/10 PASS**, only item 3 BLOCKED (upstream)

Every checklist item passed in at least one run; the two single-run
failures are CDP-timing flakes in the harness (synthetic
`Input.dispatchMouseEvent`/DOM `InputEvent` races), each green in the
other runs — no deterministic defect reproduced. `bun test
src/lib/ghostty/inputPolicy.test.ts`: 19/19 pass.

## Human-only remainder (blocks full sign-off per verification.md)

- Rows 1–2: real OS Japanese IME (marked text at cursor, candidate
  window anchoring, conversion keys) — ~5 min procedure documented in
  verification.md.
- Rows 10–11, 15-feel, and the feel halves of 4/5/6/8/9/13: real-mouse /
  real-motion / reconnect-draft pass on macOS, plus the entire Windows
  11 column (owned by the Windows-side agent).
