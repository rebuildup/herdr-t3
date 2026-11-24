# 情報設計 (v0.4.0 正本)

herdr-t3 の各 surface が「何を」「なぜ」表示するかの正本。情報を増やすのでは
なく、作業中の判断・操作に必要な情報を正しい優先順位で置き、内部 ID や診断
情報は必要時に参照できる構成にする。

## 1. Surface の役割

| Surface | 役割 | 置く情報 | 置かない情報 |
| --- | --- | --- | --- |
| Sidebar (workspace list) | 「どの workspace に注意/作業があるか」の一覧・選択・並び替え | workspace の人間向け識別名 (label/branch/repo)、集約 agent_status、tab/pane 数、接続状態 (machine offline 等) | pane/tab の詳細、内部 ID の常時表示 |
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
