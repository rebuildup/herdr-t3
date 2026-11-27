# ターミナル入出力契約 (v0.5.0 正本)

herdr-t3 のターミナル surface (`src/lib/ghostty/surface.ts` +
`src/lib/ghostty/session.ts` + `shared/ghostty/engine.ts`) が pane の pty と
ユーザー入力の間で守るべき契約。Issue #150 の実装と #155 の契約テストは
この文書に従う。upstream の参照実装: Ghostty (libghostty-vt が内包)、
xterm.js の mouse/IME 扱い、herdr client-shell (`src/client/shell/input.rs`,
`mouse.rs`, `composition.rs`) @ `e8d7d97` (docs/upstream.md)。

原則: **GUI 側の都合で端末入力を握り潰さない。** pane の pty が要求した
モード・フォーマットに対して、端末として正しいバイト列を届ける。アプリ側の
操作 (mouse capture、kitty keyboard、focus event) と GUI 側の操作
(選択・検索・scrollback・リンク) の境界を各節で明示する。

## 1. 経路

```
DOM event ──> GhosttySurface ──encode*──> onInput(bytes)
                                              │ terminalInput RPC
                                              v
                                    herdr attach socket ──> pane pty
```

- ユーザー入力 (key/mouse/paste/IME commit) と、プログラムの問い合わせへの
  engine の応答 (DA/DSR/OSC など) は同じバイト列として pty へ流れる。
  「入力」と「応答」を分けない。
- attach 切断中にキューイングして後で自動送信することはしない
  (AGENTS.md §3 の draft invariant はアプリ側メッセージ入力の話だが、
  terminal の生バイトも同じく「ユーザーが今送ったもの」だけを送る)。

## 2. キーボード

- `keydown`/`keyup` は `engineKeyFor` で `EngineKey` へ写像し、
  `session.encodeKey` が pane の要求する keyboard mode (legacy / kitty
  flags) で符号化する。`hasKey` が false のキーは送らない。
- repeat は `action: "repeat"`、押下/解放は `press`/`release`。
  kitty keyboard の release report を要求するアプリには release も送る。
- プラットフォーム予約 chord は pane に送らない: macOS の `Cmd+*`
  (コピー/ペースト/終了等)。Windows の `Ctrl+Alt` (AltGr) は engine の
  keyboard model に従う — AltGr が文字を生む場合は text commit 経路。
- **プレーンな文字キー (修飾なし・`key.length === 1`) は keydown では
  送らない。** その text は `beforeinput insertText` → `session.inputText`
  が UTF-8 バイトとして送る。keydown で送ると IME composition の最初の
  ローマ字キーが `compositionstart` より先に発火するため pane へ漏洩する
  (issue: 変換中ローマ字混入)。Kitty keyboard flag 8 (report all keys)
  を要求した pane のみ例外的に encoder 経路を維持する。
- `event.isComposing`、`keyCode === 229`、`key === "Process"`、
  `key === "Dead"`、または surface の composition 中のキーは encoder に
  到達しない (`bypassesKeyEncoder`、inputPolicy.ts)。229/Process は
  `isComposing` が信頼できない platform 向けの marker。
- 上記以外の IME を介さない文字入力 (Unicode direct input、dead key
  解決後の `beforeinput insertText`) も `session.inputText` で送る。
  bracketed paste にはしない。

## 3. IME composition 契約

対象: 日本語 IME の変換開始・候補選択・確定・取消・連続入力。特定エージェント
向けの例外は設けない (herdr の `cjk_ime_agents` のような per-agent filter は
GUI では不要 — 契約は端末として一律)。

### 3.1 イベントの扱い

- `compositionstart` → surface は composing 状態へ。以後の `keydown` は
  変換中キー (Enter 確定、矢印で候補移動、Esc 取消) として pane に送らない。
  composition を開始した最初のキーストロークは `compositionstart` より
  前に `keydown` が発火するため、§2 の通りプレーン文字キーは keydown を
  通らず `beforeinput` 経由でのみ pane に届く — これにより変換中
  ローマ字の漏洩を構造的に防ぐ。
- `compositionupdate` → 変換中文字列を composition 表示へ反映する
  (pane へは送らない)。
- `compositionend` → `data` を **ちょうど 1 回** `inputText` で pty へ送る。
  `data` が空 (取消) なら何も送らない。
- 確定と同時に `beforeinput insertText` が来る platform があるため、
  commit text の二重送信を防ぐ dedupe を実装する (同一 task 内の
  compositionend と insertText の重複を 1 回に畳む)。
- 連続入力: compositionend 直後の新しい compositionstart は独立した
  composition として扱い、前の commit を再送しない。

### 3.2 表示契約

- **変換中文字列は端末上に見えること。** 現行の全面 `opacity:0` textarea は
  composition text を不可視にする。cursor セル位置に composition 表示層
  (xterm.js の composition view 相当) を重ね、`compositionupdate` で更新、
  `compositionend`/cancel で消す。pane の描画内容は変更しない。
- **IME 候補ウィンドウのアンカー**: OS の候補ウィンドウは focused editable
  要素の caret 位置に出る。composition 中は textarea (または専用 anchor
  要素) を engine の cursor cell の screen 座標へ移動/サイズ調整し、
  候補ウィンドウが端末カーソル直下に出るようにする。composition 終了後は
  全面配置へ戻す。
- **カーソル非表示 (?25l) 時**: engine の cursorState が位置を返す限り
  そこへアンカーする。位置が取れない場合は viewport 左下 cell を fallback
  とする。herdr の `reveal_hidden_cursor_for_cjk_ime` 相当の「カーソルを
  強制表示」は GUI では行わない — pane の表示状態を GUI が改変しない。

### 3.3 検証

- 契約テストで composition lifecycle を DOM event レベルで再現し、
  pty へ出るバイト列が「commit 1 回・取消 0 回・変換中キー 0 件」を
  満たすことを確認する (#155)。
- 実機 (macOS/Windows) で日本語 IME の一連操作を RC 検証する。

## 4. Focus reporting (DECSET 1004)

- pane が mode 1004 を有効化した場合、surface の focus 遷移で
  `CSI I` (focus in) / `CSI O` (focus out) を pty へ送る。
- 送信は `modes().focusReports` が true の時のみ。mode off の pane に
  focus bytes を送らない。
- GUI chrome (sidebar/palette/menu) へのフォーカス移動も pane から見れば
  focus out として正しく報告する — surface input が blur した時点で送る。

## 5. マウス契約

### 5.1 モードとイベント対応

pane が要求した mouse mode (`session.modes().mouse`) と format
(`mouseFormat`) に従い `encodeMouse` が符号化する。surface の責務は
「正しい `EngineMouse` を正しいタイミングで渡す」こと。

| ユーザー操作 | none | x10 | normal(1000) | button(1002) | any(1003) |
| --- | --- | --- | --- | --- | --- |
| 左/中/右 click | local select/copy | press+release | press+release | press+release | press+release |
| button drag | local selection | motion(button) | motion(button) | motion(button) | motion(button) |
| hover (button なし) | なし | なし | なし | なし | **motion (buttonless)** |
| wheel | local scrollback | wheel button press+release | 同左 | 同左 | 同左 |

- `any` mode の buttonless motion は pointermove ごとに送る
  (rAF throttle 可、最終位置は必ず送る)。
- 座標は viewport cell (0-based)。scrollback 表示中の wheel は
  「mouse mode ON → アプリへ wheel report、OFF → local scrollback」。
- `sgrPixels` format では pixel 座標を cellW/cellH から計算して渡す
  (engine 側で処理。surface は cell 座標を渡すだけ)。

### 5.2 選択 vs mouse report の境界

- mouse mode ON の pane では pointer drag は原則アプリへ送る
  (xterm.js と同じ)。
- **Shift+drag は常にローカル選択** (mouse mode に関係なく)。
- mouse mode ON での選択手段は Shift+drag に統一し、UI 上の案内
  (tooltip/status) で発見可能にする。アプリ固有の例外処理はしない。
- ダブル/トリプルクリックの word/line 拡大選択は local selection
  モードでのみ有効 (現行維持)。
- テキスト選択のコピーは `copy` event 経路 (Cmd/Ctrl+C) で DOM selection
  ではなく engine の `textOf(selection)` を使う (現行維持)。
- Copy on select (issue #440): Settings > Terminal の
  `copyOnSelect` (既定 OFF) が ON のとき、ユーザーがローカル選択を
  **確定**した時点 (ドラッグの pointer-up、ダブル/トリプルクリックの
  word/line 拡大。逆方向ドラッグ・端オートスクロール含む) で、確定した
  選択本文を OS clipboard へ一度だけ書き込む。core は確定ごとに
  `selection_commit{text}` effect を `selection_change` の直後へ 1 回
  だけ発行し、ドラッグ途中・tick・wheel/scroll・出力・検索結果選択・
  `pointerCancel`・空選択・`clearSelection` では発行しない
  (`selection_change` は clear/invalidate でも飛ぶ通知であり、確定
  信号とは区別する)。clipboard 書き込みは host 層
  (`PaneTerminal` → `src/lib/selectionCopy.ts`) が設定を commit ごとに
  読んで行い、書き込みは commit 順に直列化する — 遅い write が新しい
  コピーを上書きしない。失敗は握り潰し、本文をログ・外部送信しない。
  明示 copy・OSC 52 (`onClipboardWrite`)・#429 の構造化コピー経路とは
  独立に共存する。
- ドラッグ選択のアンカーは pointer-down 時点のセルに固定し、移動端点と
  独立して保持する。表示・コピー時のみ `ordered()` で正規化する
  (issue #427 — 正規化済み start を次のアンカーに再利用すると逆方向
  ドラッグで開始点が失われる)。viewportTop の追従 (selection carry)
  が走るときは進行中ドラッグのアンカーも同じ delta で移し、出力追記で
  アンカーが取り残されないようにする。TS `surfaceCore` と Rust
  `terminal-surface` および differential scenario
  `terminal.surface-select-reverse` がこの契約を共有する。

### 5.3 GUI が握り潰してはいけないもの

- `pointerdown` の `preventDefault` は focus 維持のために必要だが、
  mouse report 自体は pointer event から独立して送る (現行構造を維持)。
- contextmenu の preventDefault は pane の right-click report を
  妨げない (press/release は pointer event で送出済み)。

### 5.4 attach 経路の実トランスポート (v0.5.0)

§5.1–5.3 が前提とする `session.modes()` は、TerminalAnsi attach
ストリームには pane の mode 状態が含まれないため常に `none` のまま
(herdrdev/herdr#6177)。そのため attach クライアントでは:

- pointer press/drag/release/hover-motion は `terminal_mouse` frame →
  herdr `AttachMouse` として構造化送信する。サーバ側
  (`apply_client_terminal_input_events` → `encode_mouse_*`) が pane の
  mode を見て SGR report を生成するため、mode OFF では無害な no-op、
  mode ON では正しい report が届く。wheel は `terminal_scroll` →
  `AttachScroll` で、サーバが wheel report / scrollback /
  alternate-scroll を裁定する。
- **pane の mouse capture 状態は `ServerMessage::MouseCapture`
  (variant 8) で届く** (herdr 0.9.0+、protocol 22。attach 時と
  変化時に push)。`enabled` は attach 先 pane の
  `mouse_reporting_enabled()` で、selection-vs-report の判定に使う
  (`GhosttySurface.setMouseCapture`)。`sgr_pixels` は pixel mouse
  非対応のため未使用 (cell 座標のみ送る)。
- ローカル選択と report の境界 (§5.2) は capture 状態で決まる:
  `enabled=true` なら report のみ (ローカル選択なし)、
  `enabled=false` ならローカル選択のみ (structured mouse は送らない)、
  未受信 (古い herdr / 非 attach ホスト) なら従来どおり全イベントを
  転送しつつ選択も並行させる — サーバが不要な report を落とすため
  どの herdr 版でも正しく、mode OFF の pane に無駄な frame を
  送らない分だけ効率的。Shift+drag は capture 状態に関係なく常に
  ローカル選択 (xterm 準拠)。
- focus report (CSI I/O) は2系統の upstream 依存で未達 (issue #169、
  実測済み):
  - socket API の `pane.focus` / `tab.focus` は pane focus event を
    発火しない upstream bug (herdrdev/herdr#4902)。GUI の pane クリックは
    この経路のため、pane 間移動でも CSI I/O が届かない。
    `pane.focus_direction` (キーボードナビ) のみ現状配送される。
  - outer window focus (ブラウザ/OS の focus 喪得) を attach client が
    server へ通知する client message が存在しない。`AttachFocus` 提案を
    Ideas discussion (herdrdev/herdr#6178) へ投稿済み。
  - client 側の送信経路 (`reportFocus` → `focusReport` → emit) は実装済み。
    `pane.focus` が upstream で修正されれば追加実装不要。`AttachFocus`
    採用時のみ attach link への薄い配線が必要。

### 5.5 ホスト側スクロールと選択投影 (issues #433/#436)

attach 経路では wheel/trackpad scroll が `terminal_scroll` → herdr
`AttachScroll` として **server 側** で処理されるため、クライアント
engine の `scrollJump`/`scrollOffset` は更新されない。選択・検索
highlight は engine の履歴座標 (absolute row) に保存したまま、
**投影時にだけ** ホストの表示位置を差し引く:

- herdr は `PaneInfo.scroll`
  (`{offset_from_bottom, max_offset_from_bottom, viewport_rows}`) と
  `pane.scroll_changed` subscription event で権威ある scroll 状態を
  push する。bridge は attach 中の全 pane に対してこの購読を張り、
  `pane.scroll` RPC で絶対 offset を設定できる。
- `SurfaceCore.hostScrollChanged` が受け取るたびに
  `shift = offset_from_bottom - appends` を再計算する
  (`appends` は scroll 中の scrollback 増加分 — pin された表示内容を
  保つため)。`render_set_viewport_shift` effect として scene/renderer
  へ伝え、selection/highlight の wash は
  `viewportTop - shift` を投影原点に使う (TS `scene.ts` /
  Rust `terminal-render`)。`cellAt`・mouse report 座標も同じ
  effective top を使う。
- **選択の y 座標は書き換えない** — `textOf`/copy が engine 履歴を
  引くため、座標を動かすとコピー内容が壊れる。投影だけをずらす。
- `viewport_rows` の変化 (resize/reflow) または `max` の縮小
  (history prune) は座標の信頼性を失うため、selection と highlights
  を明示的に invalidate する (残しておくと別の行を highlight する)。
- **選択ドラッグ中の viewport 端オートスクロール (issue #433)**:
  pointer がグリッド外へ出ても select drag は継続し、ポインタ位置を
  cell 単位の float で保持する。最外周 1 行またはオーバーシュート
  で edge zone に入り、`tick()` が `scroll_request {direction, lines}`
  を毎フレーム発行する (速度はオーバーシュート距離で逓増、行数で
  クランプ)。ホストはこれを `pane.scroll` へ写像し、結果は
  `pane.scroll_changed` → `hostScrollChanged` で戻る。wheel 経路
  (`AttachScroll`) は select drag 中には使わない — TUI の mouse
  report との arbitration を避けるため。pointerup/cancel/dispose で
  停止する。
- アンカー契約は §5.2 (issue #427) を共有する: アンカーは engine
  履歴座標で固定、移動端は pointer の cell 座標から effective
  viewport top 経由で毎フレーム再導出するため、ホスト駆動の
  スクロールに追従して選択が伸びる。
- TS `surfaceCore` / Rust `terminal-surface` の両 adapter が同一
  契約を持ち、differential scenario `terminal.surface-host-scroll`
  (core) と `terminal.scene-viewport-shift` (投影) が固定する。

## 6. Paste / clipboard

- `paste` event → `onPasteText` → herdr `pane.send_text` (issue #434)。
  TerminalAnsi attach ストリームは pane の画面を再エンコードした blit
  であり DECSET 系列を一切含まないため、クライアント engine の
  mode 2004 は常に off で `encodePaste` は絶対に bracket しない
  (改行が CR 化され行ごとに実行される不具合の根因)。herdr 側は
  `pane.send_text` が pane runtime の `bracketed_paste_enabled()` を
  見て `\x1b[200~…\x1b[201~` で包むため、mode の正本は server に
  残る。`sanitizePasteText` が body 中の ESC を空白化し、server 側
  wrapper を早期終了させる注入を防ぐ (libghostty encoder と同じ
  最小規則)。attach プロトコルが paste mode を push するように
  なれば (herdrdev/herdr#6215)、engine `encodePaste` 経路へ戻せる。
- mode off (pane が 2004 を要求していない) の複数行 paste は
  bracket なしの生バイトとして届き、readline 系では改行が
  accept-line として働き得る — これは標準端末の unbracketed paste
  意味論であり、client 側で改行を除去/置換して見かけ上安全化は
  しない (issue #434 要求)。mode on の TUI/agent pane では
  一括 paste として配送される。
- **暫定経路と本来契約の差異・移行条件 (issue #434)**: 現行は
  `pane.send_text` RPC 経由で、attach `Input` ストリームとは別
  チャネルのため、paste 直後のキー入力との配送順序は server 側の
  処理順に依存する (同一 pane への連続操作では実害は稀だが、
  厳密な順序保証はない)。本来契約は attach ストリーム上の
  `encodePaste` で、兄弟のキー/マウス入力と同じ順序列を保つ。
  差異は3点: (1)配送チャネルと順序、(2) mode off 時の改行変換
  (engine は LF→CR、send_text は LF のまま — readline ではどちらも
  accept-line になり得るため実害は同等)、(3) body の制御文字処理
  (engine は C0 を空白化、暫定経路は ESC のみ空白化)。
  移行条件: herdrdev/herdr#6215 (attach への pane mode-state
  push、MouseCapture variant 8 と同型) が採用された時点で
  `onPasteText` 配線を外し `encodePaste` へ戻す。それまでは
  `pane.send_text` が mode の正本を持つため機能差はない。
- OSC 52 等の clipboard write は `onClipboardWrite` →
  `navigator.clipboard.writeText` (現行維持)。
- 構造化コピー (issue #429): pane コンテキストメニューの
  「Copy output…」が transcript/scrollback/pattern の候補から
  明示コピーする経路。詳細契約は `docs/design/report-copy.md`。

## 7. 契約テスト要件 (#155 と連携)

決定的に検証するイベント列:

- composition: start → update → end(commit) / end(cancel) / 連続2回 /
  変換中 keydown が pane へ出ないこと
- focus: mode 1004 on/off × focusin/focusout で CSI I/O の有無
- mouse: mode 別に press/motion/release/wheel/any-motion のバイト列
- 選択: mouse mode ON/OFF × plain drag / Shift+drag の分岐
- 座標: viewportTop オフセット (scrollback 中) の cell 変換

### 7.1 カバレッジ対応表 (issue #155)

`bun test` に DOM がないため、契約は「DOM 非依存の policy 層
(`src/lib/ghostty/inputPolicy.ts`) + engine 層 (`session.ts`)」で検証し、
`GhosttySurface` は DOM event を policy 呼び出しへ写像するだけの薄い
adapter とする。

| 契約行 | 検証場所 |
| --- | --- |
| composition lifecycle / cancel / 連続 / insertText dedupe | `inputPolicy.test.ts` `CompositionTracker` |
| 変換中 keydown 抑制 + 文字キーの beforeinput 経路 | `inputPolicy.test.ts` `bypassesKeyEncoder` / `CompositionTracker`; surface 配線は RC 実機 (§3.3) |
| focus 1004 on/off → CSI I/O | `inputPolicy.test.ts` `focusReport` + `session.test.ts` modes() |
| mouse mode 別バイト列 (none/x10/normal/button/any、press/release/motion/wheel) | `session.test.ts` mouse-mode matrix + SGR/any-motion tests |
| 選択 vs report 分岐 (plain/Shift+drag) | `inputPolicy.test.ts` `pointerDragKind` |
| wheel → wheelUp/Down/Left/Right・scrollback 分岐 | `inputPolicy.test.ts` `wheelButton` (mode 分岐は `surface.wheel`、mouse mode ON/OFF は session matrix で担保) |
| 座標 viewportTop 変換・scrollback 領域の拒否 | `inputPolicy.test.ts` `mouseReportCell` |

残余 (DOM/実機でしか検証できないもの) は RC チェックリスト
(`docs/design/verification.md`) に列挙し、未検証を成功扱いしない。
