# tekurobokunの開発に参加する

不具合の報告はIssueで受け付けます。プルリクエストは、事前にIssueで相談してください。

## 開発環境

- **開発機**：Windows 11。コマンドの例はPowerShell 7で書いています
- **Bun** 1.4系（パッケージ管理・バックエンドの実行・テスト）
- **Rust**（安定版）と、Tauri 2の前提（Microsoft C++ Build Tools、WebView2）。機体アプリ（`apps/robot`）のビルドに使います
- **Git**
- 会話を実際のAPIで確かめるときは、後述の「仮のサーバー」（llama-serverとVOICEVOX ENGINE）

本番では、バックエンドPC（Windows 11、GPUはRX480）でllama-serverとVOICEVOX ENGINEを動かします。手順は「バックエンドPC（本番）」にあります。展示当日の起動と、端末の切り替え方は「展示当日の運用」にあります。

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

設定は`apps/robot/src/config/config.default.json`（Gitで管理）にあり、`config.local.json`に書いた項目だけを上書きします（上書きのしかたはバックエンドの設定ファイルと同じ）。`drive`と`audio`は、この版では使わない走行と音声スロットの設定です。

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

まばたきを`render.idleFps`の1コマより短くすると、見えないことがあります（初期値では1コマ100ms、まばたき150ms）。

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

人格プロンプトは`config/persona.md`から読みます（なければ、返事の形式の指示だけでLLMに問い合わせ、起動時に警告を出します）。返事の形式の指示（`{"say", "emotion"}`のJSONで返す）は`apps/backend/src/dialogue/reply_format.md`にあり、人格プロンプトのあとに付けて渡します。

**入力ページを開発する**（変更をすぐ反映する）

```powershell
bun run backend:stub     # 別のPowerShellで起動しておく
bun run console:dev      # Viteの開発サーバー（http://localhost:5173/、LANからも開ける）
```

開発サーバーは`/ws`をバックエンド（既定は`http://127.0.0.1:8787`）へ中継します。バックエンドのポートを変えたときは、環境変数`BACKEND_URL`で中継先を指定します。疑似ロケールは開発サーバーでだけ使えます（`?locale=pseudo`）。

**端末名と入力元**：入力ページは、URLの`?device=`で端末名を名乗ります（省略すると`tablet`）。端末名は`config/backend.*.json`の`inputSources.consoles`にあるものだけ登録できます。入力を受け付けるのは、有効な入力元1つだけです。起動時は`inputSources.active`（初期値は機体のマイクの`robot`）が有効で、バックエンドを起動したターミナルの数字キーで切り替えます（`1`が`robot`、`2`以降が`inputSources.consoles`の順）。スタッフのスマホは`?device=phone`で開きます。入力元が自分でない入力ページには「いまは別の端末で受け付けています」の全面の案内が出ます（入力元が`robot`のときの表示はPhase 7で足します）。

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

| 項目                                                    | 内容                                                                                          | 初期値                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| `host`                                                  | 公開用ポートの待ち受け先。本番は`127.0.0.1`（トンネルだけが届く）。LANから試すときは`0.0.0.0` | `127.0.0.1`                          |
| `port`                                                  | 公開用ポート（入力ページとWebSocket）                                                         | `8787`                               |
| `publicUrl`                                             | 登録のQRに入れる公開URL。LANから試すときは`http://{LANのIP}:8787`                             | `http://localhost:8787`              |
| `admin.port`                                            | 管理用API（`127.0.0.1`だけで待ち受ける）                                                      | `8788`                               |
| `llm.baseUrl`                                           | llama-serverの接続先（OpenAI互換API）                                                         | `http://127.0.0.1:8080`              |
| `llm.models.{main,sub}`                                 | 正・副のモデル名（llama-serverの`--alias`）と、生成の上限トークン数（`maxTokens`）・温度      | `qwen3-8b`・`qwen3-4b`、`256`・`0.7` |
| `llm.activeAlias`                                       | 起動時に使うモデルの別名（`main`・`sub`）                                                     | `main`                               |
| `llm.contextTurns`                                      | LLMに渡す直近の往復数                                                                         | `4`                                  |
| `llm.jsonSchema`                                        | JSONスキーマ制約（`response_format`）を使うか                                                 | `true`                               |
| `llm.timeoutMs`                                         | LLMの応答を待つ上限                                                                           | `60000`                              |
| `tts.baseUrl`・`tts.speaker`                            | VOICEVOX ENGINEの接続先と話者（スタイルのid）                                                 | `http://127.0.0.1:50021`・`1`        |
| `inputSources.consoles`                                 | 入力ページの端末名（順番は、入力元を切り替える数字キーの`2`以降の順）                         | `["tablet", "phone"]`                |
| `inputSources.active`                                   | 起動時の入力元（`robot`か、`inputSources.consoles`の端末名）                                  | `robot`                              |
| `pairing.codeTtlMs`                                     | 登録コードの有効時間                                                                          | `60000`                              |
| `pairing.maxFailures`・`failureWindowMs`・`lockMs`      | 接続元ごとに、`failureWindowMs`の間に`maxFailures`回失敗したら`lockMs`の間受け付けない        | `5`・`60000`・`300000`               |
| `stt`・`search`                                         | 音声認識（Google）と検索（Tavily）の設定の雛形。Phase 7・8で使い始める                        | 空                                   |
| `dialogue.questionLoopThreshold`・`session.idleResetMs` | 質問のループを防ぐ指示と、履歴の区切り（Phase 8で使い始める）                                 | `2`・`90000`                         |
| `console.autosendMs`                                    | 入力が止まってから自動で送るまでの時間（`0`で自動送信しない）                                 | `3000`                               |
| `console.fontSizePx`                                    | 入力ページの文字の大きさ                                                                      | `18`                                 |
| `console.bottomInsetPx`                                 | 入力ページの下に空ける余白（キーボードとのずれの調節。前述）                                  | `0`                                  |
| `console.prompt`                                        | プロンプトの表示（`user`・`host`・`dir`。ディレクトリ名はイベントごとに変える）               | `user`・`nid-techtech`・`~/makers`   |
| `speakingGraceMs`                                       | 話し中のタイムアウトの余裕（送った音声の長さの合計に足す）                                    | `5000`                               |
| `healthIntervalMs`                                      | llama-serverとVOICEVOXへの問い合わせの間隔                                                    | `5000`                               |
| `historyDisplayTurns`                                   | 入力ページに送る表示用の履歴の件数                                                            | `50`                                 |

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

### モデルの比較

同じ質問のセットを接続先ごとに投げ、考えた時間、形式の崩れの数、返事を一覧にします。人格プロンプトと返事の形式は、バックエンドと同じものを使います。

```powershell
bun run bench                         # config/bench.*.json の接続先すべて
bun run bench -- --target qwen3-4b    # 1つの接続先だけ
bun run bench -- --repeat 3           # 質問のセットを3回くり返す
```

接続先と質問は`config/bench.default.json`にあり、`config/bench.local.json`で上書きできます。接続先ごとに`baseUrl`・`model`のほか、`jsonSchema`・`maxTokens`・`temperature`を変えられます（書かない項目は`config/backend.*.json`の`llm`の値）。結果は`logs/bench/{日時}.md`に書き出します。

## 開発機の仮のサーバー

LLMと音声合成は、本番ではバックエンドPC（Windows 11）で動かします。その準備を待たずに実際のAPIで会話を確かめるため、開発機（Windows）に同じサーバーを置きます。CPUで動かす想定です（開発機のGPUが使えれば、それでもかまいません）。バックエンドPCにも、この手順でサーバーを置きます。違いは「バックエンドPC（本番）」にあります。

以下では、サーバー一式を`$HOME\tekurobo_servers`に置きます。リポジトリの外に置いてください。

```powershell
New-Item -ItemType Directory -Force "$HOME\tekurobo_servers" | Out-Null
```

### llama-server（llama.cpp）

使うモデルはQwen3-4B、予備はGemma 4 E2Bです（どちらも4bitのGGUF、Apache-2.0）。本番のバックエンドPCでも、同じポートと`--alias`で起動します。

| モデル              | ポート | `--alias`     | ファイル                   | 入手先                                                                              |
| ------------------- | ------ | ------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| Qwen3-4B            | 8080   | `qwen3-4b`    | `Qwen3-4B-Q4_K_M.gguf`     | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF)                     |
| Gemma 4 E2B（予備） | 8081   | `gemma-4-e2b` | `gemma-4-E2B-it-Q4_0.gguf` | [ggml-org/gemma-4-E2B-it-GGUF](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF) |

1. [llama.cppのReleases](https://github.com/ggml-org/llama.cpp/releases)から、`b`で始まる最新のビルドの`llama-b{番号}-bin-win-cpu-x64.zip`をダウンロードします（GPUを使う場合は`win-vulkan-x64`）
2. `$HOME\tekurobo_servers\llama`に展開します
3. モデルを`$HOME\tekurobo_servers\models`にダウンロードします

```powershell
New-Item -ItemType Directory -Force "$HOME\tekurobo_servers\models" | Out-Null
curl.exe -L -o "$HOME\tekurobo_servers\models\Qwen3-4B-Q4_K_M.gguf" `
  "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
curl.exe -L -o "$HOME\tekurobo_servers\models\gemma-4-E2B-it-Q4_0.gguf" `
  "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_0.gguf"
```

起動（ポートは明示します。既定のポートは版によって変わるため）。予備のE2Bは、使うときだけ別のPowerShellで起動します。

```powershell
# Qwen3-4B（ポート8080）。思考出力はサーバーの側でも止める（バックエンドも enable_thinking: false を送る）
& "$HOME\tekurobo_servers\llama\llama-server.exe" `
  -m "$HOME\tekurobo_servers\models\Qwen3-4B-Q4_K_M.gguf" `
  --alias qwen3-4b --host 127.0.0.1 --port 8080 -c 4096 --reasoning off

# Gemma 4 E2B（予備、ポート8081）
& "$HOME\tekurobo_servers\llama\llama-server.exe" `
  -m "$HOME\tekurobo_servers\models\gemma-4-E2B-it-Q4_0.gguf" `
  --alias gemma-4-e2b --host 127.0.0.1 --port 8081 -c 4096
```

`config/backend.default.json`の初期値はQwen3-4B（`http://127.0.0.1:8080`、`qwen3-4b`）なので、上書きなしでつながります。**予備のE2Bに切り替える**ときは、`config/backend.local.json`の`llm`に次を書き、バックエンドを再起動します（Qwen3-4Bに戻すときは`llm`を消します）。

```json
{
  "llm": { "baseUrl": "http://127.0.0.1:8081", "model": "gemma-4-e2b" }
}
```

モデルの比較（`bun run bench`）は、初期値でQwen3-4BとE2Bの両方に問い合わせます（「モデルの比較」）。開発機で測った考えた時間はCPUでの値で、バックエンドPC（RX480・Vulkan）での値とは違います。

モデルは、開発機での比較（Gemma 4 E4B・Qwen3-4B・E2B）で決めました。経緯は`roadmap/development/261113172152_change_model_qwen3.md`にあります。

### VOICEVOX ENGINE 0.25.2

1. [VOICEVOX ENGINEの0.25.2](https://github.com/VOICEVOX/voicevox_engine/releases/tag/0.25.2)から、`voicevox_engine-windows-cpu-0.25.2.7z.001`をダウンロードします
2. 7-Zipで`$HOME\tekurobo_servers\voicevox`に展開します（`.7z.001`を開くと展開できます）
3. 展開したフォルダの`run.exe`を起動します

```powershell
& "$HOME\tekurobo_servers\voicevox\run.exe" --host 127.0.0.1 --port 50021
```

VOICEVOXの利用規約により、VOICEVOXを利用したことがわかるクレジット表記が必要です。キャラクターごとの利用規約もあります。展示の話者は琴詠ニア（ノーマル、スタイルid `74`。`config/backend.local.json`の`tts.speaker`）で、展示パネルに「音声：VOICEVOX 琴詠ニア」と書いています。話者を変えたら、パネルの表記も変えてください。

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

バックエンドの接続先は、`config/backend.local.json`（Git管理外）で上書きします。仮のサーバーと本番で変わるのは、接続先とモデル名だけです。上の手順のポート（8080・50021）とモデル名（`qwen3-4b`）は、`config/backend.default.json`の初期値と同じなので、仮のサーバーでは上書きなしで`bun run backend`につながります（項目は「設定ファイル」）。

## バックエンドPC（本番）

> この節と「展示当日の運用」は、v5（0.1.0）の手順です。v6（会場と自宅に分けた版）の本番の手順は、Phase 11で書き直します。

本番のバックエンドPC（Windows 11、Ryzen 5 3500、RX480）には、「開発機の仮のサーバー」と同じ手順でサーバーを置きます。違いは、llama-serverをVulkan版のビルドにしてGPUで動かすことと、LANから入力ページにつなげるための設定です。ポート・`--alias`・フォルダの置き場所は、仮のサーバーと同じにします。PowerShellの管理者権限が要る手順には「（管理者）」と書いています。

### 準備（1回だけ）

1. **GPUのドライバー**：AMDのドライバー（AMD Software: Adrenalin Edition）の、RX480に対応した版を入れます。llama-serverのVulkan版は、このドライバーのVulkanでGPUを使います
2. **Bun 1.4とGit**を入れ、リポジトリを置きます（「セットアップ」と同じ）。続けて入力ページをビルドします

   ```powershell
   bun install
   bun run console:build
   ```

3. **llama-server**：「開発機の仮のサーバー」の手順で置きます。ダウンロードするのは`llama-b{番号}-bin-win-vulkan-x64.zip`です。置いたら、GPUが見えていることを確かめます（一覧にRX 480の行が出れば使えます）

   ```powershell
   & "$HOME\tekurobo_servers\llama\llama-server.exe" --list-devices
   ```

4. **モデル**：Qwen3-4B（と予備のGemma 4 E2B）を、仮のサーバーと同じ手順で`$HOME\tekurobo_servers\models`に置きます
5. **VOICEVOX ENGINE 0.25.2（Windows CPU版）**：仮のサーバーと同じ手順で置きます
6. **Git管理外の設定ファイル**を、開発機からUSBメモリなどでコピーして置きます
   - `config/backend.local.json`：話者（`tts.speaker`）など、開発機で上書きしている項目。接続先は初期値（`127.0.0.1`）のままでつながるので、書かなくてかまいません
   - `config/filter.local.json`：禁止語リストと定型の返事（「禁止語と会話ログ」）。置かないと、禁止語の検査をしません
7. **IPアドレスの固定**：会場のルーターの設定（DHCPの固定割り当て）で、バックエンドPCのIPアドレスを固定します。変わると、タブレットのPWAと機体アプリの接続先を設定し直すことになります（「タブレットへのインストール」）
8. **ネットワークとファイアウォール**（管理者）：LANのネットワークを「プライベート」にし、ポート8787（入力ページとWebSocket）の受信を許可します。llama-server（8080）とVOICEVOX（50021）は、バックエンドからだけ（`127.0.0.1`で）呼ぶので開けません

   ```powershell
   Get-NetConnectionProfile                     # InterfaceAlias（「イーサネット」など）と NetworkCategory を確かめる
   Set-NetConnectionProfile -InterfaceAlias "イーサネット" -NetworkCategory Private
   New-NetFirewallRule -DisplayName "tekurobokun backend 8787" -Direction Inbound `
     -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
   ```

   初めて`bun run backend`を起動したときに、Windowsのファイアウォールの確認が出たら、プライベートネットワークだけを許可します
9. **スリープとWindows Update**：展示中に止まったり再起動したりしないようにします
   - スリープと休止状態を無効にします（管理者）。画面の電源は切れてもかまいません

     ```powershell
     powercfg /change standby-timeout-ac 0
     powercfg /change hibernate-timeout-ac 0
     ```

   - 「設定」→「Windows Update」→「更新の一時停止」で、展示の期間が入るように一時停止します

### 動作の確認

バックエンドPCで、llama-server（下記）とVOICEVOX ENGINEを起動し、「動作確認のコマンド」で応答が返ることを確かめます。続けて`bun run backend`を起動し、別の端末（機体のPCやタブレット）のブラウザで`http://{IP}:8787/?device=tablet`が開けることを確かめます。

llama-serverは、仮のサーバーの起動のコマンドに`-ngl all`（すべての層をGPUに載せる）を足して起動します。

```powershell
& "$HOME\tekurobo_servers\llama\llama-server.exe" `
  -m "$HOME\tekurobo_servers\models\Qwen3-4B-Q4_K_M.gguf" `
  --alias qwen3-4b --host 127.0.0.1 --port 8080 -c 4096 --reasoning off -ngl all
```

考えた時間は、モデルの比較（`bun run bench -- --target qwen3-4b`）で測れます。

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
│  ├─ backend/   バックエンド（Bun）。会話の制御、llama-server・VOICEVOXの呼び出し、入力ページの配信、登録、管理用API
│  ├─ console/   入力ページ（TypeScript＋Vite）
│  └─ robot/     機体アプリ（Tauri 2＋TypeScript＋Vite＋p5.js）
├─ packages/
│  ├─ protocol/  WebSocketのメッセージと管理用APIの型・検証関数、登録コードとQRの中身の規則（アプリが共有）
│  ├─ i18n/      Paraglide JS 2の辞書（原文：ja）と疑似ロケール、ロケールの判定
│  └─ theme/     tokens.cssとフォント（M PLUS 1 Code・DotGothic16。OFLのライセンス文つき）
├─ config/       設定ファイル（*.default.jsonをGitで管理し、*.local.jsonで上書き）
├─ data/         登録済みの端末とトークンのハッシュ（Git管理外）
├─ logs/         会話ログとモデル比較の結果（Git管理外）
├─ scripts/      checkコマンドとその検査、モデル比較、開発用の管理CLI、アイコンの生成、バックエンドPCの自動起動の登録・取り消し
├─ .github/      CIのワークフロー（checkコマンドを実行）
├─ docs/
│  ├─ brand/     ブランドの資料とマスターSVG（roadmap/specs/の写し。編集しない）
│  └─ reference/ 全体構想
└─ roadmap/      計画の記録（下記）
```

- **roadmap/**：企画と計画の記録です。`specs/`にプランアセット（スペックシート・トークン・モックなど）の最新版、`planning_dialog/`に実装計画（imple）・タスク（tasks）・検証（walk）の最新版、`development/`に修正の記録を置きます。`archived/`（旧版）はGitで管理しません
- **docs/brand/**：`roadmap/specs/`のブランドの資料とマスターSVGの写しです。一致はcheckコマンドで確かめます
