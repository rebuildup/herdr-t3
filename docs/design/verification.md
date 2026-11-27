# T3 design fidelity verification (Issue #4)

T3 Code (`t3code` @ `9cc4018c75ff4c61be8e86a6391d49a6c2d79830`, see
`docs/upstream.md`) is the design source of truth. Fidelity is verified at
two levels; screenshots alone are not sufficient.

## 1. Component / token comparison

For every UI surface, compare against the pinned T3 implementation:

- primitives: `src/components/ui/` vs `t3code/apps/web/src/components/ui/`
- tokens: `src/index.css` custom properties vs T3's theme tokens
- layout/density: sidebar width, row padding, tab strip height, pane chrome

Record each comparison in the ticket PR or `docs/design/evidence/` notes:
what matches, what deviates, and why (herdr-t3 is a terminal multiplexer,
not a thread UI — deliberate deviations must be justified, not accidental).

## 2. State-by-state screen comparison

Capture real screens from an **isolated herdr test session only** (never
the maintainer's live session). Required states:

| Surface | States |
| --- | --- |
| Sidebar | empty, populated, workspace selected/hover, context menu open, drag-reorder indicator, offline machine group |
| Tab strip | single tab, multiple tabs, active/inactive, hover close, context menu, per-tab agent status, drag-reorder indicator, overflow scroll |
| Pane grid | single pane, split panes, focused/unfocused (dimmed unfocused per `interaction.md`), zoomed, split-ratio drag, pane drag/swap affordance |
| Pane chrome | agent kind + status indicator, title fallback chain, details/diagnostics access |
| Status/utility area | bridge connecting/reconnecting, attention aggregate (blocked count), transient notice |
| Canvas session states (issue #421, `info-architecture.md` §10) | cold-start loading, probe→live transition, machine fetch error + Retry, machine down + Reconnect, disabled machine, genuine empty session (`workspaces: []`) + New workspace, anomalous pane-less tab |
| Terminal | idle shell, running agent, blocked prompt, scrollback, background image (fit/position/opacity variants), IME composition |
| Global | light, dark (`html.dark`), connecting, reconnecting, offline, error, `prefers-reduced-motion` |

v0.4.0 additions (issues #107–#115): every new interactive surface added by
the program must appear here before its ticket merges; drag states and
status badges are required captures, not optional.

v0.5.0 additions (issues #149–#155):

| Surface | Additional required states |
| --- | --- |
| Terminal input | IME composition in progress (composition text visible at cursor, candidate window anchored), committed/cancelled composition, focus-report-enabled app focus transitions, mouse-capture app click/drag/scroll/hover, Shift+drag selection inside a mouse-capture app, scrollback wheel vs app wheel |
| Agents section | each status section (Attention/Working/Done collapsed/Idle), two-line row content, section transitions on status change, context menu open |
| Tab strip | hover close affordance on unselected tab, context menu open, selected/hover/focus-visible distinction, direct split/zoom icons |
| Workspace rows | two-line hierarchy (title + branch/meta), narrow sheet width |
| Global | motion enabled vs `prefers-reduced-motion` for list add/move/remove and menu/popover transitions |

Contract-level coverage (issue #155) is separate from captures: IME
composition lifecycle, focus in/out reports, mouse-mode event sequences
and selection-vs-report branching are verified by deterministic tests
defined in `terminal-io.md` §7 — a screenshot cannot prove them.

Procedure:

```bash
# isolated herdr session (see server tests for HERDR_* isolation vars)
herdr --session ht3verify ...
HERDR_SOCKET=~/.config/herdr/sessions/ht3verify/herdr.sock PORT=<port> bun run server
bun run build
# drive http://127.0.0.1:<port>/ with Playwright; save PNGs under
# docs/design/evidence/<ticket>/ and note the herdr-t3 SHA + t3code SHA
```

Compare each capture side-by-side with the equivalent T3 screen (or the
T3 component in isolation) and record the verdict per state.

## RC verification checklist (issue #155)

Release-candidate gate: run on **both macOS and Windows 11** against an
isolated herdr session. Every row must be exercised by hand; an
unverified row blocks the release — "not checked" is not a pass.
Automated contract tests cover the deterministic halves
(`terminal-io.md` §7.1); this list covers what only a real OS + real IME +
real TUI can prove.

| # | Area | macOS | Windows 11 | Notes |
| --- | --- | --- | --- | --- |
| 1 | IME composition: 変換開始 → 変換中文字がカーソル位置に見える → 確定で1回だけ pane へ → 取消で0回 → 連続2回の独立 commit | ☐ | ☐ | 日本語 IME。候補ウィンドウが端末カーソル直下に出ること |
| 2 | 変換中キー (Enter 確定 / 矢印 / Esc) が pane に漏れない | ☐ | ☐ | 変換中アプリ (vim 等) で確認 |
| 3 | focus report: mode 1004 を有効化した pane で pane↔GUI chrome のフォーカス移動に CSI I/O | ☐ | ☐ | `printf '\e[?1004h'` 系のテスト pane |
| 4 | TUI マウス: mouse capture 中のクリック/ドラッグ/ホイールがアプリへ届く (vim/neovim, htop, tmux 等) | ☐ | ☐ | |
| 5 | mouse capture 中の **Shift+drag ローカル選択** とコピー | ☐ | ☐ | 選択が pane に送られないこと |
| 6 | scrollback wheel (mouse OFF) と app wheel (mouse ON) の切替 | ☐ | ☐ | |
| 7 | Agents 管理: Attention/Working/Done/Idle shelf の識別・折りたたみ・状態遷移・行クリックで workspace+pane へ移動・context menu (Focus/Details/Copy IDs)・ホバー詳細カード | ☐ | ☐ | agent 状態を実際に遷移させて確認 |
| 8 | タブ直接操作: クリック選択・hover close・ダブルクリック rename・context menu (Focus/Rename/Move/Close)・ドラッグ並び替え | ☐ | ☐ | insert_index の位置が herdr と一致 |
| 9 | ワークスペース階層: 2行行 (title+branch/meta)・machine folder・ドラッグ並び替え・検索 | ☐ | ☐ | |
| 10 | アニメーション: 一覧の追加/移動/消失 FLIP・shelf 開閉・menu/tooltip 出現・agent 状態遷移の色変化 | ☐ | ☐ | |
| 11 | `prefers-reduced-motion`: 上記すべてが即時切替 (アニメーションなし) | ☐ | ☐ | OS 設定で reduce を有効化 |
| 12 | ホバー詳細: agent 行ホバーカード・workspace/tab の tooltip | ☐ | ☐ | |
| 13 | 包括 E2E: attach→入力→切断→再接続で入力が draft に残り自動送信されない | ☐ | ☐ | bridge invariant。`bun scripts/verify-reconnect-draft.ts --session <isolated>` (CDP、bridge kill→再起動で draft 残存・outage 入力の不達・明示 Enter での送信を検証)。Windows レグ自動化 PASS (6/6): `docs/design/evidence/rc-v060/section-n-windows.md` |
| 14 | 配布物: packaged build がクリーン環境で起動・接続・上記主要操作 | ☐ | ☐ | rebuildup/pc-setup 成果物 |
| 15 | ターミナル応答性能 (#213): 大量出力 pane (`yes`/`cat` 大ファイル) でのスクロール・タイピング体感、ウィンドウリサイズ中のカクつき (resubscribe/resize RPC がドラッグ中に集中しないこと)、mouse capture app でのドラッグ・ホイール追従 | ☐ | ☐ | 体感確認のみ。before/after の主観比較を Notes に記録 |
| 16 | Canvas session 状態 (#421, info-architecture.md §10): cold start の Loading 表示中に "No workspaces" が出ないこと、最後の workspace/pane を閉じた後の真の空状態 + New workspace 回復、machine 切断時の Reconnect、fetch 失敗時の Retry、disabled machine の Open Connections | ☐ | ☐ | 隔離 session で `workspace.close`/`pane.close` を実行して確認 |
| 17 | ブロックカーソル描画 (#382, terminal-render.md §Cursor): 通常文字・ANSI 色・inverse・全角・結合文字・空セル・選択範囲上で cursor セルが不透明 fill + cursor-text 色の文字再描画になること (半透明 wash でない)。`cursor-color`/`cursor-text` (色・`cell-foreground`/`cell-background` キーワード) が Ghostty config から反映されること。bar/underline カーソル形状・点滅・非フォーカス時の退行がないこと | ☐ | ☐ | 実機の視覚評価は #413 RC に集約。contract/harness は `terminal.scene-cursor` scenario が固定 |
| 18 | Agents 棚 (#418): Working 初期4件・段階開示 (Show more)・固定トグルと一覧スクロールの分離・複数棚展開・狭幅/低高さでトグルが行スクロールに巻き込まれない | ☐ | ☐ | |
| 19 | Agent identity/status (#419): 左端ブランドアイコン + 外周ステータスリングの統合表示、全状態/テーマ/密度で重複表示なし | ☐ | ☐ | |
| 20 | Windows アニメーション (#420): motion 許可・前景可視で Working/進行中アニメーションが実際に動く (時系列で確認、静止画不可)。画面外・折りたたみ・非表示・reduced-motion で停止/復帰 | ☐ | ☐ | Windows leg 必須。Settings → Diagnostics の 'Motion visibility gate' Copy report を証跡に添付 |
| 21 | 通知 UX (#428): 右上既定・配置設定・WCO/traffic-light 回避・複数通知の積み上げ・情報階層・アクション・テーマ・狭幅 | ☐ | ☐ | Windows leg で WCO 領域との非干渉を確認 |
| 22 | 構造化コピー (#429): 報告メッセージ/範囲候補から選択してコピー、TUI 整形ノイズ (余白) なし・構造保持。対象不明/不完全時の挙動 | ☐ | ☐ | `docs/design/report-copy.md` の契約と照合 |
| 23 | Terminal canvas 外観 (#432): ペイン境界の視覚的強調抑制・外周余白、単一/分割/zoom・フォーカス・両OS/テーマ/背景/狭幅・split 操作 | ☐ | ☐ | |
| 24 | 選択ドラッグの自動スクロール (#433): 上下端でドラッグ保持→複数画面 scrollback を連続選択、逆方向・停止・実コピー内容一致 | ☐ | ☐ | |
| 25 | ペースト配送 (#434/#478): 対応 TUI (bracketed paste mode on) で複数行が一括入力、mode off/on 切替・再接続・LF/CRLF・Unicode・末尾改行の保持・意図しない行ごと確定なし | ☐ | ☐ | `pane.send_input` 経路。実 pane の受信バイト列を証跡に |
| 26 | 入力フォーカス handoff (#435): GUI で workspace/tab 選択・新規作成・切替後、再クリックなしで対象 focused pane に入力可能。連続切替・複数 pane/machine・rename/search/dialog で誤入力/フォーカス奪取なし | ☐ | ☐ | |
| 27 | 選択ハイライトのスクロール追従 (#436): 選択文字列を上下スクロールで画面内→外→内へ移動し、ハイライトとコピーが対象文字に一致 (実 herdr attach 経路) | ☐ | ☐ | |
| 28 | copy-on-select (#440): 設定 ON/OFF・永続化・選択確定時のみ正確な OS clipboard 書込み・通常コピーとの共存 | ☐ | ☐ | |
| 29 | 選択オーバーレイ motion (#441): 選択開始/伸縮/確定/解除・コピー成功時の短い overlay motion、scroll 追従・reduced-motion・非表示時停止 | ☐ | ☐ | 動的証跡 (録画/連続キャプチャ) で評価。静止画で代替しない |

Rows 18–29 are the #407 program tickets (#418–#441); the authoritative
acceptance wording lives in issue #413 and each ticket issue. Evidence
for the 0.7.0 train goes to `docs/design/evidence/` under the RC
candidate's own directory — do not reuse 0.6.0 captures.

### Human acceptance procedures

Automated coverage already proves the deterministic halves: the IME
composition lifecycle byte contract (commit exactly once, cancel zero,
no mid-composition leak, independent consecutive commits) is covered by
`src/lib/ghostty/inputPolicy.test.ts`, and the live attach-path checks
(composition overlay visible, commit dedupe, non-echo `insertText`,
cancel sends nothing) run in `scripts/verify-terminal-input.ts` items
1–2. Focus-report and TUI-mouse rows above are likewise automated where
the upstream protocol allows (`terminal-io.md` §5.4, §7); only the OS
boundary remains manual.

The only steps that genuinely require a human are the OS IME layer
(marked text rendering, candidate-window anchoring, real conversion
keys) — rows 1–2. Minimal procedure per OS (~5 minutes):

1. Launch the release candidate against an isolated herdr session
   (`HERDR_SOCKET=~/.config/herdr/sessions/<isolated>/herdr.sock`) and
   open a pane running `cat -v`.
2. Enable the OS Japanese IME (macOS: ひらがな input source; Windows:
   Microsoft IME 日本語モード) and click into the terminal surface.
3. Type `nihon` + 変換: the marked (変換中) text must render at the
   terminal cursor position, and the candidate window must anchor
   directly under the cursor — not at the window corner or invisible.
4. 確定 (Enter or candidate click): the text reaches the pane exactly
   once — `cat -v` echoes it a single time.
5. 取消 (Esc while composing): nothing reaches the pane.
6. 連続入力: two commits in a row produce two independent insertions
   with no duplicated text.
7. 変換中キー: while composing, arrow keys / Enter / Esc must not leak
   raw bytes — `cat -v` shows no `^[` sequences or stray characters.

A failure on any step blocks the release; record OS version, IME, app
SHA and a screen recording in the ticket.

## Evidence

`docs/design/evidence/` holds baseline captures. `baseline-*.png` is the
current scaffold-era layout (sidebar + tab strip + pane grid, dark/light)
captured against the isolated `ht3probe` session at the time of writing —
it is a starting point for diff review, not a fidelity claim.

### Capture and review pipeline (issue #69)

- `bun scripts/capture-evidence.ts <outDir> [baseUrl]` drives headless
  Chrome over CDP against the dev build and an isolated herdr session.
  Every state is asserted before the PNG is saved: DOM checks for sidebar
  collapse, palette, context menus, themes and the mobile sheet; session
  facts (`/api/session` layout `zoomed`, pane counts) for split/zoom.
- `python3 scripts/build-evidence-sheets.py docs/design/evidence/<ticket>`
  converts raw PNG captures to committed WebP (q88) originals, builds
  labeled contact sheets, side-by-side herdr-t3 vs T3 Code comparisons at
  matched viewport/theme, and detail crops. Raw PNGs are gitignored local
  artifacts; `manifest.json` records dimensions and byte sizes.
- T3 Code reference captures come from the pinned checkout's dev server
  on an isolated `--home-dir` seeded by `vp run migrate-dev-db`, paired
  with a one-time token.
- Multimodal review: `codex exec --sandbox read-only -i <image> -` with a
  review prompt (see issue #69 for the prompt text) evaluates layout,
  spacing, density, hierarchy and affordances against the T3 reference.
  A separate pass checks full-resolution captures for sensitive strings
  before publishing.
