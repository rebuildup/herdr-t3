# Herdr 機能契約 (v0.4.0 正本)

herdr が提供する機能のうち、herdr-t3 が「提供する / 保留 (理由付き) / 対象外」と
判定した一覧。正本の優先順位は AGENTS.md §2。bridge の `RPC_METHODS`
(`shared/protocol.ts`) はこの表の「提供」に対応する method のみを許可する。

調査基準: herdr 0.9.5 (`/private/tmp/herdr-src` 相当の upstream)、JSON API
schema (`src/api/schema/`)、client shell (`src/client/shell/`)、および
herdr-t3 `release-0-4-0` 時点の実装。

## 1. JSON API メソッド別の判定

凡例: ✅ 提供 / 🔶 v0.4.0 で追加 / ⏸ 保留 (理由) / ❌ 対象外

### Session / Workspace

| method | 判定 | 備考 |
| --- | --- | --- |
| `session.snapshot` | ✅ | 既存 |
| `workspace.create` / `focus` / `close` / `rename` | ✅ | 既存 |
| `workspace.move` | ✅ #111/#115 | `insert_index` 指定の並び替え。sidebar D&D。**`insert_index` は pre-removal の挿入位置** (現在その index にある要素の前に挿入、`length` は末尾追加)。herdr 0.9.5 で実測確認済み — post-removal と誤解すると後方ドロップが 1 つ手前に着地する |
| `workspace.move_block` | 🔶 #111 | 複数 workspace の一括移動。単一 D&D のみなら不要になる可能性 |
| `workspace.report_metadata` | ⏸ | metadata tokens は agent/外部連携向け。herdr-t3 は読み取り側のみでよい。表示が必要になれば `tokens` は既に `WorkspaceInfo` にある |
| `worktree.list` / `create` / `open` / `remove` | ✅ #114 | herdr ネイティブ worktree。**Worktrunk UI とは別物** (AGENTS.md §5 は Worktrunk を対象外とするが herdr worktree は in-scope)。WorktreesSurface が open/create/remove を提供。`remove` は open 済み linked-worktree workspace の `workspace_id` が必須 (herdr schema) のため、open entry のみ Remove 可 |

### Tab / Pane / Layout

| method | 判定 | 備考 |
| --- | --- | --- |
| `tab.create` / `focus` / `close` / `rename` / `move` | ✅/🔶 | `tab.move` は #111 で D&D 化。`insert_index` の pre-removal 意味論は `workspace.move` と同じ (herdr 0.9.5 実測) |
| `pane.split` / `close` / `focus` / `rename` / `zoom` / `resize` / `clear` | ✅ | 既存 |
| `pane.move` / `pane.swap` | 🔶 #111 | pane D&D・tab 間移動。`destination`/`direction` の schema は `src/api/schema/panes.rs` |
| `pane.scroll` | ✅ | 既存 (scroll offset 取得)。scrollback UI は terminal 側 |
| `layout.set_split_ratio` | 🔶 #111 | split 境界のドラッグリサイズ |
| `layout.export` / `layout.apply` | ⏸ | pane 配置の保存/復元。需要が出たら検討 |
| `pane.process_info` | ✅ #113 | `pane_id` 必須 (`target` 不可、AGENTS.md §3)。Details dialog の process 表示 |
| `pane.layout` | ⏸ | snapshot の `layouts` で代替可能。個別取得の需要なし |
| `pane.neighbor` / `pane.edges` | ⏸ | レイアウト問い合わせ系。`focus_direction` がナビゲーション需要を全てカバーするため JSON API 追加の必要なし |
| `pane.focus_direction` | ✅ #113 | キーボード pane ナビゲーション (⌘+Arrow / Ctrl+Alt+Arrow) + コマンドパレット |
| `pane.input.set` | ⏸ | bracketed paste 等のモード設定。terminal surface が管理 |
| `pane.link.activate` / `pane.link.resolve` | ✅ #113 | サーバ側 link detection。hover で resolve → pointer cursor、click で activate → `window.open`。herdr 0.9.5 schema で client_shell lane だが JSON API dispatch も存在 |
| `pane.selection.read` | ⏸ | GUI は DOM selection を使う。herdr copy mode 相当は不要 |
| `pane.edit_scrollback` | ⏸ | herdr TUI の copy-mode 編集。GUI では編集 UI を持たない |
| `pane.wait_for_output` | ⏸ | agent 駆動の通知用途。v0.4.0 では不要 |
| `pane.read` | ✅(制限) | AGENTS.md §3: attach stream が正本。mirror pane のみの限定用途。現状 UI から未使用 |
| `pane.send_text` / `pane.send_keys` | ✅ | 既存。agent.prompt 優先の原則は維持 |

### Agent

| method | 判定 | 備考 |
| --- | --- | --- |
| `agent.get` | ✅ | 既存 |
| `agent.prompt` / `agent.rename` / `agent.start` | ✅ | 既存。prompt 応答は推測キー入力禁止 (AGENTS.md §3) |
| `agent.list` | ⏸ | snapshot の `agents` で全件取得可能。個別 list の需要なし |
| `agent.read` | ✅ #113 | Details dialog の agent 出力要約 (直近30行) |
| `agent.explain` | ✅ #113 | Details dialog の agent_status 根拠説明 |
| `agent.send_keys` | ⏸ | `pane.send_keys` で代替可能。agent 固有キーの需要が出たら再検討 |
| `agent.view.set` / `agent.view.clear` / `agent.focus` | ⏸ | herdr TUI の agent view (agent 専用画面)。JSON API で提供されるが GUI での専用 view は v0.4.0 対象外。必要になれば別 Issue |
| `agent.wait` | ⏸ | `pane.wait_for_output` と同じく保留 |
| `agent.report_*` / `report_metadata` / `clear_agent_authority` / `release_agent` | ❌ | herdr 内部/外部連携用。クライアントが呼ぶものではない |

### 補助

| method | 判定 | 備考 |
| --- | --- | --- |
| `notification.show` | ⏸ | outbound 専用 (herdr TUI client への toast 送出)。herdr-t3 は snapshot diff から自前 toast を出すため JSON API 側の読み取り手段がない限り到達不能 |
| `command.invoke` | ⏸ | `command_id` は client-shell snapshot のみが発行する boot 乱数 namespace の opaque id で、JSON API に command 一覧 method がない → 到達不能。upstream の JSON API 追加が前提 |
| `popup.close` | ⏸ | popup は client-shell 概念。GUI に対応物なし |
| `server.reload_config` / `reload_agent_manifests` | ⏸ | 設定 UI が herdr config を触る設計ではない。需要が出れば |
| `integration.*` / `plugin.*` | ❌ | herdr プラグイン基盤。クライアント機能ではない |
| `events.subscribe` | ✅ | bridge が全 subscription set で管理 (AGENTS.md §3) |

## 2. client-shell (TUI) 機能の対応表

herdr TUI (`src/client/shell/`) が提供する操作・情報と、herdr-t3 での
受け皿。`agent_status` バッジだけでは代替できない項目を明示する。

| herdr TUI 機能 | 実体 | herdr-t3 での受け皿 | 判定 |
| --- | --- | --- | --- |
| 下部モードバー (`render_mode_bar`) | PREFIX/NAVIGATE/RESIZE/COPY の現在モード + 有効キーのヒント、endpoint error、update 通知を pane 下端 1 行に表示 | GUI にモード概念はない。**endpoint error / update / copy 状態は toast または header status 領域**に翻訳。キーヒントはコマンドパレット/shortcut help に | 🔶 #113 |
| タブバー右側ステータス (`tab_bar_right`) | zoom/hostname/datetime/text/custom command の設定可能セグメント | header 右側の status cluster (接続先・時刻・カスタムは将来)。v0.4.0 は接続状態+workspace 集計 status | 🔶 #110 |
| エージェントサイドバー (`agent_sidebar`) | 全 agent を status 優先度順に一覧、status icon+色+`state_labels`、token ベースの行構成 (machine/workspace/tab/pane/agent/branch/gitstatus)、クリックで focus、sort 設定 | **現行は workspace row の status icon のみで不足**。agent 一覧面を sidebar のセクションまたは専用 view として提供 (#110/#113) | 🔶 #110/#113 |
| ワークスペースサイドバー token (`sidebar/tokens.rs`) | branch / git status (ahead/behind) / machine / custom tokens を行に描画 | JSON API の `tokens` は metadata tokens のみ。**branch は `worktree.list` の `open_workspace_id` 照合で取得** (#109)。ahead/behind は `git_ahead_behind` が JSON にないため v0.4.0 では branch のみ | 🔶 #109 |
| goto / aggregate navigation | agent/pane/workspace へのジャンプ、検索・status フィルタ・workspace グルーピング | `GotoDialog` (palette の "Go to…")。workspace/tab/pane の3階層、複数語 AND 検索、先頭 status token (`blocked`/`working`/`idle`/`done`/`b`/`w`/`i`/`d`) で agent status フィルタ。行モデルは `src/shell/goto.ts` | ✅ #114 |
| ドラッグ並び替え | tab 挿入 indicator (`│`)、workspace reorder、pane drag/swap | #111 | 🔶 #111 |
| コンテキストメニュー | pane/tab/workspace の右クリック操作 | 既存 context menu を拡張 (move/swap/rename 等) | 🔶 #111/#113 |
| 通知 toast (`notifications.rs`) | herdr イベントの toast (位置・遅延・delivery は config) | アプリ内 toast (既存 ui primitive があれば流用)。blocked/done の attention 通知 | 🔶 #113 |
| リンク hover/click (`link_hover.rs`) | pane 内リンクの検出・open | surface の link detection + `pane.link.*` (#113) | 🔶 #113 |
| コピーモード | scrollback 内検索・選択・yank | GUI は DOM selection + terminal scrollback で代替。検索は #113 で検討 | ⏸ |
| ワークツリービュー (`worktrees.rs`) | repo の worktree 一覧・open・remove overlay | `WorktreesSurface` (header overflow / palette)。一覧は `worktree.list`、open/create/remove は対応 RPC。branch/path は #109 の `worktree.list` cache が sidebar/header に表示 | ✅ #114 |
| カスタムコマンド (`custom_commands.rs`) | ユーザー定義コマンドの実行 | `command.invoke` をパレットへ (#113) | 🔶 #113 |
| 設定 overlay / global menu | TUI 設定画面 | herdr-t3 Settings (T3 構造) で代替。herdr config 自体は編集しない | ✅ 代替済み |
| マルチエンドポイント (`endpoints.rs`) | 複数 herdr server の切替・集約 view | herdr-t3 の machine 概念で代替済み。集約 agent view は将来検討 | ✅/⏸ |
| アップデート通知 | herdr 自身の update available | herdr-t3 自身の update は配布経路 (pc-setup) 次第。v0.4.0 対象外 | ❌ |
| キーバインド体系 | prefix + キーの modal 操作 | GUI は直接操作 + ショートカット。体系の再現はしない | ✅ 代替済み |

## 3. スコープ境界の明確化 (#114 関連)

- **herdr worktree** (`worktree.*` API、`git worktree` 管理): herdr の
  workspace が属する repo/worktree の一覧・作成・open・remove。**in-scope**。
  AGENTS.md §5 の "Worktrunk UI" は [Worktrunk](https://worktrunk.dev)
  (Rust 製 worktree ツール) の UI であり、herdr の worktree 機能とは別物。
- **Worktrunk UI**: 引き続き out-of-scope。
- herdr config (`~/.config/herdr/config.toml`) の編集 UI: out-of-scope
  (read-only の theme sync は既存 `server/ghostty.ts` の範囲)。

## 4. v0.5.0 追補 (Issue #149)

- **ターミナル入出力**: IME composition・focus report (1004)・mouse
  reporting・選択ポリシーは JSON API の method ではなく terminal
  emulation の契約。正本は `terminal-io.md`。herdr client-shell の
  `input.rs`/`mouse.rs`/`composition.rs` が upstream の参照実装
  (`e8d7d97`)。特定エージェント向け例外 (herdr の
  `cjk_ime_agents` 相当) は GUI では設けない。
- **Agents 一覧**: client-shell の agent sidebar は token 行モデル +
  priority/spaces sort で提供される (§2 表の「エージェントサイドバー」
  行を v0.5.0 の #151 で ✅ に更新する — sidebar Agents セクションが
  token 行相当の2行構造と status セクションを実装する,
  info-architecture.md §6)。
  `agent.view.*` は引き続き ⏸ (専用 agent view は対象外)。
- **Context menu**: tab strip の右クリック menu が v0.4.0 で欠落して
 いたため v0.5.0 で復活 (#152)。workspace/pane の context menu は
  維持。
- **Sidebar 行**: workspace/agent 行は herdr `SpacesSidebarConfig` /
  `AgentsSidebarConfig` の default token rows に準拠した複数行構造
  (info-architecture.md §6-7)。

## 5. 正本としての運用

- 新しい herdr API が必要になった場合: この表に行を追加し、bridge whitelist
  (`RPC_METHODS`)・`isClientFrame`・UI の3点を同じ ticket で整合させる。
- 「提供」を実装したら表の判定を ✅ に更新する (本 file が正本)。
- JSON API で代替不能な client-shell 専用機能を求める場合は ADR が必要
  (AGENTS.md §5)。
