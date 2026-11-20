# tekurobokunの開発に参加する

不具合の報告はIssueで受け付けます。プルリクエストは、事前にIssueで相談してください。

## 開発環境

- **開発機**：Windows 11。コマンドの例はPowerShell 7で書いています
- **Bun** 1.4系（パッケージ管理・バックエンドの実行・テスト）
- **Rust**（安定版）と、Tauri 2の前提（Microsoft C++ Build Tools、WebView2）。機体アプリ（`apps/robot`）のビルドに使います
- **Git**
- 会話を実際のAPIで確かめるときは、後述の「仮のサーバー」（llama-server・`whisper-server`・VOICEVOX ENGINE）

本番では、自宅のバックエンドPC（Windows 11、GPUはRX 5700 XT）でllama-server・`whisper-server`・VOICEVOX ENGINEを動かします。手順は「バックエンドPC（本番）」にあります。v5（0.1.0）の展示当日の起動と、端末の切り替え方は「展示当日の運用」にあります。

## セットアップ

```powershell
git clone https://github.com/nid-techtech/tekurobokun.git
cd tekurobokun
bun install
```

`bun install`のあとに、i18nの辞書が自動でコンパイルされます（`packages/i18n/src/paraglide/`に出力され、Gitでは管理しません）。

改行コードはLFにそろえています（`.gitattributes`）。Git for Windowsの既定（`core.autocrlf=true`）でも、作業ツリーはLFで書き出されます。`.gitattributes`が入る前にクローンした作業ツリーで`bun run check`のBiomeが全ファイルの整形エラーになるときは、取り込んだあとに作業ツリーを書き出し直します（コミットしていない変更は消えます。Git管理外の`*.local.json`は残ります）。

```powershell
git pull
git rm -r --cached -q .
git reset --hard
```

## 確認とテスト

変更したら、コミットの前に次を実行し、すべて通ることを確かめてください。CI（`.github/workflows/check.yml`。`main`へのpushとプルリクエストで、Windows上で実行）も同じコマンドを使います。

```powershell
bun run check
```

次を順に実行し、通った検査は1行、失敗した検査は失敗した部分だけを表示します。

1. i18nのコンパイル（辞書の変更を型に反映）
2. `tsc`（全ワークスペースと`scripts/`）
3. Biome（lintと整形）
4. `bun test`
5. i18nの検査：ロケール間のキーの過不足とプレースホルダの一致、疑似ロケールの同期、UI内の日本語の直書き。未使用キーは警告だけを出します
6. トークンの検査：`packages/theme/tokens.css`・`docs/brand/`と`roadmap/specs/`の一致、`apps/*/src`の色（`#…`・`rgb(`）と`px`の直書き

よく使うコマンド：

```powershell
bun x biome check --write .                    # 整形とimportの並べ替えを自動で直す
bun test                                       # テストだけを実行する
bun run --filter @tekurobokun/i18n compile     # 辞書を変えたあと、疑似ロケールの生成とコンパイルをする
```

### 文言と国際化

- UIの文字列は、`packages/i18n/messages/ja.json`（原文の辞書）に置き、`m["キー"]()`で参照します。コードに直書きしません
- キーは機能ごとの階層をピリオドで区切り、各階層はスネークケースにします（例：`input.send_button`）
- 疑似ロケール（`ja-x-pseudo`）は、`ja.json`から自動で生成します。開発時だけ、URLに`?locale=pseudo`を付けると表示できます

### 値（色・大きさ・余白）

- 値の正本は`packages/theme/tokens.css`です（`roadmap/specs/`のトークンの写し）。コンポーネントからは`var(--…)`で参照し、値を直書きしません
- `tokens.css`は直接編集しません。値を変えるときは、`roadmap/specs/`のトークンを新しい版にし、その写しを置き直します

## 起動

### 機体アプリ（apps/robot）

```powershell
cd apps/robot
bun run tauri dev
```

`f`キーでフルスクリーン、`/`キーでデバッグHUD（接続先、登録の有無、接続の有無、会話の状態、表示状態、感情、音の大きさ、目・口の座標、再生中の文）を切り替えます。

機体アプリは、登録で得たバックエンドの接続先とトークンでWebSocketにつなぎ、切れたら自動で再接続します（「端末の登録」）。表示と音声の再生だけを行い、顔はバックエンドから届く状態で決まります。

- 未登録（接続先かトークンがない・断られた）：カメラの映像を全面に出し、QRを合わせる枠と「QRコードをカメラに見せてください」を出します。読み取れたら笑った顔と「つながりました」を出して待機に戻り、古いコードなら「古いコードです」と出します

- 待機中：まばたきときょろきょろをします
- 考え中：内側の円が回ります。左上に、来場者の発言が字幕で出ます
- 話し中：左上に、いま読み上げている文が字幕で出ます（緑のDotGothic16、1行）。1行に入らない長さは、末尾側を出します。位置と大きさは設定の`caption`で変えます。届いた音声を順に再生し、音の大きさに合わせて口の高さが伸び縮みします。目は返事の感情の形になり、話し終えてから少しのあいだ残ります
- バックエンドにつながらない、LLMかVOICEVOXが応答しないとき：眠っている顔（目を閉じ、口を少し開け、顔全体がゆっくり上下に揺れる）になり、戻れば自動で元の顔に戻ります。Windowsの設定で「アニメーション効果」をオフにしているときは揺れません

**スタブで会話を通す**（開発機だけで、考え中→話し中→待機中を確かめる）

```powershell
bun run console:build
bun run backend:stub     # 別のPowerShellで起動しておく
cd apps/robot
bun run tauri dev
```

入力ページと機体アプリは、はじめに登録します（「端末の登録」の「開発機での登録」）。入力元の初期値は機体のマイク（`robot`）なので、バックエンドのターミナルで`2`を押して`tablet`に切り替えます。ブラウザで`http://localhost:8787/?device=tablet`を開いて話しかけると、機体アプリが考え中の顔になり、返事を正弦波の音（文字数に応じた長さで、音量が揺れる）で読み上げながら口を動かします。機体アプリがつながっていないときは、入力ページは返事を出したらすぐ待機中に戻ります。

**別のPCのバックエンドにつなぐ**：そのバックエンドが出す登録のQRを読ませます。カメラがないときは、`apps/robot/src/config/config.local.json`（Git管理外）に接続先とトークンを書きます（「端末の登録」）。設定はビルドに取り込まれるため、書き換えたら機体アプリを起動し直します（`tauri build`で作ったアプリは、ビルドし直します）。

#### 機体アプリの設定

設定は`apps/robot/src/config/config.default.json`（Gitで管理）にあり、`config.local.json`に書いた項目だけを上書きします（上書きのしかたはバックエンドの設定ファイルと同じ）。`drive`と`audio`は、この版では使わない走行と音声スロットの設定です。`voice`は機体のマイクの設定です（「音声入力」）。

| 項目                                | 内容                                                                                  | 初期値               |
| ----------------------------------- | ------------------------------------------------------------------------------------- | -------------------- |
| `backend.url`・`backend.token`      | 開発用の接続先（WebSocket）とトークン。両方あれば、登録で保存したものより優先する     | `null`・`null`       |
| `pairing.scanIntervalMs`            | 登録の画面で、カメラの画像からQRを探す間隔                                            | `300`                |
| `pairing.okHoldMs`                  | 読み取れたとき、笑った顔と「つながりました」を出す時間                                | `2000`               |
| `facial.eyes`・`facial.mouth`       | 目・口の基本座標と線の太さ（800×600の座標。ヘボコン版の値）。口の角丸は`cornerRadius` | ヘボコン版の値・`14` |
| `lipSync.floor`・`lipSync.gain`     | 口の開き＝（音の大きさ（RMS）−`floor`）×`gain`（0〜1で頭打ち）                        | `0.01`・`6`          |
| `lipSync.attack`・`lipSync.release` | 口を開くとき・閉じるときの追従の速さ（1フレームで目標に近づく割合）                   | `0.6`・`0.25`        |
| `lipSync.minRatio`・`rangeRatio`    | 話し中の口の高さ＝基本の高さ×（`minRatio`＋口の開き×`rangeRatio`）                    | `0.45`・`0.85`       |
| `idle.blinkMinMs`〜`blinkMaxMs`     | まばたきの間隔（この範囲の乱数）                                                      | `2500`〜`6500`       |
| `idle.blinkDurationMs`              | まばたきの長さ                                                                        | `150`                |
| `idle.lookMinMs`〜`lookMaxMs`       | きょろきょろの間隔                                                                    | `6000`〜`14000`      |
| `idle.lookDurationMs`               | よそ見している長さ                                                                    | `1400`               |
| `idle.lookOffsetX`                  | よそ見で内側の円をずらす量                                                            | `22`                 |
| `idle.seed`                         | 乱数の種（`null`なら起動ごとに変わる。数を入れると毎回同じ並びになる）                | `null`               |
| `render.activeFps`・`idleFps`       | 描画頻度（話し中・考え中／待機中）。待機中は、形が変わらないフレームは描き直さない    | `30`・`10`           |
| `render.loadingTurnMs`              | 考え中に内側の円が1周する時間                                                         | `1200`               |
| `render.emotionHoldMs`              | 話し終えてから、感情の目を通常の目に戻すまで                                          | `1500`               |
| `render.sleepMouthLevel`            | 眠っている顔の口の開き（話し中の口の開きと同じ0〜1の尺度）                            | `0.05`               |
| `render.sleepBobAmplitude`          | 眠っている顔が上下に揺れる幅（中心から片側）                                          | `10`                 |
| `render.sleepBobCycleMs`            | 眠っている顔が上下に1往復する時間                                                     | `6400`               |
| `caption.x`・`caption.y`            | 字幕の左上の位置（800×600の座標。目の上端より上に収める）                             | `14`・`4`            |
| `caption.maxWidth`                  | 字幕が1行に入る幅。超えた文は末尾側を出す                                             | `772`                |
| `caption.fontSize`・`lineHeight`    | 字幕の文字の大きさと行の高さ                                                          | `18`・`26`           |
| `voice.detector`                    | 声の検出の方式（`silero`・`level`。「音声入力」）                                     | `silero`             |
| `voice.silenceMs`                   | 発話の終わりとみなす無音の長さ                                                        | `800`                |
| `voice.maxUtteranceMs`              | 1発話の最大の長さ（超えたらそこで区切って送る）                                       | `15000`              |
| `voice.halfDuplexGraceMs`           | 音声の再生が終わってから、聞き始めるまでの余裕（半二重）                              | `500`                |
| `voice.levelThreshold`              | 音量のしきい値（`level`のとき。RMS、0〜1）                                            | `0.02`               |
| `voice.minSpeechMs`                 | これより短い音は声とみなさない                                                        | `300`                |
| `voice.preSpeechPadMs`              | 声の始まりより前に含める長さ（語頭が切れないように）                                  | `300`                |

まばたきを`render.idleFps`の1コマより短くすると、見えないことがあります（初期値では1コマ100ms、まばたき150ms）。

#### 音声入力

機体は、マイクを1回だけ開いたままにし、声を検出した区間を16kHzモノラルのWAVにして、バックエンドへ`voice`で送ります（バックエンドが`whisper-server`で文字にします）。マイクの許可は、機体アプリ（Tauri）がカメラ・マイクの要求だけを許可します。

- **検出の方式**（`voice.detector`）：`silero`はSilero VAD（`@ricky0123/vad-web`）で、雑音に強い一方、CPUを使います。モデルとWASMはビルドに同梱し、`/vad/`から読みます。`level`は音量（RMS）が`voice.levelThreshold`を超えたかだけを見る軽い方式で、静かな場所向けです。機体のPC（Core m7）での負荷は、タスクマネージャーで見て決めます
- **区切り**：声が`voice.minSpeechMs`より短ければ捨て、声のあと`voice.silenceMs`の無音で発話の終わりとし、`voice.maxUtteranceMs`を超えたらそこで区切って送ります。語頭が切れないよう、声の始まりより`voice.preSpeechPadMs`前から含めます
- **半二重**：機体のスピーカーの音を自分で拾わないため、返事を再生している間は聞きません。再生が終わってから`voice.halfDuplexGraceMs`たつまで、聞き始めません。聞くのは、機体が登録済みで、入力元が`robot`、マイクが一時停止でなく、LLM・VOICEVOX・音声認識がすべて応答していて、会話が待機中のときだけです（`apps/robot/src/voice/listenGate.ts`）。声を検出すると`listening`を送り、目が大きくなります（S02h）。`voice`を送ったあと、バックエンドから結果（考え中や待機中）が届くまでは聞きません
- マイクの一時停止と入力元の切り替えは、バックエンドのターミナルのキー（`m`、数字キー）か管理CLI（`bun run admin mic`・`source`）で行います

### バックエンドと入力ページ

バックエンド（`apps/backend`）は、入力ページ（`apps/console`）のビルド成果物の配信と、WebSocket（`/ws`）を受け持ちます。入力ページは、バックエンドとWebSocketでつながり、切れたら自動で再接続します。

**スタブで動かす**（LLMとVOICEVOXなし。開発機だけで会話の流れを確かめられます）

```powershell
bun run console:build    # 入力ページをビルドする（apps/console/dist）
bun run backend:stub     # バックエンドをスタブで起動する
```

ブラウザで`http://localhost:8787/?device=tablet`を開き、登録コードを入れて登録します（「端末の登録」）。ターミナルで`2`を押して入力元を`tablet`にすると、話しかけられます。スタブは、約1.5秒考えてから決まった返事を順に返します。返事の中身は`apps/backend/src/dialogue/stub_replies.json`にあります。

- 発言に「崩れ」を含めると形式の崩れた返事（感情は`neutral`になる）、「落ちて」を含めるとLLMの失敗を再現します
- 禁止語の差し替えを確かめるため、スタブだけの禁止語「きんしご」を足しています。発言に「きんしご」を含めると入力の差し替え、「言わせて」を含めると禁止語を含む返事の差し替えを再現します
- バックエンドを起動したターミナルで`l`を押すとLLM、`t`を押すとVOICEVOXが止まった状態になり、もう一度押すと戻ります（入力ページの全面の案内と、機体の眠っている顔を確かめられます）。数字キーなどのほかのキーは「展示当日の運用」の「端末の切り替え」と同じです
- スタブの会話ログは`logs/stub/`に書きます（本番の会話ログに混ぜないため）

**実際のAPIで動かす**（後述の「仮のサーバー」、または本番のバックエンドPC）

```powershell
bun run console:build
bun run backend          # config/backend.*.json の llm・tts の接続先につなぐ
```

人格プロンプトは、2つのファイル`config/persona_self.md`（自己認識の事実）と`config/persona.md`（性格・話し方・調べる判断・質問の頻度）を、この順につないで読みます（「検索と人格プロンプト」）。どちらもなければ、返事の形式の指示だけでLLMに問い合わせ、起動時に警告を出します。返事の形式の指示（`{"say", "emotion", "search"}`のJSONで返す）は`apps/backend/src/dialogue/reply_format.md`にあり、人格プロンプトのあとに付けて渡します。

**入力ページを開発する**（変更をすぐ反映する）

```powershell
bun run backend:stub     # 別のPowerShellで起動しておく
bun run console:dev      # Viteの開発サーバー（http://localhost:5173/、LANからも開ける）
```

開発サーバーは`/ws`をバックエンド（既定は`http://127.0.0.1:8787`）へ中継します。バックエンドのポートを変えたときは、環境変数`BACKEND_URL`で中継先を指定します。疑似ロケールは開発サーバーでだけ使えます（`?locale=pseudo`）。

**端末名と入力元**：入力ページは、URLの`?device=`で端末名を名乗ります（省略すると`tablet`）。端末名は`config/backend.*.json`の`inputSources.consoles`にあるものだけ登録できます。入力を受け付けるのは、有効な入力元1つだけです。起動時は`inputSources.active`（初期値は機体のマイクの`robot`）が有効で、バックエンドを起動したターミナルの数字キーで切り替えます（`1`が`robot`、`2`以降が`inputSources.consoles`の順）。スタッフのスマホは`?device=phone`で開きます。入力元が自分でない入力ページには「いまは別の端末で受け付けています」の全面の案内が出ます（入力元が`robot`のときは、入力ページはログの表示専用になり、入力行を隠して「聞いています」などを出します）。

**全面の案内**：バックエンドにつながらないとき、LLMかVOICEVOXが応答しないときは、入力ページに「テクロボくんにつながっていません」の全面の案内が出て、キーボードが閉じます。つながれば自動で元の表示に戻ります。キーボードが自動で開かない端末では、ログの部分をタップすると開きます。

**画面の高さ**：入力ページは、キーボードを除いて実際に見えている範囲（`visualViewport`）に画面の高さを合わせ、ブラウザがページをずらした分も打ち消します（`apps/console/src/viewport_fit.ts`）。PWAとして起動していないときは、最初のタップで全画面表示にします（全画面を抜けても、次のタップで戻ります）。

### 端末の登録

入力ページと機体アプリは、登録コードをトークンと交換して登録し、以後はトークンでつなぎます。トークンのない接続、知らない・無効にしたトークンの接続からは、会話のメッセージを受け付けません（入力ページは「この端末は登録されていません」、機体はカメラの登録の画面になります）。

**仕組み**

- 登録コードは`XXXX-XXXX`の8文字です。読み違えやすい文字（`0`・`O`・`1`・`I`・`L`）を使いません。有効なのは60秒・1回だけで、同時に有効なコードは1つです（新しく出すと、前のコードは使えなくなります）。コードは管理用APIからだけ出せます（本番はランチャー、開発中はバックエンドのターミナルの`p`か管理CLI）
- 入力ページはコードを文字で入れます。機体は、QR（中身は`{publicUrl}/pair#XXXX-XXXX`）をカメラで読み、接続先とコードを取り出します
- 交換で得たトークンは、入力ページは`localStorage`（端末名ごと）、機体はアプリの`localStorage`に保存します。バックエンドは、トークンのSHA-256だけを保存します。入力ページは名乗った端末名、機体は機体として登録したトークンでだけつながります
- 失敗が続いたら、接続元ごとに受け付けません（初期値：1分に5回で5分）。接続元は、トンネル（cloudflared）が付ける`CF-Connecting-IP`ヘッダー、なければ接続のアドレスです。本番は公開用ポートを`127.0.0.1`で待ち受けるので、ヘッダーを偽って直接つなぐ経路はありません
- 登録を解除する（トークンを無効にする）と、その端末の接続を切ります。端末はつなぎ直して断られ、登録の画面に戻ります

**data/**：登録済みの端末は`data/devices.json`（Git管理外）にあります。1行が1台で、`id`・役割（`robot`・`console`）・名前・トークンのハッシュ・登録日時・無効にした日時です。無効にした行も残します。書くときは、一時ファイルに書いてから置き換えます。スタブのバックエンドも同じファイルを使います（切り替えるたびに登録し直さなくてよいように）。消すと、すべての端末が登録し直しになります。

**管理用API**：バックエンドは、`127.0.0.1:8788`（`admin.port`）で管理用APIを待ち受けます。トンネルには載せません。Hostが`127.0.0.1`・`localhost`でない要求と、Originが手元でない要求は断ります（ブラウザ経由の不正な呼び出しを防ぐため）。

| 呼び出し                     | 内容                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `GET /admin/status`          | 状態（会話の状態、入力元、接続・応答の有無、登録済みの端末など） |
| `POST /admin/pairing-codes`  | 登録コードを出す（`code`・`expiresAt`・`qr`）                    |
| `DELETE /admin/devices/{id}` | 登録を解除し、その端末の接続を切る                               |
| `WS /admin/events`           | 状態と、できごと（`paired`・`unpaired`など）を流す               |

**開発用の管理CLI**：バックエンドを起動しておき、別のPowerShellで使います。

```powershell
bun run admin status                     # 状態
bun run admin pair                       # 登録コードを出し、QRをdata/pairing_qr.svgに書き出す（--out で場所を変える）
bun run admin exchange                   # コードを出して、機体としてトークンに交換する（コードを渡すとそれを使う）
bun run admin exchange --role console --device phone   # 入力ページの端末としてトークンに交換する
bun run admin devices                    # 登録済みの端末（idと接続中かどうか）
bun run admin revoke {id}                # 登録を解除する
bun run admin reset                      # LLMに渡す会話の履歴を消す（入力ページに区切りの行が出る）
bun run admin model main|sub             # LLMのモデルの別名を切り替える（llama-server側のモデルの入れ替えは別に行う）
```

バックエンドを起動したターミナルで`p`を押しても、登録コードとQRの中身を出せます。

**開発機での登録**

1. `bun run console:build`のあと、`bun run backend:stub`（または`bun run backend`）を起動します
2. **入力ページ**：ブラウザで`http://localhost:8787/?device=tablet`を開くと、「この端末は登録されていません」と登録コードの入力行が出ます。ターミナルで`p`を押し（または`bun run admin pair`）、出たコードを60秒以内に入れて［登録］を押します。小文字・ハイフンなしでも受け付けます。登録できると、入力ページの表示に戻ります。失敗したときは入力が消えるので、新しいコードを出して入れ直します
3. **機体アプリ（カメラがある）**：`apps/robot`で`bun run tauri dev`を起動すると、カメラの登録の画面になります。`bun run admin pair`で書き出した`data/pairing_qr.svg`をブラウザで開き、画面のQRをカメラに見せます。QRの接続先は`publicUrl`なので、同じPCなら初期値（`http://localhost:8787`）のままでかまいません
4. **機体アプリ（カメラがない）**：`bun run admin exchange`を実行し、出た内容を`apps/robot/src/config/config.local.json`に書いて、機体アプリを起動し直します。開発用の`backend.url`・`backend.token`は、QRで登録して保存したものより優先します（QRでの登録を試すときは、この2つを消します）

```json
{
  "backend": { "url": "ws://localhost:8787/ws", "token": "{exchangeで出たトークン}" }
}
```

5. **登録の解除を確かめる**：`bun run admin devices`で`id`を調べ、`bun run admin revoke {id}`を実行します。その端末は登録の画面（入力ページは登録コードの入力、機体はカメラ）に戻ります

**LANの別の端末から試す**：`config/backend.local.json`に、`host`を`0.0.0.0`、`publicUrl`を`http://{開発機のLANのIP}:8787`と書きます（QRの中身の接続先が、ほかの端末から届くURLになるように）。管理用APIは、`host`に関係なく`127.0.0.1`だけで待ち受けます。

```json
{
  "host": "0.0.0.0",
  "publicUrl": "http://192.168.0.10:8787"
}
```

### タブレットへのインストール

展示用のタブレット（Android版のEdge）には、入力ページをPWAとしてインストールし、アドレスバーを出さない全画面で起動します。PWAのインストールはHTTPSが条件ですが、入力ページはHTTP（`http://{IP}:8787`）のままなので、Edgeのflagsで、そのオリジンを安全なオリジンとして扱わせます。flagsはその端末のEdge全体に効くため、展示用のタブレットにだけ設定します。

1. バックエンドを起動しておき（`bun run console:build`のあと`bun run backend`、または`bun run backend:stub`）、そのPCのLANのIPアドレスを調べます（PowerShellで`ipconfig`の「IPv4 アドレス」）。タブレットのEdgeで`http://{IP}:8787/?device=tablet`が開けることを確かめます
2. タブレットのEdgeのアドレスバーに`edge://flags`と入力し、`Insecure origins treated as secure`（`#unsafely-treat-insecure-origin-as-secure`）を探します
3. テキスト欄に、バックエンドのオリジンを入れます：`http://{IP}:8787`（スキーム・IP・ポートまで。パスと`?device=`は付けない。複数あるときはカンマ区切り）。項目を`Enabled`にし、下に出る再起動のボタンでEdgeを再起動します
4. `http://{IP}:8787/?device=tablet`を開き直し、Edgeのメニュー（`…`）から、アプリとしてインストールする項目（「ホーム画面に追加」など）を選びます。インストールされると、ホーム画面にtekurobokunのアイコンが増えます
5. ホーム画面のアイコンから起動し、アドレスバーが出ないこと、横向きになること、状態行と入力行がキーボードに隠れないことを確かめます

- インストールしたPWAは、マニフェストの`start_url`（`/?device=tablet`）で起動します。スタッフのスマホは、インストールせずにブラウザで`?device=phone`を開いて使います
- **オリジンが変わったら、やり直します**。仮のサーバー（開発機）から本番（バックエンドPC）に移ったとき、IPアドレスやポートが変わったときは、古いアプリをアンインストールし、手順2〜4をやり直します（flagsのオリジンを書き換え、インストールし直す）。PWAは、インストールしたときのオリジンにしかつながりません。会場では、バックエンドPCのIPアドレスをルーターの設定で固定しておくと、やり直しを避けられます
- Android版のEdgeでも、flagsの項目はChromeと同じです（2026年11月に展示用のタブレットで確認）。インストールしたPWAは全画面で起動します。起動の直後はステータスバーが透けて見えますが、少しすると隠れます

**キーボードとのずれの調節**：キーボードを出したときに、入力行の下がキーボードの上端の帯などに隠れる場合は、`config/backend.local.json`の`console.bottomInsetPx`で、画面の下に空ける余白（px）を足します。設定はバックエンドの起動時に読むので、書き換えたらバックエンドを再起動します。入力ページは自動で再接続し、新しい値を反映します（アプリを開き直す必要はありません）。

```json
{
  "console": { "bottomInsetPx": 24 }
}
```

### 設定ファイル

設定は`config/backend.default.json`（Gitで管理）にあり、同じフォルダに`config/backend.local.json`（Git管理外）を置くと、書いた項目だけを上書きします。オブジェクトは項目ごとに、配列と値はまるごと置き換えます。

```json
{
  "llm": { "baseUrl": "http://192.168.0.10:8080", "activeAlias": "sub" }
}
```

| 項目                                               | 内容                                                                                                                   | 初期値                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `host`                                             | 公開用ポートの待ち受け先。本番は`127.0.0.1`（トンネルだけが届く）。LANから試すときは`0.0.0.0`                          | `127.0.0.1`                                     |
| `port`                                             | 公開用ポート（入力ページとWebSocket）                                                                                  | `8787`                                          |
| `publicUrl`                                        | 登録のQRに入れる公開URL。LANから試すときは`http://{LANのIP}:8787`                                                      | `http://localhost:8787`                         |
| `admin.port`                                       | 管理用API（`127.0.0.1`だけで待ち受ける）                                                                               | `8788`                                          |
| `llm.baseUrl`                                      | llama-serverの接続先（OpenAI互換API）                                                                                  | `http://127.0.0.1:8080`                         |
| `llm.models.{main,sub}`                            | 正・副のモデル名（llama-serverの`--alias`）と、生成の上限トークン数（`maxTokens`）・温度                               | `qwen3-8b`・`qwen3-4b`、`256`・`0.7`            |
| `llm.activeAlias`                                  | 起動時に使うモデルの別名（`main`・`sub`）                                                                              | `main`                                          |
| `llm.contextTurns`                                 | LLMに渡す直近の往復数                                                                                                  | `4`                                             |
| `llm.jsonSchema`                                   | JSONスキーマ制約（`response_format`）を使うか                                                                          | `true`                                          |
| `llm.timeoutMs`                                    | LLMの応答を待つ上限                                                                                                    | `60000`                                         |
| `tts.baseUrl`・`tts.speaker`                       | VOICEVOX ENGINEの接続先と話者（スタイルのid）                                                                          | `http://127.0.0.1:50021`・`1`                   |
| `inputSources.consoles`                            | 入力ページの端末名（順番は、入力元を切り替える数字キーの`2`以降の順）                                                  | `["tablet", "phone"]`                           |
| `inputSources.active`                              | 起動時の入力元（`robot`か、`inputSources.consoles`の端末名）                                                           | `robot`                                         |
| `pairing.codeTtlMs`                                | 登録コードの有効時間                                                                                                   | `60000`                                         |
| `pairing.maxFailures`・`failureWindowMs`・`lockMs` | 接続元ごとに、`failureWindowMs`の間に`maxFailures`回失敗したら`lockMs`の間受け付けない                                 | `5`・`60000`・`300000`                          |
| `stt.provider`                                     | 音声認識の実装（`whisper`・`stub`）。スタブは`--stub`で選ばれる                                                        | `whisper`                                       |
| `stt.timeoutMs`                                    | 音声認識の応答を待つ上限                                                                                               | `10000`                                         |
| `stt.whisper.url`・`language`                      | `whisper-server`の接続先（`/inference`と`/health`）と、話す言語（翻訳はしない）                                        | `http://127.0.0.1:8081`・`ja`                   |
| `stt.whisper.hallucinations`                       | 結果の全体がこのどれかと一致したら、空の発話として捨てる決まり文句（「音声認識」の節）                                 | 「ご視聴ありがとうございました」など            |
| `stt.whisper.logprobThreshold`                     | すべての区切りで認識の確からしさ（`avg_logprob`）がこれを下回ったら、空の発話として捨てる（0以下）                     | `-0.3`                                          |
| `stt.bench`                                        | 音声認識の比較の設定（実行ファイル・モデルのフォルダ・モデルの一覧・VADのモデル`vadModel`。「音声認識の比較」）        | モデル3つ（パスは空）、`ggml-silero-v6.2.0.bin` |
| `search.{provider,apiKey,maxResults,timeoutMs}`    | 検索の実装（`tavily`・`stub`）、TavilyのAPIキー、1回の検索で取る結果の件数、検索を待つ上限（「検索と人格プロンプト」） | `tavily`・空・`3`・`8000`                       |
| `dialogue.questionLoopThreshold`                   | 直近の返事がこの回数続けて質問で終わったら、次の返事に「質問で終わらない」指示を足す                                   | `2`                                             |
| `session.idleResetMs`                              | だれも話さない時間がこれを超えたら、LLMに渡す履歴を消す（入力ページには区切りの行が出る）                              | `90000`                                         |
| `console.autosendMs`                               | 入力が止まってから自動で送るまでの時間（`0`で自動送信しない）                                                          | `3000`                                          |
| `console.fontSizePx`                               | 入力ページの文字の大きさ                                                                                               | `18`                                            |
| `console.bottomInsetPx`                            | 入力ページの下に空ける余白（キーボードとのずれの調節。前述）                                                           | `0`                                             |
| `console.prompt`                                   | プロンプトの表示（`user`・`host`・`dir`。ディレクトリ名はイベントごとに変える）                                        | `user`・`nid-techtech`・`~/makers`              |
| `speakingGraceMs`                                  | 話し中のタイムアウトの余裕（送った音声の長さの合計に足す）                                                             | `5000`                                          |
| `healthIntervalMs`                                 | llama-serverとVOICEVOXへの問い合わせの間隔                                                                             | `5000`                                          |
| `historyDisplayTurns`                              | 入力ページに送る表示用の履歴の件数                                                                                     | `50`                                            |

バックエンドは、`llm.baseUrl`の`/health`と`tts.baseUrl`の`/version`に定期的に問い合わせます。LLMかVOICEVOXが応答しない間は、発言を受け付けません（入力ページは全面の案内、機体は眠っている顔）。応答が戻れば、自動で受け付けに戻ります。機体アプリがつながっていない間は、音声を作らず、返事を出したらすぐ待機中に戻ります。

返事は文（句点・感嘆符・疑問符・改行）ごとに音声にして機体アプリへ送り、1文目の再生中に2文目を合成します。機体アプリが最後の文の再生終了を知らせると待機中に戻ります。届かないときは、送った音声の長さの合計に`speakingGraceMs`を足した時間で待機中に戻ります。話し中に機体アプリが切断したときは、すぐ待機中に戻ります。

### 禁止語と会話ログ

**禁止語**：入力と返事の両方を禁止語リストで検査し、当たったら定型の返事に差し替えます。入力が当たったときは、LLMに渡しません（その後の会話でも渡しません）。照合は、全角・半角、大文字・小文字、空白の違いを無視した部分一致です。カタカナとひらがなは区別します（「イク」が「いくつ」に当たらないように）。

- `config/filter.default.json`（Gitで管理）は、禁止語なしと仮の定型の返事だけです
- 本番の禁止語リストと定型の返事は`config/filter.local.json`（Git管理外）にあります。[MosasoM/inappropriate-words-ja](https://github.com/MosasoM/inappropriate-words-ja)（MIT License）の性的・攻撃的な語をもとに、普通の会話に当たる語（「カス」→カスタム、「インポ」→インポート など）を除いて作りました。出典は同じファイルの`_source`にあります。除いた語と理由は`roadmap/development/261114070342_change_filter_words.md`にあります
- 語を足すときは、短い語ほど普通の文の一部に当たりやすいことに気をつけてください。書き換えたらバックエンドを再起動します

```json
{
  "words": ["バカ", "アホ"],
  "replies": [
    { "say": "その話にはお答えできません。ものづくりの話をしませんか？", "emotion": "troubled" }
  ]
}
```

**会話ログ**：1回の発言につき1行のJSONを、`logs/{日付}.jsonl`（日付はJST）に追記します。項目は、日時、入力元の端末、発言、考えた時間、LLMの生の出力、採用した返事と感情、禁止語での差し替え（`none`・`input`・`output`）、エラー（LLMが応答しなかったときの`llm_unavailable`）です。受け付けなかった発言（考え中・話し中の発言、有効でない端末からの発言）は残しません。バックエンドを起動すると、当日のファイルの末尾から`historyDisplayTurns`件を、入力ページの表示用に読み込みます（LLMに渡す往復には使いません）。

### 検索と人格プロンプト

**検索の設定**：来場者の質問にWebで調べて答える機能は、[Tavily](https://www.tavily.com/)のREST API（`POST https://api.tavily.com/search`、`search_depth: basic`）を使います。

1. Tavilyに登録して、APIキーを取ります
2. `config/backend.local.json`（Git管理外）に書きます。キーは`config/backend.default.json`（Gitで管理）に書かないでください
3. バックエンドを再起動します

```json
{
  "search": { "apiKey": "tvly-...", "maxResults": 3, "timeoutMs": 8000 }
}
```

- `maxResults`は、1回の検索で取る結果の件数です。結果は、1件300文字に切ってLLMに渡します。多いほど答えは詳しくなりますが、2回目のLLMの入力が増えて、返事が遅くなります
- `timeoutMs`を超えたら検索の失敗として扱い、「調べられなかった」と答えます（`search_failed.md`）
- APIキーが空のまま起動すると、警告を出し、検索は毎回失敗します。LLMもTavilyもなしで試すときは、`bun run backend:stub`か、`search.provider`を`stub`にします（スタブは決まった抜粋を返します。検索語に「しっぱい」を入れると失敗、「つかいきり」を入れると無料枠の使い切りを再現します）
- 無料枠は月1,000クレジットです。超えると検索は止まり（課金はされません。2026年11月に確かめました）、使い切りの理由で失敗して、「調べられなかった」と答えます。会話は続きます。1回の検索は、`basic`で1クレジットです

**今月の検索回数の確かめ方**：次のどれでも確かめられます（月はJSTで、月が変わると0に戻ります）。

```powershell
bun run admin status            # search=12 (2026-11) の形で出る
Get-Content data\usage.json     # {"month": "2026-11", "searchCount": 12}
```

バックエンドの起動時のログにも、今月の回数が出ます。回数は、Tavilyが断った応答（401・429・432〜434）を除いて、送った要求を数えます。時間切れと5xxは、多めの側に数えます。正確なクレジットの残りは、Tavilyの管理画面で確かめてください。スタブの回数は`data/stub/usage.json`に分かれます。

**人格プロンプトの2つのファイル**：どちらも、バックエンドの起動時に読みます。書き換えたら、バックエンドを再起動します（比較スクリプトは、流すたびに読みます）。

| ファイル                 | 書くこと                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `config/persona_self.md` | 自己認識の事実（名前、所属、体のつくり、今日はできないこと、言わないこと）。先頭に置かれる |
| `config/persona.md`      | 性格、話し方の決まり、調べるかどうかの判断、質問の頻度の方針、会話の例                     |

- `persona_self.md`が、見出しだけのとき（雛形のまま）は、ないものとして扱い、起動時に知らせます。事実を書かないと、モデルが体や所属を作り話で答えます
- 2つのファイルの内容は、食い違わないようにします。たとえば、走行や人の見え方が、`persona_self.md`と`persona.md`で違うと、モデルはどちらかに引かれて答えます
- 返事の形式（`reply_format.md`）、検索結果を使うときの指示（`search_results.md`）、検索できなかったときの指示（`search_failed.md`）、質問のループを防ぐ指示（`anti_loop.md`）は、`apps/backend/src/dialogue/`にあります。人格プロンプトのあとに、状況に応じて付けて渡します
- 直したら、「モデルの比較」で、検索の判断（検索すべき・すべきでない）と、台本での質問の頻度を確かめます

### モデルの比較

同じ質問のセットを接続先ごとに投げ、考えた時間、形式の崩れの数、検索の判断、自己認識の返事、複数ターンの台本での様子を一覧にします（`scripts/bench_dialogue.ts`）。人格プロンプトと返事の形式は、バックエンドと同じものを使います。

```powershell
bun run bench                                    # config/bench.*.json の接続先すべて
bun run bench -- --target qwen3-8b               # 1つの接続先だけ（名前をカンマで区切って複数も可）
bun run bench -- --only search,self              # 区分を絞る（general・search・self・scripts）
bun run bench -- --repeat 3                      # 質問のセットを3回くり返す
bun run bench -- --search tavily                 # 台本で、実際に検索して2回目の返事まで確かめる
bun run bench -- --no-model-check                # 読み込み中のモデルを確かめない
```

- **質問の区分**：`general`（ふつうの質問）、`search`（検索の判断。検索すべき質問と、検索すべきでない質問）、`self`（自己認識を問う質問）、`scripts`（複数ターンの台本）。質問・台本・質問の型の判定は`config/bench.default.json`にあり、`config/bench.local.json`で上書きできます（配列はまるごと置き換わります）
- **検索の判断**：1回目の返事の`search`が、検索すべき質問で出たか、検索すべきでない質問で出なかったかを数えます
- **台本**：設定の往復数（`contextTurns`）で履歴を渡し、質問のループを防ぐ指示も、バックエンドと同じ条件で足します。要約に、質問で終わった割合と、同じ型の質問が続いた回数を出します。検索語が出たときの2回目は、`--search`で選びます：`none`（既定。検索の失敗として問い合わせる）、`stub`（決まった抜粋）、`tavily`（実際に検索する。今月の回数に数える。台本1回で数回使います）
- **接続先**：`baseUrl`・`model`のほか、`jsonSchema`・`maxTokens`・`temperature`・`contextTurns`を変えられます（書かない項目は`config/backend.*.json`の`llm`の値）。llama-serverには1つのモデルだけを載せるため、`/v1/models`のidに、接続先の`match`（なければ`model`）が含まれない接続先は、飛ばします。測るモデルでllama-serverを起動し直してから、`--target`で選びます
- **結果**：`logs/bench/{日時}.md`に書き出し、要約の表を表示します。考えた時間は1問ずつの質問（ふつう・検索の判断・自己認識）の値で、台本の「質問で終わった割合」と「同じ型の連続」は、台本すべての合計です

### 音声認識の比較

録音のセットを、モデルごとに`whisper-server`を起動し直して流し、認識結果・正解との文字の誤り率・かかった時間・捨てた数（理由別）を一覧にします（`scripts/bench_stt.ts`）。バックエンドは起動しません。

**録音のセットを作る**：`data/stt_bench/`（Git管理外）に、16kHzモノラルのWAV（`名前.wav`）と、正解の文（`名前.txt`、UTF-8）を、同じ名前で置きます。

- 来場者が言いそうな発話（`こんにちは`、`きみは誰？`など）は、正解の文を`名前.txt`に書きます。機体のマイクで録ると、本番に近い条件で比べられます（録音の道具は問いません。16kHzモノラルでなければ、`ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav`などで変換します）
- 無音・生活音・雑音だけの録音は、**空の`名前.txt`**を置きます（何も出さないのが正しい録音）。`.txt`がない録音は、警告して飛ばします
- 正解の文字数が少ない録音ばかりにならないよう、短い発話と長い発話の両方を入れます。誤り率は、録音ごとの率の平均ではなく、誤りの合計を正解の文字数の合計で割ります

**設定**：実行ファイルとモデルのフォルダは、マシンごとに違うため、`config/backend.local.json`に書きます（引数の`--exe`・`--models-dir`でも渡せます）。比べるモデルは`stt.bench.models`にあり、初期値は`setup_whisper.ps1`が取得する3つです（配列はまるごと置き換わるので、変えるときは全部書きます）。

```json
{
  "stt": {
    "bench": {
      "executable": "C:\\Users\\{ユーザー}\\tekurobo_servers\\whisper.cpp\\bin\\vulkan\\whisper-server.exe",
      "modelsDir": "C:\\Users\\{ユーザー}\\tekurobo_servers\\whisper.cpp\\models"
    }
  }
}
```

**実行**

```powershell
bun run bench:stt                                  # stt.bench.models のすべて
bun run bench:stt -- --model large-v3-turbo-q5_0   # 1つのモデルだけ
bun run bench:stt -- --gpu-memory                  # 専用GPUメモリの増え方も測る（Windows）
bun run bench:stt -- --timeout-ms 120000           # 1回の認識を待つ上限（初期値60000）
bun run bench:stt -- --no-vad                      # VADなしで起動する（VADの効き目を比べる）
bun run bench:stt -- --logprob-threshold -0.25     # 確からしさのしきい値を、設定の代わりにこの値で試す
```

- `whisper-server`の接続先とポートは`stt.whisper.url`のとおりです（すでに動いていたら、止めてから実行するよう求めて終わります）。起動オプションを足すときは、`stt.bench.extraArgs`に書きます（`-m`・`--host`・`--port`・`-l`と、VADの`--vad -vm`はスクリプトが付けます）
- **VAD**：`stt.bench.vadModel`（`modelsDir`の中のファイル名か絶対パス。初期値`ggml-silero-v6.2.0.bin`）があれば、本番と同じく`--vad -vm`を付けて起動します。空にするか`--no-vad`でVADなしです。ファイルがなければ、始める前に止まります。VADのしきい値などを試すときは、`stt.bench.extraArgs`に`["-vt", "0.6"]`のように書きます
- 捨てる決まり文句としきい値は、本番と同じ`stt.whisper`の値です（`--logprob-threshold`で確からしさのしきい値だけ差し替えられます）。最初の1回は準備（GPUの初期化など）のため、測りません
- 結果は`logs/bench/{日時}_stt.md`に書きます。冒頭に条件（VADの有無・追加の引数・確からしさのしきい値）を書き、要約の表に、モデルごとの誤り率・時間（中央値・平均・最大）・捨てた数（`empty` / `low_logprob` / `hallucination`）・「無音で文が出た」（無音の録音で、捨てられずに文が出た数）・「発話を捨てた」（発話を誤って捨てた数）・`avg_logprob`の「発話の下端」と「雑音の上端」・読み込みの時間を出し、続けて、無音・雑音の録音にモデルが出した文（決まり文句の候補）と、録音ごとの結果（区切りの`avg_logprob`。区切りが複数なら「最小〜最大」）を出します
- **確からしさのしきい値の決め方**：`low_logprob`は「すべての区切りが下回る」ときに捨てるため、録音を捨てるかどうかは、その録音の区切りの`avg_logprob`の最大で決まります。「発話の下端」は発話の録音ごとの最大のうち最も低い値、「雑音の上端」は、無音・雑音の録音で文が出たもの（VADを通り抜けたもの）の最大のうち最も高い値です。しきい値を「雑音の上端」より大きく、「発話の下端」以下に置けば、発話を捨てずに雑音を捨てられます
- GPUメモリは、Windowsの性能カウンター（`GPU Adapter Memory`の`Dedicated Usage`）の、大きい方のアダプターの値で、モデルを読み込む前との差です。llama-serverなど、ほかのGPUの使用が動いていると、その増減も混ざります
- サーバーのログは`logs/bench/whisper_server_{モデル名}.log`に残ります

## 開発機の仮のサーバー

LLM・音声認識・音声合成は、本番ではバックエンドPC（Windows 11）で動かします。その準備を待たずに実際のAPIで会話を確かめるため、開発機（Windows）に同じサーバーを置きます。CPUで動かす想定です（開発機のGPUが使えれば、それでもかまいません）。バックエンドPCにも、この手順でサーバーを置きます。違いは「バックエンドPC（本番）」にあります。

以下では、サーバー一式を`$HOME\tekurobo_servers`に置きます。リポジトリの外に置いてください。

```powershell
New-Item -ItemType Directory -Force "$HOME\tekurobo_servers" | Out-Null
```

### llama-server（llama.cpp）

正のモデルはQwen3-8B、副（バックアップ）はQwen3-4Bです（どちらも4bitのGGUF、Apache-2.0。2026年11月、Phase 8の比較で決めました）。本番のバックエンドPCでも、同じポートと`--alias`で起動します。1つのllama-serverには1つのモデルだけを載せ、切り替えるときは入れ替えます。

| モデル         | ポート | `--alias`  | ファイル               | 入手先                                                          |
| -------------- | ------ | ---------- | ---------------------- | --------------------------------------------------------------- |
| Qwen3-8B（正） | 8080   | `qwen3-8b` | `Qwen3-8B-Q4_K_M.gguf` | [Qwen/Qwen3-8B-GGUF](https://huggingface.co/Qwen/Qwen3-8B-GGUF) |
| Qwen3-4B（副） | 8080   | `qwen3-4b` | `Qwen3-4B-Q4_K_M.gguf` | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF) |

1. [llama.cppのReleases](https://github.com/ggml-org/llama.cpp/releases)から、`b`で始まる最新のビルドの`llama-b{番号}-bin-win-cpu-x64.zip`をダウンロードします（GPUを使う場合は`win-vulkan-x64`）
2. `$HOME\tekurobo_servers\llama`に展開します
3. モデルを`$HOME\tekurobo_servers\models`にダウンロードします

```powershell
New-Item -ItemType Directory -Force "$HOME\tekurobo_servers\models" | Out-Null
curl.exe -L -o "$HOME\tekurobo_servers\models\Qwen3-8B-Q4_K_M.gguf" `
  "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf"
curl.exe -L -o "$HOME\tekurobo_servers\models\Qwen3-4B-Q4_K_M.gguf" `
  "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
```

起動（ポートは明示します。既定のポートは版によって変わるため）。副のQwen3-4Bは、正を止めてから、同じポートで起動します。GPUがない開発機では`-ngl all`を付けません（本番は付けます）。

```powershell
# Qwen3-8B（正、ポート8080）。思考出力はサーバーの側でも止める（バックエンドも enable_thinking: false を送る）
& "$HOME\tekurobo_servers\llama\llama-server.exe" `
  -m "$HOME\tekurobo_servers\models\Qwen3-8B-Q4_K_M.gguf" `
  --alias qwen3-8b --host 127.0.0.1 --port 8080 -c 4096 --reasoning off

# Qwen3-4B（副、同じポート8080。8081は`whisper-server`が使う）
& "$HOME\tekurobo_servers\llama\llama-server.exe" `
  -m "$HOME\tekurobo_servers\models\Qwen3-4B-Q4_K_M.gguf" `
  --alias qwen3-4b --host 127.0.0.1 --port 8080 -c 4096 --reasoning off
```

`config/backend.default.json`の初期値は、正がQwen3-8B（`qwen3-8b`）、副がQwen3-4B（`qwen3-4b`）で、どちらも`http://127.0.0.1:8080`です。起動時に使うのは正（`llm.activeAlias`の初期値`main`）なので、上書きなしでつながります。**副に切り替える**ときは、llama-serverをQwen3-4Bで起動し直し、`config/backend.local.json`に次を書いて、バックエンドを再起動します（正に戻すときは、この行を消します）。

```json
{
  "llm": { "activeAlias": "sub" }
}
```

モデルの比較（`bun run bench`）の接続先は、「モデルの比較」にあります。開発機で測った考えた時間はCPUでの値で、バックエンドPC（RX480・Vulkan）での値とは違います。

モデルは、Phase 8のバックエンドPCでの比較（Qwen3-8B・Qwen3.5-9B・Qwen3.5-4B・Qwen3-4B）で決めました。Qwen3-8Bは、形式の崩れがなく、検索の判断と応答時間（中央値約0.8秒）のバランスが良く、`whisper-server`と合わせて専用GPUメモリ約6.7GBで8GBに収まります。副のQwen3-4Bは、応答が最も速く（中央値約0.6秒）、メモリも約4.6GBで余裕があります。Qwen3.5の2つは応答が遅く（1.6〜2.5秒）、選びませんでした。Gemma 4は、v6の開発機での比較（`roadmap/development/261113172152_change_model_qwen3.md`）で外れています。

### VOICEVOX ENGINE 0.25.2

1. [VOICEVOX ENGINEの0.25.2](https://github.com/VOICEVOX/voicevox_engine/releases/tag/0.25.2)から、`voicevox_engine-windows-cpu-0.25.2.7z.001`をダウンロードします
2. 7-Zipで展開します（`.7z.001`を開くと展開できます。約1.8GBが約2.2GBになります）。展開すると`windows-cpu`というフォルダができるので、その名前を`$HOME\tekurobo_servers\voicevox`に変えて置きます
3. `voicevox`フォルダの`run.exe`を起動します

```powershell
& "$HOME\tekurobo_servers\voicevox\run.exe" --host 127.0.0.1 --port 50021
```

VOICEVOXの利用規約により、VOICEVOXを利用したことがわかるクレジット表記が必要です。キャラクターごとの利用規約もあります。展示の話者は琴詠ニア（ノーマル、スタイルid `74`。`config/backend.local.json`の`tts.speaker`）で、展示パネルに「音声：VOICEVOX 琴詠ニア」と書いています。話者を変えたら、パネルの表記も変えてください。

### whisper-server（whisper.cpp）

音声認識は、[whisper.cpp](https://github.com/ggml-org/whisper.cpp)の`whisper-server`で行います。バックエンドが、機体から届いた発話のWAVを`/inference`へ送り、文字にします（言語は日本語に固定し、翻訳しません）。版はv1.9.5に固定しています（上げるときは、`apps/backend/src/stt/whisper.ts`の項目名と応答の形を、その版のソースで確かめ直します）。置き場所はリポジトリの外で、llama.cppとは別のフォルダです（ggmlのDLLを混ぜないため）。

`scripts/setup_whisper.ps1`が、ソースの取得・ビルド・モデルとVADのモデルの取得をまとめて行います。Git、CMake（PATHになければ、Visual Studioに付いてくるものを使います）、Visual StudioのC++のビルドツールが要ります。

```powershell
.\scripts\setup_whisper.ps1 -Backend cpu    # 開発機：Vulkanなしのビルドと、既定のモデル・VADのモデルの取得
.\scripts\setup_whisper.ps1                 # バックエンドPC：Vulkan版（Vulkan SDKが要る）
.\scripts\setup_whisper.ps1 -SkipModels     # ビルドだけ
.\scripts\setup_whisper.ps1 -SkipBuild -Models large-v3-turbo-q5_0   # モデルだけ（VADのモデルも取る）
.\scripts\setup_whisper.ps1 -SkipBuild -Models @()                   # VADのモデルだけ
```

| 場所（既定は`$HOME\tekurobo_servers\whisper.cpp`。`-Root`で変える） | 内容                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `src\`                                                              | ソース（`-Version`のタグ）                               |
| `build-{cpu,vulkan}\`                                               | ビルドの作業フォルダ                                     |
| `bin\{cpu,vulkan}\whisper-server.exe`                               | 実行ファイル（静的リンクで、単独で動く）                 |
| `models\`                                                           | モデル（途中で切れたら、同じコマンドで続きから取れます） |

取得できるモデル（`-Models`に名前を渡す。既定は上の3つ）：

| 名前                       | ファイル                            | 大きさ  | 取得元                                                                                                            |
| -------------------------- | ----------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `large-v3-turbo-q5_0`      | `ggml-large-v3-turbo-q5_0.bin`      | 約574MB | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)                                             |
| `large-v3-turbo-q8_0`      | `ggml-large-v3-turbo-q8_0.bin`      | 約874MB | 同上                                                                                                              |
| `kotoba-whisper-v2.0-q5_0` | `ggml-kotoba-whisper-v2.0-q5_0.bin` | 約538MB | [kotoba-tech/kotoba-whisper-v2.0-ggml](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml)（日本語向け） |

どのモデルを使うかは、音声認識の比較（「音声認識の比較」）で決めます（v8の時点では`large-v3-turbo-q5_0`）。

VADのモデル（`-VadModels`に名前を渡す。既定は`silero-v6.2.0`。空の配列`@()`なら取らない）：

| 名前            | ファイル                 | 大きさ  | 取得元                                                              |
| --------------- | ------------------------ | ------- | ------------------------------------------------------------------- |
| `silero-v6.2.0` | `ggml-silero-v6.2.0.bin` | 約0.9MB | [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad) |
| `silero-v5.1.2` | `ggml-silero-v5.1.2.bin` | -       | 同上（比べるときだけ）                                              |

起動（ポートは8081。`stt.whisper.url`の初期値と同じです）。組み込みのVAD（`--vad -vm`）を必ず付けます：

```powershell
& "$HOME\tekurobo_servers\whisper.cpp\bin\cpu\whisper-server.exe" `
  -m "$HOME\tekurobo_servers\whisper.cpp\models\ggml-large-v3-turbo-q5_0.bin" `
  --host 127.0.0.1 --port 8081 -l ja `
  --vad -vm "$HOME\tekurobo_servers\whisper.cpp\models\ggml-silero-v6.2.0.bin"
```

Vulkan版（バックエンドPC）は、同じ引数で`bin\vulkan\whisper-server.exe`を起動します（GPUで動きます。GPUを使わせないときは`-ng`）。`-p`（`--processors`）は付けません（v1.9.5では、2以上にすると、VADが音声の区間を見つけなかったときに前回の結果が残って返ります）。

- **開発機のCPUでは遅い**：large-v3-turboは、開発機（16スレッド、既定の4スレッド）で、3秒の発話に約25秒かかりました。バックエンドの`stt.timeoutMs`（初期値10秒）を超えて失敗します。開発機で会話の流れを確かめるときは、スタブ（`bun run backend:stub`）を使うか、`config/backend.local.json`で`stt.timeoutMs`を伸ばします
  Whisperは、無音や雑音だけの音声にも文を出すことがあります（開発機で3秒の無音を流すと「ご視聴ありがとうございました」が、W7-4では白色雑音・クリック音などで「はい」が出ました）。これを、次の順に防ぎ、空の発話として捨てます（機体のSilero VADとは別に、バックエンド側でもう一度確かめる形です）。

- **VAD**（`whisper-server`の`--vad -vm`）：Silero VADが音声の区間を見つけなければ、Whisperに音声を渡さず、`text`が空・区切りが0件の応答になります（理由`empty`）。VADのしきい値（`-vt`）などは既定（0.5）のままで、起動オプションに足しません（2026年11月、large-v3-turbo q5_0で、合成した無音・雑音7件をすべて捨て、発話7件は1件も捨てず、誤り率も変わりませんでした。捨てた雑音は1件約10msで返ります。専用GPUメモリの増分は、VADなしと同じ約670MB）
- **確からしさのしきい値**：`stt.whisper.logprobThreshold`（初期値`-0.3`）。`whisper-server`が返す区切りごとの`avg_logprob`（認識したトークンの対数確率の平均。0に近いほど確か）が、**すべての区切り**でこれを下回ったら捨てます（理由`low_logprob`）。「すべて」にするのは、長い発話の一部だけが不確かなときに全体を捨てないためです。上げる（0に近づける）ほど雑音をよく捨てますが、聞き取りにくい発話も捨てやすくなります。値は比較スクリプトの「発話の下端」「雑音の上端」で決めます。初期値は、VADなしで流したときに雑音から出た「はい」（−0.394〜−0.851）と、録音のセットの発話（下端−0.149〜−0.160）の間に置いたものです（2026年11月、large-v3-turbo q5_0。発話は1人の声の7件だけのため、会場で発話が捨てられたら（標準出力の`low_logprob`）下げます）
- **決まり文句**：結果の全体が`stt.whisper.hallucinations`のどれかと一致したら捨てます（理由`hallucination`）。空白・句読点・記号と全角・半角の違いは無視しますが、**部分一致にはしません**（本当にそう言った発話の一部を捨てないため）。一覧に足すときは、比較スクリプトの「決まり文句の候補」を見ます（配列はまるごと置き換わるので、`backend.local.json`には全部書きます）。来場者が答えに使う「はい」は、一覧に足しません
- v1.9.5の`no_speech_prob`（音声なしの確率）は、プロンプトを読ませた後の位置で取るため、無音でもつねに0になり、判断に使えません（v8で、音声なしのしきい値をやめました）
- 捨てた結果は、会話ログには残さず、バックエンドの標準出力に出します：`stt: discarded (low_logprob) " はい" [empty 3, low_logprob 1, hallucination 0]`
- 空の発話になったときは、機体は聞き取り中から待機中に戻り、何も記録しません。`whisper-server`が応答しないとき（`/health`が200でない）は、`health.stt`が`false`になります。入力元が`robot`のときは、入力ページは全面の案内、機体は眠っている顔になります（入力元がconsoleのときは、音声認識の応答を見ません）

### 動作確認のコマンド

サーバーを起動したまま、別のPowerShellで実行します。

**llama-server**

```powershell
# 準備ができていれば {"status":"ok"} が返る（読み込み中は503）
curl.exe -s http://127.0.0.1:8080/health

# モデル名（--aliasで付けた名前）が返る
curl.exe -s http://127.0.0.1:8080/v1/models

# 会話（OpenAI互換API）。choices[0].message.content に返事が入る
@'
{
  "model": "qwen3-4b",
  "messages": [{ "role": "user", "content": "こんにちは。一言で自己紹介してください。" }],
  "max_tokens": 128
}
'@ | Set-Content -Encoding utf8 "$env:TEMP\chat.json"
curl.exe -s http://127.0.0.1:8080/v1/chat/completions `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\chat.json"
```

**whisper-server**

```powershell
# 準備ができていれば {"status":"ok"} が返る（モデルの読み込み中は503）
curl.exe -s http://127.0.0.1:8081/health

# 文字にする。16kHzモノラルのWAVを渡し、応答の text に文が入る（バックエンドと同じ項目）
curl.exe -s http://127.0.0.1:8081/inference `
  -F "file=@voice.wav" -F "language=ja" -F "translate=false" -F "response_format=verbose_json"
```

**VOICEVOX ENGINE**

```powershell
# バージョン（"0.25.2"）が返る
curl.exe -s http://127.0.0.1:50021/version

# 話者の一覧。styles の id を、合成の speaker に使う
curl.exe -s http://127.0.0.1:50021/speakers

# 合成：audio_query で読み方を作り、synthesis でWAVにする（speaker=1 は例）
"こんにちは、テクロボくんです。" | Set-Content -Encoding utf8 "$env:TEMP\text.txt"
curl.exe -s -X POST "http://127.0.0.1:50021/audio_query?speaker=1" `
  --get --data-urlencode "text@$env:TEMP\text.txt" -o "$env:TEMP\query.json"
curl.exe -s -X POST "http://127.0.0.1:50021/synthesis?speaker=1" `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\query.json" -o "$env:TEMP\voice.wav"
Start-Process "$env:TEMP\voice.wav"   # 音声が再生されれば成功
```

バックエンドの接続先は、`config/backend.local.json`（Git管理外）で上書きします。仮のサーバーと本番で変わるのは、接続先とモデル名だけです。上の手順のポート（8080・8081・50021）とモデル名（`qwen3-4b`）は、`config/backend.default.json`の初期値と同じなので、仮のサーバーでは上書きなしで`bun run backend`につながります（項目は「設定ファイル」）。

## バックエンドPC（本番）

> 「自動起動」と「展示当日の運用」は、v5（0.1.0）の手順（会場でLLM・VOICEVOX・バックエンドを動かす構成）で、音声認識（`whisper-server`）を含みません。ランチャーに置き換わるPhase 10・11で書き直します。この節は、自宅のLANで動かす手順です。

自宅のバックエンドPC（Windows 11、Ryzen 5 3500、RX 5700 XT 8GB）に、次の4つを置いて動かします。機体・タブレット・スマホは、同じLANからつなぎます。

| 動かすもの                        | ポート | 備考                                                                                          |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| llama-server（Vulkan版）          | 8080   | 正のモデル`qwen3-8b`（`llm.main`）。副のモデル`qwen3-4b`（`llm.sub`）は同じポートで入れ替える |
| `whisper-server`（Vulkan版）      | 8081   | 音声認識（`stt`）                                                                             |
| VOICEVOX ENGINE 0.25.2（CPU版）   | 50021  | 音声合成                                                                                      |
| バックエンド（`bun run backend`） | 8787   | 入力ページと機体のWebSocket。LANに公開する。管理用APIは`127.0.0.1:8788`だけ                   |

llama-serverと`whisper-server`は、同じGPUのメモリ（8GB）を分け合います。下の起動オプション（Qwen3-8B Q4_K_M・文脈4Kと、large-v3-turbo q5_0）で、専用GPUメモリは、llama-serverの読み込み後に約5.9GB、`whisper-server`を足して約6.6GB、会話を続けたときの最大で約6.7GBでした（2026年11月、21ターンで測定）。モデルや文脈の長さを変えて足りなくなったら、文脈の長さを下げるか、`-ctk q8_0 -ctv q8_0`（KVキャッシュの量子化）を足して収めます。

ポート・`--alias`・フォルダの置き場所は、「開発機の仮のサーバー」と同じにします（サーバー一式は`$HOME\tekurobo_servers`）。PowerShellの管理者権限が要る手順には「（管理者）」と書いています。

### 準備（1回だけ）

1. **GPUのドライバー**：AMDのドライバー（AMD Software: Adrenalin Edition）の、RX 5700 XTに対応した版を入れます。llama-serverと`whisper-server`のVulkan版は、このドライバーのVulkanでGPUを使います
2. **Vulkan SDK**：[LunarG](https://vulkan.lunarg.com/sdk/home)のWindows版を入れます（環境変数`VULKAN_SDK`が設定されます。入れたあとは、新しいターミナルを開きます）。`whisper-server`のVulkan版のビルドに要ります
3. **Visual Studio（C++のビルドツール）**：Build Tools for Visual Studioか、Visual Studioのインストーラーで、「C++によるデスクトップ開発」を入れます（CMakeも含まれます）。`whisper-server`のビルドに要ります
4. **Git・Bun 1.4・Claude Code**を入れ、リポジトリをcloneします（「セットアップ」と同じ）。続けて入力ページをビルドします

   ```powershell
   bun install
   bun run console:build
   ```

5. **llama-server（Vulkan版）**：「開発機の仮のサーバー」の手順で置きます。ダウンロードするのは`llama-b{番号}-bin-win-vulkan-x64.zip`です。置いたら、GPUが見えていることを確かめます（一覧にRX 5700 XTの行が出れば使えます）

   ```powershell
   & "$HOME\tekurobo_servers\llama\llama-server.exe" --list-devices
   ```

6. **LLMのモデル**：次のGGUFを`$HOME\tekurobo_servers\models`に置きます。Qwen3-8B（正）とQwen3-4B（副）が本番で使うモデルで、Qwen3.5の2つはPhase 8の比較にだけ使いました（選ばなかったので、置かなくてもかまいません）

   | モデル     | `--alias`    | ファイル                 | 大きさ  | 入手先                                                          |
   | ---------- | ------------ | ------------------------ | ------- | --------------------------------------------------------------- |
   | Qwen3-8B   | `qwen3-8b`   | `Qwen3-8B-Q4_K_M.gguf`   | 約5.0GB | [Qwen/Qwen3-8B-GGUF](https://huggingface.co/Qwen/Qwen3-8B-GGUF) |
   | Qwen3-4B   | `qwen3-4b`   | `Qwen3-4B-Q4_K_M.gguf`   | 約2.5GB | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF) |
   | Qwen3.5-9B | `qwen3.5-9b` | `Qwen3.5-9B-Q4_K_M.gguf` | 約5.7GB | Hugging FaceのQwen3.5のGGUF（`Q4_K_M`）                         |
   | Qwen3.5-4B | `qwen3.5-4b` | `Qwen3.5-4B-Q4_K_M.gguf` | 約2.7GB | 同上                                                            |

   ```powershell
   curl.exe -L -C - -o "$HOME\tekurobo_servers\models\Qwen3-8B-Q4_K_M.gguf" `
     "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf"
   ```

   4つとも、llama-server b8884（Vulkan）で、`-c 4096 --reasoning off -ngl all`で全層がGPUに載り、返事が返ることを確かめました（モデルのファイルだけを入れ替えて、`--alias`を合わせます）。Qwen3.5はKVキャッシュが小さい（約128MiB）かわりに、計算用のバッファが約490MiBあります

7. **`whisper-server`（Vulkan版）とモデル**：`setup_whisper.ps1`を実行します（「whisper-server（whisper.cpp）」）。Vulkan SDKとVisual Studioが要ります

   ```powershell
   .\scripts\setup_whisper.ps1
   ```

8. **VOICEVOX ENGINE 0.25.2（Windows CPU版）**：「開発機の仮のサーバー」と同じ手順で置きます
9. **Git管理外の設定ファイル**を、開発機からUSBメモリなどでコピーして置くか、バックエンドPCで書きます（「開発機とバックエンドPCの間のGit」）
   - `config/backend.local.json`：話者（`tts.speaker`）と、LANで動かすための`host`・`publicUrl`（「バックエンドの設定（LAN）」）
   - `config/filter.local.json`：禁止語リストと定型の返事（「禁止語と会話ログ」）。置かないと、禁止語の検査をしません
10. **IPアドレスの固定**：自宅のルーターの設定（DHCPの固定割り当て）で、バックエンドPCのIPアドレスを固定します。変わると、タブレットのPWAと機体の登録（QRの接続先）をやり直すことになります（「タブレットへのインストール」）
11. **ネットワークとファイアウォール**（管理者）：LANのネットワークを「プライベート」にし、ポート8787（入力ページとWebSocket）の受信を許可します。llama-server（8080）・`whisper-server`（8081）・VOICEVOX（50021）は、バックエンドからだけ（`127.0.0.1`で）呼ぶので開けません

    ```powershell
    Get-NetConnectionProfile                     # InterfaceAlias（「イーサネット」など）と NetworkCategory を確かめる
    Set-NetConnectionProfile -InterfaceAlias "イーサネット" -NetworkCategory Private
    New-NetFirewallRule -DisplayName "tekurobokun backend 8787" -Direction Inbound `
      -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
    ```

    初めて`bun run backend`を起動したときに、Windowsのファイアウォールの確認が出たら、プライベートネットワークだけを許可します
12. **スリープ**：動かしている間に止まらないようにします（管理者）。画面の電源は切れてもかまいません

    ```powershell
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    ```

### 開発機とバックエンドPCの間のGit

コードは、開発機でコミットし、pushして、バックエンドPCでpullします（コミットとpushは、開発者が手で行います）。バックエンドPCでは、pullのあと次を実行します。

```powershell
git pull
bun install                # 依存が変わったとき
bun run console:build      # 入力ページ（apps/console）が変わったとき
```

次のファイルは、Git管理外のため、pullでは届きません。

- `config/backend.local.json`・`config/filter.local.json`：マシンごとに書く（開発機のものを、USBメモリなどでコピーしてもよい）。バックエンドPCの`backend.local.json`は、`host`・`publicUrl`がLAN向けで、実行ファイルのパス（`stt.bench`）も違います
- `data/`：登録済みの端末（`data/devices.json`）と、音声認識の比較の録音（`data/stt_bench/`）。バックエンドPCで作ります。開発機の`data/`はコピーしません（機体とタブレットを、バックエンドPCに登録し直します）
- `logs/`：会話ログと比較の結果

### バックエンドの設定（LAN）

`config/backend.local.json`に、LANから届くための項目を書きます。`{IP}`は、固定したバックエンドPCのIPアドレスです。

```json
{
  "host": "0.0.0.0",
  "publicUrl": "http://{IP}:8787",
  "tts": { "speaker": 74 },
  "stt": {
    "bench": {
      "executable": "C:\\Users\\{ユーザー}\\tekurobo_servers\\whisper.cpp\\bin\\vulkan\\whisper-server.exe",
      "modelsDir": "C:\\Users\\{ユーザー}\\tekurobo_servers\\whisper.cpp\\models"
    }
  }
}
```

`host`は公開用ポートの待ち受け先で、`0.0.0.0`でLANに届きます。`publicUrl`は、登録のQRに入る接続先です（機体が、QRからバックエンドのURLを知ります）。管理用API（8788）は、`host`に関係なく`127.0.0.1`だけで待ち受けます。LLM・`whisper-server`・VOICEVOXの接続先は、初期値（`127.0.0.1`の8080・8081・50021）のままでつながります。

### 各サービスを手で起動する

ランチャー（Phase 10）までは、各サービスを手で起動します（Phase 10からランチャーが行います）。**この順に**、それぞれ別のPowerShellのウィンドウで起動します。バックエンドが起動後に各サービスの応答を見るため、先に立ち上げておきます。

1. **llama-server（`llm.main`、ポート8080）**：Qwen3-8B。すべての層をGPUに載せます（`-ngl all`）

   ```powershell
   & "$HOME\tekurobo_servers\llama\llama-server.exe" `
     -m "$HOME\tekurobo_servers\models\Qwen3-8B-Q4_K_M.gguf" `
     --alias qwen3-8b --host 127.0.0.1 --port 8080 -c 4096 --reasoning off -ngl all
   ```

   副のモデル（`llm.sub`）に切り替えるときは、これを止めて、`Qwen3-4B-Q4_K_M.gguf`・`--alias qwen3-4b`で同じポートに起動し、`config/backend.local.json`の`llm.activeAlias`を`sub`にします
2. **`whisper-server`（`stt`、ポート8081）**：モデルは`large-v3-turbo-q5_0`（音声認識の比較で決めました）。無音・雑音を捨てるため、VAD（`--vad -vm`）を付けます

   ```powershell
   & "$HOME\tekurobo_servers\whisper.cpp\bin\vulkan\whisper-server.exe" `
     -m "$HOME\tekurobo_servers\whisper.cpp\models\ggml-large-v3-turbo-q5_0.bin" `
     --host 127.0.0.1 --port 8081 -l ja `
     --vad -vm "$HOME\tekurobo_servers\whisper.cpp\models\ggml-silero-v6.2.0.bin"
   ```

3. **VOICEVOX ENGINE（ポート50021）**

   ```powershell
   & "$HOME\tekurobo_servers\voicevox\run.exe" --host 127.0.0.1 --port 50021
   ```

4. **バックエンド**：リポジトリのフォルダで`bun run backend`。ウィンドウの数字キーで入力元を切り替えます（「端末の切り替え」）

### 動作の確認

1. 各サービスの応答を、「動作確認のコマンド」で確かめます（llama-serverと`whisper-server`は`/health`、VOICEVOXは`/version`）。モデルの読み込みに少しかかります
2. バックエンドの状態で、`health`がすべて`true`になることを確かめます（別のPowerShellで）

   ```powershell
   bun run admin status
   ```

   `llm`・`stt`・`tts`のどれかが`false`なら、そのサービスの起動と、`config/backend.*.json`の接続先を確かめます。`robot`は、機体がつながるまで`false`です
3. 別の端末（機体のPCやタブレット）のブラウザで`http://{IP}:8787/?device=tablet`が開けることを確かめます。開けないときは、ファイアウォール（準備の11）と`host`を確かめます

考えた時間は、モデルの比較（`bun run bench -- --target qwen3-8b`）で、音声認識の時間と誤り率は、音声認識の比較（`bun run bench:stt`）で測れます。モデルの比較の接続先は、バックエンドPCの`config/bench.local.json`に、4つのモデル（`qwen3-8b`・`qwen3-4b`・`qwen3.5-9b`・`qwen3.5-4b`。どれも`http://127.0.0.1:8080`）を書きます（配列はまるごと置き換わるので、使うものを全部書きます）。llama-serverは1つのモデルだけを載せるため、測るモデルで起動し直してから`--target`を選びます。

### 機体とconsoleの登録（LAN）

バックエンドを起動した状態で、機体とconsole（入力ページ）を登録します（仕組みは「端末の登録」）。QRの中身の接続先は`publicUrl`なので、`http://{IP}:8787`にしておきます。

1. **機体**：機体アプリを起動すると、カメラの登録の画面になります。バックエンドPCで`bun run admin pair`を実行し、書き出された`data/pairing_qr.svg`をバックエンドPCのブラウザで開いて、画面のQRを機体のカメラに見せます（コードは60秒だけ有効です）。「つながりました」が出れば登録できています
2. **console**：タブレットやスマホのブラウザで`http://{IP}:8787/?device=tablet`（スマホは`?device=phone`）を開くと、登録コードの入力行が出ます。バックエンドのウィンドウで`p`を押す（または`bun run admin pair`）と出るコードを、60秒以内に入れます。タブレットは、続けてPWAとしてインストールします（「タブレットへのインストール」。オリジンは`http://{IP}:8787`）
3. 登録の一覧と解除は、`bun run admin devices`と`bun run admin revoke {id}`です

### 自動起動

展示では、バックエンドPCを自動でサインインさせ、サインインのたびにllama-server・VOICEVOX ENGINE・バックエンドが起動するようにします。タスクスケジューラの「ログオン時」のタスクとして登録します。それぞれ見えるPowerShellのウィンドウで動き、バックエンドのウィンドウで端末を切り替えるキーを押せます。サービス（セッション0）にしないのは、画面のないセッションではキー入力を受けられず、GPU（Vulkan）が使えない場合があるためです。

1. 「準備」を終え、「動作の確認」でサーバーが手動で動くことを確かめておきます
2. **自動サインインにします**：`netplwiz`を開き、「ユーザーがこのコンピューターを使うには、ユーザー名とパスワードの入力が必要」のチェックを外します（出ないときは、「設定」→「アカウント」→「サインインオプション」で「Microsoftアカウントに、Windows Helloサインインを要求する」をオフにしてから開きます）
3. **タスクを登録します**（管理者のPowerShellで、リポジトリのフォルダから）。まず`-WhatIf`で登録される内容を確かめます

   ```powershell
   .\scripts\register_backend_tasks.ps1 -WhatIf
   .\scripts\register_backend_tasks.ps1
   ```

   サーバー一式は`$HOME\tekurobo_servers`にある前提です（変えるときは`-ServersRoot`）。モデルのファイル名は`-ModelFile`、`--alias`は`-ModelAlias`、ログオンするユーザーは`-User`で変えます。llama-serverをCPUで動かすときは`-NoGpu`を付けます（`-ngl all`を付けません）。起動に要るファイルが見つからないときは、登録せずに止まります
4. タスクは「タスクスケジューラ」の`\tekurobokun\`のフォルダ（`llama-server`・`voicevox-engine`・`backend`）にできます。バックエンドは、ウィンドウを前に出すため、サインインの20秒後（`-BackendDelaySeconds`）に起動します。再起動して、3つのウィンドウが開き、状態の行が`llm=up tts=up`になることを確かめます
5. 取り消すときは、管理者のPowerShellで`.\scripts\unregister_backend_tasks.ps1`を実行します（`-WhatIf`で、消えるタスクを確かめられます）。起動中のウィンドウは閉じないので、手で閉じます

コードを更新したときは、先に`git pull`と`bun run console:build`をしてからバックエンドを起動し直します（自動起動はサインイン時だけで、ビルドはしません）。

## 展示当日の運用

### 起動

どの順で起動しても、つながった時点で自動で動き出します（入力ページと機体アプリは、つながるまで再接続を続けます）。

1. **バックエンドPC**：自動起動を設定してある場合（「自動起動」）は、電源を入れて自動サインインを待てば、次の3つが見えるウィンドウで起動します。そうでなければ、PowerShellを3つ開き、それぞれで次を起動します。`apps/backend`のウィンドウは、端末の切り替えに使うので、見える場所に置いておきます
   - llama-server（「動作の確認」のコマンド）
   - VOICEVOX ENGINE（`run.exe --host 127.0.0.1 --port 50021`）
   - バックエンド：リポジトリのフォルダで`bun run backend`。コードを更新したときは、先に`git pull`と`bun run console:build`をします
2. バックエンドのウィンドウに出る状態の行が`llm=up tts=up`になるのを待ちます（モデルの読み込みに少しかかります）
3. **機体**：`apps/robot/src/config/config.local.json`の`backend.url`を`ws://{バックエンドPCのIP}:8787/ws`にして、機体アプリを起動します。状態の行が`robot=connected`になります
4. **タブレット**：ホーム画面のtekurobokunのアイコンから起動します。スタッフのスマホは、ブラウザで`http://{IP}:8787/?device=phone`を開いておきます

状態の行の例：

```
[operator] active=tablet [1:tablet* 2:phone] session=idle llm=up tts=up robot=connected
```

`active`は入力を受け付けている端末（一覧の`*`）、`session`は会話の状態（`idle`待機中・`thinking`考え中・`speaking`話し中）、`llm`・`tts`はLLMとVOICEVOXの応答（`DOWN`のときは入力ページが全面の案内、機体が眠っている顔になる）、`robot`は機体アプリの接続です。状態の行は、端末の切り替え、応答や接続の変化があったときに出ます。

### 端末の切り替え

入力を受け付ける端末は1台だけで、バックエンドを起動したウィンドウでのキー入力で切り替えます（入力ページと機体には、切り替えの操作はありません）。キーを押す前に、そのウィンドウをクリックして選んでおきます。

| キー       | 動き                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `1`〜`9`   | `devices.list`の順番の端末を有効にする（初期値では`1`がタブレット、`2`がスマホ） |
| `s`・Enter | いまの状態の行を出す                                                             |
| `h`・`?`   | キーの説明を出す                                                                 |
| Ctrl+C     | バックエンドを終える（展示中は押さない）                                         |

- 有効でない端末には「いまは別の端末で受け付けています」の全面の案内が出て、有効にすると自動で元の表示に戻ります
- ウィンドウの中をドラッグして文字を選択した状態だと、キーが効かないことがあります。Escを押して選択を解いてから押します
- バックエンドを再起動すると、有効な端末は`devices.active`（初期値はタブレット）に戻ります

### 会話ログの整理

会話ログ（`logs/{日付}.jsonl`）は、最大3か月保持し、テクロボくんの学習に使います。ブースには「会話ログデータは最大３ヶ月保持し、テクロボくんの学習に利用されます。その際、個人が特定される情報は手動で取り除きます。」と掲示しています。

- アプリはログを消しません。日付が3か月より前のファイルは、手で消します。先に`-WhatIf`付きで、消えるファイルを確かめます

  ```powershell
  $limit = (Get-Date).AddMonths(-3).ToString('yyyy-MM-dd')
  Get-ChildItem logs\*.jsonl | Where-Object { $_.BaseName -lt $limit } | Remove-Item -WhatIf
  # 一覧に問題がなければ、-WhatIf を外して実行する
  ```

- 学習に使う前に、発言（`input`）と返事に、名前などの個人が特定される情報が入っていないかを確かめ、手で取り除きます
- `logs/stub/`（スタブの会話）と`logs/bench/`（モデルの比較の結果）は、会話ログではありません

## ビルド

機体アプリ（`apps/robot`）は、Tauriで実行ファイルを作ります。コード署名はしません。

```powershell
cd apps/robot
bun run tauri build
```

次ができます（`apps/robot/src-tauri/target/release/`）。

- `tekurobokun.exe`：実行ファイル（フォントと音声ファイルは中に入っています）
- `bundle/`：インストーラー（NSISの`.exe`、WiXの`.msi`）。最初のビルドでは、インストーラーを作る道具を自動でダウンロードするため、ネットワークが要ります

設定（`config.local.json`）はビルドに取り込まれます。接続先を変えたら、ビルドし直します（「別のPCのバックエンドにつなぐ」）。コード署名がないため、初めて起動すると、WindowsのSmartScreenが警告を出すことがあります（「詳細情報」→「実行」）。

入力ページは、`bun run console:build`で`apps/console/dist`に作ります。バックエンドがこれを配信します。

## アイコンの生成

アイコンは、`docs/brand/tekurobokun_icon_master.svg`（`roadmap/specs/`の最新のマスターSVGの写し）から作ります。生成したファイルはリポジトリに含め、CIでは作りません。マスターSVGを新しい版にしたら、写しを置き直し（「値」と同じ）、次を実行して、変わったファイルをコミットします。

```powershell
bun run robot:icons      # 機体アプリ（apps/robot/src-tauri/icons/：icon.ico・icon.icns・各サイズのPNG）
bun run console:icons    # 入力ページ（apps/console/public/icons/：32・192・512のPNG）
```

どちらもTauri CLIの`tauri icon`で書き出します。`robot:icons`は、Android・iOS用のフォルダを消します（デスクトップだけのため）。Apple環境向けの`.icon`は、Icon Composerで作るもので、このリポジトリでは扱いません。

## リリース

バージョンはセマンティックバージョニングで、初回は`0.1.0`です。次の順で行います。コミット・タグ・pushと、GitHubのリリースの公開は、人が行います。

1. **バージョンをそろえる**：次のすべてを同じ値にします
   - `package.json`の`version`（`apps/backend`・`apps/console`・`apps/robot`・`packages/i18n`・`packages/protocol`・`packages/theme`）
   - `apps/robot/src-tauri/tauri.conf.json`の`version`
   - `apps/robot/src-tauri/Cargo.toml`の`version`と、`Cargo.lock`の`tekurobokun`の項目
2. **`CHANGELOG.md`を書く**：[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)の形式で、利用者向けに、リリースごとの変更を書きます。プランアセットの版は書きません（対応は`roadmap/timeline.md`に書きます）
3. **確かめる**：`bun run check`が通ること。アイコンが最新のマスターSVGから生成したものであること（「アイコンの生成」を実行して、差分が出ないこと）。READMEの特徴・使い方・動作環境が、今回の内容と合っていること
4. **ビルドする**：「ビルド」の手順で`tauri build`が通ること
5. **`roadmap/timeline.md`に、リリース準備の行を足す**：バージョンと、その時点のプランアセットの版を書きます
6. **コミットして、タグを付けてpushする**：

   ```powershell
   git commit
   git tag v0.1.0
   git push origin main v0.1.0
   ```

7. **GitHub Releasesに、ドラフトを作る**：タグ`v0.1.0`を選び、`CHANGELOG.md`の該当の節を説明に貼ります。必要なら、ビルドしたインストーラーを添付して、公開します。このリポジトリは一般公開しない方針なので、公開の範囲は、そのときに決めます

## リポジトリ構成

```
tekurobokun/
├─ apps/
│  ├─ backend/   バックエンド（Bun）。会話の制御、llama-server・`whisper-server`・VOICEVOXの呼び出し、入力ページの配信、登録、管理用API
│  ├─ console/   入力ページ（TypeScript＋Vite）
│  └─ robot/     機体アプリ（Tauri 2＋TypeScript＋Vite＋p5.js）
├─ packages/
│  ├─ protocol/  WebSocketのメッセージと管理用APIの型・検証関数、登録コードとQRの中身の規則（アプリが共有）
│  ├─ i18n/      Paraglide JS 2の辞書（原文：ja）と疑似ロケール、ロケールの判定
│  └─ theme/     tokens.cssとフォント（M PLUS 1 Code・DotGothic16。OFLのライセンス文つき）
├─ config/       設定ファイル（*.default.jsonをGitで管理し、*.local.jsonで上書き）
├─ data/         登録済みの端末とトークンのハッシュ、音声認識の比較の録音（`data/stt_bench/`）（Git管理外）
├─ logs/         会話ログとモデル・音声認識の比較の結果（Git管理外）
├─ scripts/      checkコマンドとその検査、モデル比較、音声認識の比較、開発用の管理CLI、whisper.cppの準備（`setup_whisper.ps1`）、アイコンの生成、バックエンドPCの自動起動の登録・取り消し
├─ .github/      CIのワークフロー（checkコマンドを実行）
├─ docs/
│  ├─ brand/     ブランドの資料とマスターSVG（roadmap/specs/の写し。編集しない）
│  └─ reference/ 全体構想
└─ roadmap/      計画の記録（下記）
```

- **roadmap/**：企画と計画の記録です。`specs/`にプランアセット（スペックシート・トークン・モックなど）の最新版、`planning_dialog/`に実装計画（imple）・タスク（tasks）・検証（walk）の最新版、`development/`に修正の記録を置きます。`archived/`（旧版）はGitで管理しません
- **docs/brand/**：`roadmap/specs/`のブランドの資料とマスターSVGの写しです。一致はcheckコマンドで確かめます
