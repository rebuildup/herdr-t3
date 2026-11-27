# 構造化コピー契約 (issue #429)

pane/agent の出力を TUI 上でドラッグ選択せずにコピーするための契約。
pane コンテキストメニューの「Copy output…」が `PaneCopyDialog`
(`src/components/PaneCopyDialog.tsx`) を開き、「候補を選ぶ →
プレビュー確認 → 明示 Copy」で clipboard へ書き込む。通常画面に
説明的ボタンは置かず、選択・コピー・OSC 52・copy-on-select
(#440) とは独立した経路として共存する。

## 1. 候補ソースと正直さの順序

候補生成はダイアログを開いた時点の**有界 read 1 回**だけで行う
(ポーリング・常時 scan なし)。各候補は `ReportCandidate`
(`src/lib/reportCopy.ts` — Electron/GPUI で共有する純粋な抽出
意味論) として label・source・`estimate`・notes・本文を持つ。

1. **transcript** (`rebuildup.conversations` `history --pane`、
   最大 8 ページ × 200 event で打ち切り): provider transcript の
   正規化 event から `assistant_message` (sidechain・空 text 除く)
   を取り、「Latest assistant message」「Last N assistant messages」
   を候補化する。`history --pane` の返す session は
   `live.pane_id`/`identity.pane_id` が対象 pane と一致することを
   照合し、不一致なら候補を出さず理由を表示する。plugin の
   read-time verdict を verbatim に扱う:
   - `stale` → 全候補を `estimate` 化し `stale_reason` を notes に出す
   - `transcript_present`/`events_present` が false、status ≠ ok、
     assistant event 0 件 → `unavailable` (理由表示)、候補なし
   - `text_truncated` → notes に「plugin が event text を truncate」
   - 最新 assistant event が indexed event 列の末尾 → 「turn が
     まだ進行中の可能性」note (「最新応答」を「最終報告」と
     同一視しない)
2. **scrollback** (mount 済み pane の live engine `textOf`、
   `src/lib/paneSurfaces.ts` registry): kept history 全体と表示中
   viewport の 2 候補。常に `estimate` — TUI chrome が残り得る
   表示文字列であり、soft wrap は engine が既に join 済み。
3. **agent.read** (`agent.read {lines:400, strip_ansi:true}`):
   surface が mount されていない場合のみ、他に候補が無いときの
   fallback。`truncated` は herdr の flag をそのまま notes へ。

ユーザー定義パターン (`TerminalSettings.copyStartPattern` /
`copyEndPattern`、200 字上限・不正 regex は match 時に unset 扱い)
は kept scrollback 全文へ適用し、**最後の start 一致以降で最初の
end 一致**までを「Custom range」候補にする。end が無い・regex が
不正・入力が上限超過のときは候補を出さず `no-match`/`invalid` を
表示する — 不完全な範囲を推測しない。マッチングは行数 6 万・
2MB で打ち切る。

## 2. ノイズ除去と raw/整形の区別

- `textOf` (PLAIN format) と `agent.read --strip_ansi` の時点で
  ANSI・セル末尾 padding・soft wrap は既に除かれている。この層で
  追加するのは `stripDisplayNoise` のみ: **box-drawing 文字と空白
  だけで構成される行** (TUI 枠) を落とし、先頭/末尾の空行を
  trim する。文字を含む枠行 (`│ status │`)・Markdown 表・
  インデント・コードブロック・意図的な空行・Unicode は一切
  書き換えない。
- 「clean copy」Switch (既定 ON) で `stripDisplayNoise` の
  on/off を切り替える。**プレビューは常にコピーされる byte 列と
  一致**する — clean 時は strip 後、off 時は raw。

## 3. 失敗の扱い

- transcript plugin 未導入/無効/非対応/host 未到達 →
  `classifyConversationsError` 相当の理由を notes に表示し、
  scrollback/agent.read 側は独立に継続する。
- remote/disconnected: transcript・agent.read の RPC 失敗は
  そのソースの note に留め、他ソースを殺さない。scrollback は
  ローカル engine 由来なので bridge 切断中でも読める。
- clipboard: `navigator.clipboard` 不在・write 拒否は dialog 内に
  error 表示。成功を偽らない。本文のログ・外部送信はしない。
- 手動選択 (ドラッグコピー、Cmd+C、copy-on-select) は従来どおり
  残る。

## 4. 境界

- provider JSONL を GUI が直接読まない (ADR-0011)。transcript
  は `plugin_call` → `rebuildup.conversations` のみ。
- herdr session/pane/agent generation の照合は plugin の
  identity/live/stale verdict に委ね、client は pane_id の
  一致確認だけを追加で行う。独自 transcript 正本は作らない。
- 通知 ticket (#428) との連携は「実際に完了候補が取れた場合の
  コピー導線」に限定し、完了判定を client 側で捏造しない。
