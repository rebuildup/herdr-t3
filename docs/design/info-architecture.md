# 情報設計 (v0.4.0 正本)

herdr-t3 の各 surface が「何を」「なぜ」表示するかの正本。情報を増やすのでは
なく、作業中の判断・操作に必要な情報を正しい優先順位で置き、内部 ID や診断
情報は必要時に参照できる構成にする。

## 1. Surface の役割

| Surface | 役割 | 置く情報 | 置かない情報 |
| --- | --- | --- | --- |
| Sidebar (workspace list) | 「どの workspace に注意/作業があるか」の一覧・選択・並び替え | workspace の人間向け識別名 (label/branch/repo)、集約 agent_status、tab/pane 数、接続状態 (machine offline 等) | pane/tab の詳細、内部 ID の常時表示 |
| Sidebar (agents 一覧, v0.5.0) | 「どこで・何の作業が・どの状態か」の動的一覧 (§6) | agent_status セクション、帰属 (machine/workspace/tab)、状態ラベル、作業対象 (terminal_title/agent 種別) | エージェントツール名を最上位にしない、内部 ID |
| Workspace header (breadcrumb + tab strip) | 「今どの workspace/tab を見ているか」と tab 操作 | machine › workspace 名、tab 一覧 (label + status + zoom)、pane 操作 (split/zoom/swap/close) | 内部 ID、診断詳細 |
| Pane chrome (canvas 内) | 「この pane は何で・どの状態か」の最小表示 | 必要時のみ: pane title/agent 種別/status の控えめな表示、focus 表現、split 境界 | 常時のラベル行で canvas を削ること、過剰な枠線 |
| Status/utility 領域 | 「システム全体の状態と操作」(endpoint 状態、通知、モードヒント相当) | bridge/connection 状態、集約 attention (blocked agent 数)、update/診断への導線 | — |
| 詳細/診断 (tooltip, context menu, settings, palette) | ID・cwd・process・revision 等の内部情報 | workspace_id/pane_id/tab_id、cwd、foreground_cwd、agent_session、scroll offset、layout JSON | — (ここが内部情報の置き場) |

原則: **一覧は発見、タブは文脈、ヘッダーは操作、詳細は参照**。同じ情報を
複数 surface に常時重複表示しない。

## 2. 情報の優先順位

人間が作業中に判断する順:

1. **接続先 (machine)** — 切断中に入力しても届かない。sidebar group header /
   header breadcrumb / status 領域で常時判別可能にする。
2. **アクティブ対象** — focused workspace/tab/pane。選択表現は視覚体系
   (interaction.md) に従う。
3. **実行状態 (agent_status)** — working/blocked/done/idle/unknown。
   blocked は「人間の応答待ち」で最優先の attention。workspace 集約 → tab →
   pane の順に伝播させる (herdr の `aggregate_state` と同じ意味論)。
4. **人間向け識別名** — Git branch > workspace label > repo 名 >
   terminal_title > 内部 ID の順で表示名を決める。内部 ID
   (`workspace_id`/`pane_id`/`tab_id`) は既定で表示しない。
5. **補助情報** — tab/pane 数、zoom、scroll offset、cwd、process 名は
   tooltip/context menu/詳細 panel へ。

### 表示名の解決規則

- **Workspace**: `custom label` > `worktree branch` (#109 で `worktree.list`
  照合により取得) > `worktree repo_name` > `label` (herdr が cwd から導出した
  repo/dir 名) > `workspace_id` (最終 fallback、通常は到達しない)。
  `workspace_id` を主表示にしない。
- **Tab**: `label` (rename/custom) > focused pane の `terminal_title_stripped`
  > `tab_id` は fallback のみ。
- **Pane**: `terminal_title_stripped` > `title` > `label` > `agent` 種別 >
  `pane_id` は fallback のみ。

## 3. ブランチ情報の取得経路 (#109)

`WorkspaceInfo`/`PaneInfo` の JSON snapshot に branch field はない
(`tokens` は metadata tokens のみ)。herdr は `cached_git_branch` を
server-side に持ち、client-shell では sidebar token として描画する。
JSON API 経由では:

- **worktree-backed workspace**: `worktree.list` の各 entry が `branch` と
  `open_workspace_id` を持つ → `open_workspace_id == workspace_id` で照合。
- **非 worktree の git cwd workspace**: `worktree.list` は repo の全
  worktree を返すため、`checkout_path` と workspace/pane の cwd から
  最長一致で branch を引ける。照合は bridge 側で行い、renderer には
  解決済みの表示名/branch を渡す。
- **git 管理外**: branch なし。repo/dir 名のみ。

bridge 拡張: `worktree.list` を `RPC_METHODS` に追加し、snapshot 受信時に
machine ごとの worktree 一覧を cache して workspace→branch を解決する。
詳細は #109 の実装で確定する。

## 4. agent_status の可視化配分 (#110)

| 場所 | 表示 |
| --- | --- |
| Sidebar workspace row | 集約 status icon (既存) + 必要なら blocked 時の強調 |
| Tab strip | tab ごとの status icon (herdr `TabInfo.agent_status`) |
| Pane chrome | agent 種別 + status の控えめな indicator (focused pane のみ詳細、他は icon) |
| Header | focused pane の status badge (既存を拡張: agent 名・状態・応答導線) |
| Status 領域 | 「blocked N 件」等の attention 集約 |

`state_labels` (pane/agent が持つ状態別カスタム label) は tooltip/詳細で
参照可能にする。表示は herdr の `AgentStatus` 5値
(idle/working/blocked/done/unknown) に限定し、独自の状態を捏造しない。

## 5. 内部情報の置き場

`workspace_id`/`pane_id`/`tab_id`/`terminal_id`/`cwd`/`foreground_cwd`/
`agent_session`/`scroll`/`layout` JSON/`revision` は:

- pane context menu または header overflow の「Details」で表示
- command palette の検索対象 (ID でも引ける)
- diagnostics/settings 画面

既定 UI に ID を出さない。例外: connection error 等で ID が診断に必要な
場合のみ status 領域に併記する。

## 6. Agents ワークサーフェス (v0.5.0 正本, Issue #151)

herdr 本家の agent sidebar (`src/client/shell/agent_sidebar.rs` +
`src/ui/sidebar/tokens.rs` @ `e8d7d97`) を情報設計の基準とし、T3 Code の
settle/inbox 型の動的一覧管理を herdr の実状態へ写像する。

### 6.1 行モデル — herdr token 行準拠

herdr の `AgentsSidebarConfig` default rows:

- **行1**: `state_icon` + `machine` + `workspace` + `tab`
- **行2**: `agent` (エージェント種別/表示名)

herdr-t3 の agent 行はこの2行構造を採用する (機械的な token 設定 UI は
作らない — GUI は固定の情報階層を持つ)。各行の内容:

| 行 | 内容 | 優先順位 |
| --- | --- | --- |
| 1 | status icon + workspace 識別名 (§2 の解決規則) + tab label (workspace が複数 tab を持つ時のみ) + machine (複数台時のみ) | 「どこで」— セクション名が状態を担うため attribution を primary weight に置く (issue #165) |
| 2 | 状態テキスト (state_labels 解決値) + agent 種別/表示名 (display_agent > name > agent > title) + 作業対象 (`terminal_title_stripped` > `terminal_title` > `title`) + 補助 state label + pane 短縮 ID (描画結果が同一の兄弟行がある時のみ) | 「どの状態で・何の作業か」— ツール名はここに留める |

### 6.2 状態セクション — T3 settle/inbox の写像

T3 Code の sidebar は pinned / inbox(active) / working shelf / snoozed /
settled shelf に分割し、settle は「ユーザーが完了とみなした thread を
棚へ畳む」操作、inbox は「注意が戻った thread を return 順に並べる」
仕組み (`packages/client-runtime/state/threadSettled.ts`,
`threadInbox.ts`, `apps/web/src/components/Sidebar.tsx` @ `9cc4018`)。

herdr-t3 は **herdr `AgentStatus` を唯一の実行状態源**とする。
エージェントの実行状態 (working/blocked/done/idle) をクライアント側で
捏造・改変しないが、**ユーザー側の作業整理状態 (settle/snooze) は
独立した UI 層の状態として保持してよい** (v0.5.0 再評価で明確化:
T3 の settle/inbox は「ユーザーが完了とみなす/後で見る」の整理操作で
あり、実行状態の主張ではない)。写像:

| herdr `agent_status` | セクション | 根拠 |
| --- | --- | --- |
| `blocked` | **Attention** (最上位、常時展開・折りたたみ不可) | T3 の「人間の応答待ち」= inbox の最優先。herdr の status_priority でも最上位 |
| `done` | **Done** (常時展開・折りたたみ不可) | T3 の active list の一部 — エージェント完了はユーザー整理状態ではないため棚に畳まない |
| `idle` / `unknown` / 未知の status | **Idle** (常時展開・折りたたみ不可) | 同上。要対応でない残りも active list に含める |
| `working` | **Working** (下部 shelf、折りたたみ可、既定は折りたたみ) | T3 の working shelf と同じ位置・既定値 |

- セクション順は T3 の SidebarSection と同じ構造: 常時表示リスト
  (Attention → Done → Idle) が先、working → snoozed → settled の
  折りたたみ shelf が下部に積まれる。T3 の active list に相当する
  Done/Idle は collapse を持たない (T3 の active section に
  disclosure がないのと同じ)。
- セクション内ソート: herdr `AgentPanelSortConfig::Priority` と同じ
  `agent_status` 優先度 + `state_change_seq` 降順 (同順位は新しい状態変化が上、
  `state_change_seq` 欠落時は `revision` で代替、最後は `pane_id` で安定化)。
  T3 inbox の「return 順」は `state_change_seq` の新しい順で近似する —
  herdr に return timestamp はないため独自時刻状態を持たない。
- Working/Snoozed/Settled の折りたたみ状態は T3 の shelf expansion と同様に
  localStorage へ永続化し、**3棚とも既定は折りたたみ** (T3 の
  `useLocalStorage(..., false)` と同じ)。空セクションは header ごと表示しない。
- **ユーザー settle/snooze (UI 層)**: agent 行の context menu
  から Settle / Snooze / Restore を提供し、`machine.id` + `pane_id` +
  操作時点の `state_change_seq` を localStorage
  (`herdr-t3:sidebar:agents:organize`) に保持する。settle/snooze
  された行は対応する棚へ移る (snooze は折りたたみ可・既定折りたたみの
  **Snoozed** 棚、settle は同じく折りたたみ可・既定折りたたみの
  **Settled** 棚 — いずれも棚の展開状態は localStorage に永続化)。
  `state_change_seq` が進んだ時点で自動的に自然なセクションへ戻る —
  T3 の inbox return に相当し、herdr の実状態は一切変更しない。
  表示上の状態バッジは付けず、行の所属棚のみが変わる (実行状態との
  区別を UI 上も明確にする)。snoozed/settled 行はどちらも context
  menu から Restore (記録削除 = 自然セクションへ即復帰) と他方の棚
  への移動が可能 — T3 が snoozed thread を手動 unsnooze 可能な
  Snoozed shelf に保持するのと同じく、片道ドアにしない。
- T3 との差異 (意図的): T3 の snooze は `snoozedUntil` の wall-clock
  時刻指定 + 「承認待ち/新規質問/失敗」等の raised-hand で早期復帰
  する。herdr-t3 は時刻指定を持たず、`state_change_seq` の進行
  (= エージェントの状態遷移) のみで復帰する近似とする。T3 が完了
  した run では snooze を解かないのに対し、こちらは任意の seq
  進行で戻る — herdr には run 完了と状態遷移を区別する信号がない
  ための既知の単純化。snoozed 棚内のソートも T3 の `snoozedUntil`
  昇順ではなく、他棚と同じ status 優先度 + seq 降順。
- `state_labels` (herdr が提供する状態別カスタム label) は行2の状態
  テキスト (現 status の label) と行2末尾の補助 label (status 以外の
  key を持つ custom label) に使う。表示 status は herdr の5値に
  限定する (§4 と同じ規則)。
- Attention セクション header は常時展開のため chevron を持たないが、
  collapsible shelf の count と桁位置を揃えるため chevron 相当の幅を
  予約し、header 自体を warning 色で強調する (issue #165)。

### 6.3 操作

- 行クリック: workspace 選択 + `pane.focus` (既存動作を維持)。
- context menu: Focus / Details (既存 `PaneDetailsDialog` — `agent.read`
  要約・process info・内部 ID) / Copy pane ID / Copy workspace ID。
  三点メニュー・直接操作との役割分担は app-shell.md §4 に従う。
- keyboard: sidebar の list navigation (arrow/Enter) と整合。
- 一覧の追加・移動・消失・セクション折りたたみに FLIP モーション
  (`src/lib/sidebarListMotion.ts` — T3 `Sidebar.motion.ts` 移植、
  `--motion-*` token、reduced-motion では即時切替)。

## 7. Sidebar 行の複数行階層 (v0.5.0 正本, Issue #153)

workspace 行を一行に押し込む設計を廃止し、herdr `SpacesSidebarConfig`
default rows (`src/ui/sidebar/tokens.rs` @ `e8d7d97`) に準拠する:

- **行1**: `state_icon` + workspace 識別名 (§2 解決規則:
  label > branch > repo > dir 名。`workspace_id` は fallback のみで
  既定表示しない)
- **行2**: `branch` + 補助情報 (tab 数 / pane 数 / machine — 複数台で
  group header がない文脈のみ)。git ahead/behind は JSON API に
  `git_ahead_behind` がないため v0.5.0 でも対象外 (herdr-parity.md §2)。

- 狭い画面 (mobile sheet) でも2行構造を維持する。文字サイズの縮小・
  横スクロール・Tooltip への情報退避で可読性を補わない。
- `workspace_id`/`pane_id`/`tab_id` は context menu・Details・
  command palette から参照・コピーできる (§5)。

## 8. タブ strip の操作体系 (v0.5.0 正本, Issue #152)

- タブ行は「選択 = 文脈」の表示に徹し、操作は直接操作と context menu
  の2系統: クリック選択 / double-click rename / hover の close
  affordance (選択・非選択を問わず) / 右クリック context menu
  (Rename / Close / New tab)。drag 並び替えは維持。
- header の三点メニューは pane 固有の低頻度操作 (swap・rename pane・
  prompt・details・worktrees・close tab) に限定し、頻用操作
  (split right/down・zoom) は直接 icon button として露出する。
  直接操作・context menu・三点メニューは相互排他にしない
  (同一操作の複数経路を許容)。詳細は app-shell.md §4。
