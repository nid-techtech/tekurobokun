# tekurobokun tasks（展示版）

目標はPhase 4まで。Phase 5は時間があれば行う。設計は`261113063547_imple_exhibition.md`。

## Phase 1: 土台
Phaseの推奨: Opus・high以上
- T1-1 → T4-10へ移動（実機での会話の確認を、先に開発機の仮のサーバーで行うため）
- [x] T1-2 【エージェント】Bunのワークスペースでモノレポを作る（`apps/backend`・`apps/console`・`apps/robot`・`packages/protocol`・`packages/i18n`・`packages/theme`、ルートの`package.json`・`tsconfig`・`.gitignore`）
  - 実施: Opus・high
  - メモ: TypeScript 7.0.2。共通設定は`tsconfig.base.json`、ルートの`tsconfig.json`は`scripts/`用（T1-7で中身ができるまで型検査の対象外）。`apps/robot/package.json`は仮置きで、T1-3でヘボコン版の内容に差し替える
- [x] T1-3 【エージェント】ヘボコン版（`../tekurobokun-lite`）を履歴なしで`apps/robot`へコピーし、モノレポで動くようにする。識別子とproductNameを変え、走行と音声スロットの配線を外す（`f`・`/`は残す）
  - 実施: Opus・high
  - メモ: シリアル通信はRust側でも未配線（`serial_link`はコードだけ残す）。起動時の挨拶（hello_world.wav）は音声スロットとは別のため残した。音声スロットの設定・WAVと`AudioSlotRegistry`は未配線で残る
  - 推奨: Sonnet・high以上
  - 依存: T1-2
- [x] T1-4 【エージェント】`packages/protocol`にメッセージの型と検証関数を定義し、単体テストを書く
  - 実施: Opus・high
  - メモ: `parse*Message`は受け取った文字列（JSON）を引数に取り、型にある項目だけで組み立て直して返す。`index`は0以上の整数、`thinkingMs`・`autosendMs`・`fontSizePx`は0以上の有限数として検証する
  - 依存: T1-2
- [x] T1-5 【エージェント】トークンを配置する：`specs/`のトークンを`packages/theme/tokens.css`へ、`brand.md`とマスターSVGを`docs/brand/`へコピーし、M PLUS 1 CodeとDotGothic16のフォントファイルをOFLのライセンス文と一緒に同梱する
  - 実施: Opus・high
  - メモ: `@font-face`は`packages/theme/fonts.css`に分けた（`tokens.css`は`specs/`と一致させるため）。フォントはgoogle/fontsのTTF（M PLUS 1 Codeは可変・wght 100〜700）
  - 推奨: Sonnet・medium以上
  - 依存: T1-2
- [x] T1-6 【エージェント】i18nの基盤を作る：`packages/i18n`にParaglide JS 2を入れ、モックの辞書を移す。疑似ロケールの生成、ロケールの判定・保持・フォールバック、`lang`属性、ロケールごとの書体を用意し、consoleとrobotから参照できるようにする
  - 実施: Opus・high
  - メモ: Paraglideは2系の最新（2.29.3。最新の3系はスペックシートの指定外）。コンパイルはViteプラグインでなくCLIで、`bun install`のpostinstallと`packages/i18n`の`compile`で行い、出力（`src/paraglide`）は共有でGit管理外。疑似ロケール`ja-x-pseudo`は公開版のビルドにも入るが、実行時に開発時以外は選べない。型は`tsconfig.base.json`の`allowJs`でJSDocから得る
  - 依存: T1-5
- [x] T1-7 【エージェント】checkコマンド（`bun run check`）を作る：`tsc`、Biome、`bun test`、i18nの検査、トークンの検査を実行し、失敗した部分だけを表示する
  - 実施: Opus・high
  - メモ: 未使用キーは警告にとどめ、失敗にしない（Phase 2・3で画面を作るまで大半が未使用のため）。検査を通すため、robotの`styles.css`の色・pxの直書きをトークンに置き換え、HUDの「(なし)」を辞書（`debug.no_caption`）に移した。Biome 2.6.6の整形を全体に適用
  - 依存: T1-3, T1-4, T1-6
- [x] T1-8 【エージェント】`CONTRIBUTING.md`の骨格を書く（受け付け方針、開発環境、セットアップ、checkコマンド、開発機の仮のサーバーの用意と、llama-server・VOICEVOXの動作確認のコマンド）
  - 実施: Opus・high
  - メモ: llama.cppのWindows版は`b{番号}`のビルドに付く（`v0.9.0`などの版のリリースには実行ファイルがない）。llama-serverの既定ポートは9931に変わっていたため、手順では`--port 8080`を明示した。モデルはggml-org/gemma-4-E2B-it-GGUFの`Q4_0`
  - 推奨: Sonnet・medium以上
  - 依存: T1-7
- [x] T1-9 【ユーザー】開発機（Windows）に仮のサーバーを用意する：llama-server（Windows版）とGemma 4 E2BのGGUF（4bit）、VOICEVOX ENGINE 0.25.2（Windows版）。用意の手順はT1-8で`CONTRIBUTING.md`に書く
  - 依存: T1-8
  - CPUで動かす想定。開発機のGPUが使えればそれでもよい

## Phase 2: 文字だけの会話
Phaseの推奨: Opus・high以上
引き継ぎ: W2-1〜W2-3通過（修正2件は`development/261113035214_fix_phase2.md`）。W2-4（現W2-8）が不合格だったため仕様変更（`development/261113061803_change_console_pwa_viewport.md`、プランアセット v2）。T2-9〜T2-12完了。walkの記載順をIDの番号順にそろえ、W2-4→W2-8、W2-5→W2-9に移した。次はW2-6 → W2-7 → W2-8・W2-9（ユーザー）。タブレットのブラウザはEdge（Android）
- [x] T2-1 【エージェント】バックエンドの骨格を作る：設定ファイルの読み込み、`Bun.serve`でのHTTP（入力ページの配信）とWebSocket、`hello`・`welcome`、接続の管理、`HealthMonitor`
  - 実施: Opus・low
  - メモ: ポートは8787、WebSocketは`/ws`、配信は`apps/console/dist`。設定にはimple 6節の項目のほか、`llm.jsonSchema`・`maxTokens`・`temperature`・`timeoutMs`と`historyDisplayTurns`を足した。HealthMonitorは`/health`（llama-server）と`/version`（VOICEVOX）を問い合わせ、機体の接続の有無も持つ
  - 依存: T1-4
- [x] T2-2 【エージェント】`DialogueEngine`（llama-server版とスタブ）を作る：人格プロンプトと直近の往復、JSONスキーマ制約の可否の確認、返事の検証とフォールバック、考えた時間の計測。単体テストを書く
  - 実施: Opus・low
  - メモ: llama-serverの`/v1/chat/completions`は`response_format: {type: "json_schema", json_schema: {schema}}`を受け付ける（tools/server/README.mdで確認）ため、これを使う。思考出力は`chat_template_kwargs.enable_thinking: false`で止める。返事の形式の指示は`apps/backend/src/dialogue/reply_format.md`。スタブは「崩れ」で形式の崩れ、「落ちて」でLLMの失敗を再現する
  - 依存: T2-1
- [x] T2-3 【エージェント】`InputDeviceRegistry`と`ConversationSession`（待機中・考え中、受付可否、履歴、機体がいないときは返事のあとすぐ待機中）を作る。単体テストを書く
  - 実施: Opus・low
  - メモ: Phase 2では、返事のあと常にすぐ待機中に戻る（話し中への分岐はPhase 3で足す）。LLMが失敗した発言は、返事のない発言として表示用の履歴に残る
  - 依存: T2-2
- [x] T2-4 【エージェント】入力ページを作る：接続と自動再接続、端末名、状態行、シェル風のログ、入力行（自動送信の進捗バー、送る・消す）、設定の反映（文字の大きさ・プロンプト・待ち時間）、`prefers-reduced-motion`
  - 実施: Opus・low
  - メモ: プロンプト行の時刻は、モックに合わせて時:分:秒にした（implは時:分）。考えた時間の書式として辞書キー`shell.duration`を足した。`?device=`を省略すると`tablet`。S01f・S01gの全面の案内はPhase 4で作るため、いまは切断中に状態行を「つながっていません」にして入力行を隠すだけ
  - 依存: T1-6, T2-3
  - 画面: S01a, S01b, S01c, S01e
- [x] T2-5 【エージェント】モデル比較のスクリプト（`scripts/bench_dialogue.ts`）を作る：同じ質問のセットを接続先ごとに投げ、考えた時間、形式の崩れの数、返事を一覧にする
  - 実施: Opus・low
  - メモ: 接続先と質問は`config/bench.default.json`（`bench.local.json`で上書き）。結果は`logs/bench/{日時}.md`。動作は偽のサーバーでだけ確かめた
  - 推奨: Sonnet・high以上
  - 依存: T2-2
- [x] T2-6 【ユーザー】人格プロンプトの初版を`config/persona.md`に書く（全体構想の人格設定を土台に、短く）
  - 依存: T2-2
- T2-7 → T4-11へ移動（モデルの比較はバックエンドPCの準備のあとに行うため）
- [x] T2-8 【エージェント】`CONTRIBUTING.md`に、バックエンド（スタブを含む）と入力ページの起動方法、設定ファイルを追記する
  - 実施: Opus・low
  - 推奨: Sonnet・medium以上
  - 依存: T2-4
- [x] T2-9 【エージェント】入力ページをPWAにする：Webアプリマニフェスト（名前、`start_url`は`/?device=tablet`、`display`は全画面、横向き、アイコン）と、マスターSVGから入力ページのアイコン（PWA用のPNGとファビコン）を作り、バックエンドから配信する。インストールの条件（Service Workerの要否を含む）とEdge（Android）での扱いを、公式ドキュメントで確かめてから作る
  - 実施: Opus・high
  - メモ: web.devのインストール条件（名前、192・512pxのアイコン、`start_url`、`display`）を満たし、Service Workerは置かない（ヘッドレスのEdgeの`Page.getInstallabilityErrors`が0件）。アイコンは`bun run console:icons`（`scripts/gen_console_icons.ts`がTauri CLIの`tauri icon`を呼ぶ）で`apps/console/public/icons/`に書き出す。色の値をトークンから写さないよう、マニフェストに`theme_color`・`background_color`は書かない。Android版Edgeでのインストールの操作と`fullscreen`の扱いは、Microsoftの公式ドキュメントに記載が見つからず、W2-8（旧W2-4）で実機で確かめる
  - 推奨: Sonnet・high以上
  - 依存: T2-4
- [x] T2-10 【エージェント】`ViewportFit`を作る：画面の高さを`visualViewport`の高さから下部マージンを引いた値に合わせ、ブラウザがずらした分を打ち消す。PWAとして起動していないときは、最初のタップで全画面表示にする。`console.bottomInsetPx`（初期値0）を設定ファイルと`ConsoleSettings`に足す。単体テストを書く
  - 実施: Opus・low
  - メモ: `.term`を`position: fixed`にし、`--viewport-height`・`--viewport-top`（JSで設定。未設定なら`100dvh`・0）で高さと位置を渡す。全画面表示は`click`（捕捉）で、全画面でなければタップのたびに要求する。PWA判定は`display-mode`の`fullscreen`・`standalone`
  - 依存: T2-4
  - 画面: S01a, S01b, S01c, S01e
- [x] T2-11 【エージェント】`CONTRIBUTING.md`に、タブレットへのインストール手順（Edgeのflags、登録するオリジン、オリジンが変わったらやり直すこと）と、設定の`console.bottomInsetPx`を追記する
  - 推奨: Sonnet・medium以上
  - 実施: Opus・low
  - メモ: Android版Edgeのflagsの表示名とインストールの項目名は公式ドキュメントで見つからず、Chromiumの名前で書いた。T2-12でChromeと同じと確かめ、注意書きを確認済みの内容に直した
  - 依存: T2-9, T2-10
- [x] T2-12 【ユーザー】タブレットのEdgeでflagsにバックエンドのオリジンを登録し、入力ページをPWAとしてインストールする（手順はT2-11の`CONTRIBUTING.md`）
  - メモ: flagsはChromeと同じ（`Insecure origins treated as secure`）。インストールして起動し、キーボードを出しても状態行と入力行が収まることをユーザーが確かめた
  - 依存: T2-11

## Phase 3: 機体で話す
Phaseの推奨: Opus・high以上
- [ ] T3-1 【エージェント】`TtsEngine`（VOICEVOX版とスタブ）を作る：文の分割、`/audio_query`→`/synthesis`、話者の設定。単体テストを書く
  - 依存: T2-3
- [ ] T3-2 【エージェント】`ConversationSession`に話し中を加える：文ごとの`speech`の送信（再生中に次の文を合成）、最後の`playback_done`で待機中、機体の切断で待機中、タイムアウト。単体テストを書く
  - 依存: T3-1
- [ ] T3-3 【エージェント】機体の`RobotLink`（接続と自動再接続、`hello`、メッセージの受け取り）を作る
  - 推奨: Sonnet・high以上
  - 依存: T1-3, T1-4
- [ ] T3-4 【エージェント】機体の`AudioPlayer`を作り直す：WAVの順の再生、振幅から口の値、各文の再生終了の通知
  - 依存: T3-3
- [ ] T3-5 【エージェント】`FacialEngine`と`IdleAnimator`を作る：`IDLE`・`SPEAKING`・`LOADING`、`emotion`の5種、まばたき・きょろきょろ（疑似乱数、設定で調整）、表情が変わらない間の描画頻度の抑制
  - 推奨: Sonnet・high以上
  - 依存: T3-4
  - 画面: S02a, S02b, S02c, S02d
- [ ] T3-6 【エージェント】入力ページに話し中の表示を加える
  - 推奨: Sonnet・medium以上
  - 依存: T3-2
  - 画面: S01d
- [ ] T3-7 【ユーザー】開発機のVOICEVOXで話者を聞き比べて決め、`config/backend.local.json`に書く（仮でよい）
  - 依存: T1-9, T3-1
- [ ] T3-8 【エージェント】`CONTRIBUTING.md`に、機体アプリの起動方法と設定を追記する
  - 推奨: Sonnet・medium以上
  - 依存: T3-6

## Phase 4: 止まらない展示
Phaseの推奨: Opus・high以上
- [ ] T4-1 【エージェント】バックエンドで、LLM・VOICEVOXの応答の有無を`status`に載せ、どちらかが落ちている間は入力を受け付けないようにする。復旧すれば自動で戻す
  - 依存: T3-2
- [ ] T4-2 【エージェント】機体に、眠っている顔（切断中・LLMかVOICEVOXが落ちているとき）を加える
  - 推奨: Sonnet・high以上
  - 依存: T3-5, T4-1
  - 画面: S02e
- [ ] T4-3 【エージェント】`OperatorConsole`を作る：バックエンドPCのターミナルで、数字キーで有効な端末を切り替え、現在の状態を表示する
  - 依存: T4-1
- [ ] T4-4 【エージェント】入力ページに全面の案内（つながらない、別の端末が有効）と自動での復帰を加える
  - 推奨: Sonnet・high以上
  - 依存: T4-1, T4-3
  - 画面: S01f, S01g
- [ ] T4-5 【エージェント】`ContentFilter`（入力と返事の検査、定型の返事への差し替え）を作る。単体テストを書く
  - 依存: T4-1
- [ ] T4-6 【エージェント】`ConversationLog`（日ごとのJSONLへの追記、起動時の表示用の履歴の読み込み）を作る。単体テストを書く
  - 依存: T4-5
- [ ] T4-7 【ユーザー】禁止語リストと定型の返事を`config/filter.local.json`に書く
  - 依存: T4-5
- [ ] T4-8 【ユーザー】会話ログの保存期間と、ブースに掲示する文言を決める（VOICEVOXのクレジットを含む）
  - 依存: T3-7
- [ ] T4-9 【エージェント】`CONTRIBUTING.md`に、バックエンドPC（Ubuntu）の準備、展示当日の起動手順、端末の切り替え方を追記する
  - 推奨: Sonnet・medium以上
  - 依存: T4-6
- [ ] T4-10 【ユーザー】バックエンドPC（Ubuntu）を準備する：llama-server（Vulkan、v0.7.0以降）をRX480で起動できるようにし、Gemma 4 E4B・Qwen3-4B・Gemma 4 E2BのGGUF（4bit）を用意する。VOICEVOX ENGINE 0.25.2（Linux CPU版）とBun 1.4を入れ、リポジトリを置き、LANでのIPを固定する
  - 依存: T4-9
  - 準備ができ次第、前のPhaseの途中でも進めてよい（手順はT1-8の`CONTRIBUTING.md`の仮のサーバーの手順を参考にする）
- [ ] T4-11 【ユーザー】バックエンドPCで比較スクリプトを実行し、使うモデルを決めて`config/backend.local.json`に書く
  - 依存: T2-5, T2-6, T4-10

## Phase 5: 字幕と公開の準備（時間があれば）
Phaseの推奨: Sonnet・high以上
- [ ] T5-1 【エージェント】機体に`CaptionOverlay`（左上の1行の字幕、長い文は末尾側）を加える
  - 依存: T4-2
  - 画面: S02f
- [ ] T5-2 【エージェント】バックエンドPCの自動起動の設定（llama-server・VOICEVOX ENGINE・`apps/backend`のsystemdユニット）を書く
  - 依存: T4-9
- [ ] T5-3 【ユーザー】バックエンドPCに自動起動の設定を入れる
  - 依存: T5-2
- [ ] T5-4 【エージェント】マスターSVGから、機体アプリのアイコンを作る（入力ページのアイコンはT2-9で作る）
  - 推奨: Sonnet・medium以上
  - 依存: T1-5
- [ ] T5-5 【エージェント】CIのワークフロー（checkコマンドを呼ぶ）を作る
  - 依存: T4-9
- [ ] T5-6 【エージェント】READMEとGitHubのAbout欄の文案を書く（会話を記録していること、外部に送らないこと、コード署名がないことを注意事項に含める）
  - 依存: T5-1
- [ ] T5-7 【エージェント】`CONTRIBUTING.md`に、ビルド、アイコンの生成、リリース手順を追記する
  - 推奨: Sonnet・medium以上
  - 依存: T5-4, T5-5
- [ ] T5-8 【エージェント】0.1.0のリリース準備をする（`CHANGELOG.md`、バージョン、`timeline.md`、`tauri build`の確認）。コミットメッセージとコマンドの提示で停止する
  - 依存: T5-6, T5-7
