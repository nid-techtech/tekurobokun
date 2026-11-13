# 仕様変更：バックエンドPCのOSをUbuntuからWindows 11にする

- 状態: 承認済み（新版 261114061547、プランアセット v4）
- 対象: プランアセット v3 → v4、imple・tasks・walk（261113173052）→ 新版
- きっかけ: ユーザーの決定

## 変更内容

1. **バックエンドPC（Ryzen 5 3500・32GB・RX480）のOSをWindows 11にする**
2. **llama-serverは、Windows版のVulkanビルド（`llama-b{番号}-bin-win-vulkan-x64.zip`）を使う**。RX480のVulkanは、AMDのWindows用ドライバー（Adrenalin）で動かす。動作は着手時（T4-10・W4-6）に確かめる
3. **VOICEVOX ENGINEは、0.25.2のWindows CPU版を使う**（ポート50021のまま）
4. **自動起動は、systemdのユニットから、タスクスケジューラの「ログオン時」のタスクにする**。バックエンドPCは自動サインインにし、llama-server・VOICEVOX ENGINE・`apps/backend`をログオン時に起動する。`apps/backend`は見えるターミナルのウィンドウで起動し、`OperatorConsole`の数字キーでの切り替えをそのウィンドウで行う。登録はPowerShellのスクリプト（`scripts/`に置く）で行う
   - サービス（セッション0）にしない理由：画面のないセッションでは、`OperatorConsole`のキー入力を受けられず、GPU（Vulkan）が使えない場合がある
5. **Windowsでの展示向けの準備をT4-10に加える**：LANのネットワークを「プライベート」にし、Windows Defenderファイアウォールでポート8787の受信を許可する（llama-server・VOICEVOXは`127.0.0.1`からしか呼ばないので開けない）。スリープを無効にし、展示期間はWindows Updateを一時停止する（展示中の自動再起動を防ぐ）

## 理由と影響

- 開発機と本番が同じWindowsになり、開発機の「仮のサーバー」の手順（`CONTRIBUTING.md`）が、ビルドをVulkan版に替えるだけで本番にも使える。T4-9の手順書は、仮のサーバーの手順を土台に書ける
- コード（`apps/`・`packages/`・`scripts/`）にOS依存の箇所はなく、変える必要はない（BunはWindowsに対応。`OperatorConsole`はPhase 4で作るため、最初からWindowsのターミナルで確かめる）

## 変更にしない範囲

- 画面構成、トークンの値、マスターSVG、インターフェース（`DialogueEngine`・`TtsEngine`・プロトコル・設定の項目）、ポートとモデル名
- 3段階の検証（スタブ・仮のサーバー・本番）の構成。本番の確かめる内容（GPUでの動作と考えた時間、応答時間、連続稼働）も変えない
- 開発機の仮のサーバー（CPU）の手順

## 影響するドキュメントと項目

### プランアセット（v4。全ファイルを`_v4`にし、v3は`archived/`へ）

- `tekurobokun_SPEC_v4.md`
  - 4節 技術スタック「バックエンド」の行の理由：「BunはWindows・Linuxの両方に対応」→「BunはWindowsに対応」
  - 4節「LLM実行」の行の理由：「UbuntuのVulkanドライバーでの動作は着手時に確認する」→「WindowsのAMDドライバー（Adrenalin）のVulkanでの動作は着手時に確認する」
  - 4節「音声合成」の行：「Linux CPU版」→「Windows CPU版」
  - 5節 構成：「バックエンドPC（Ubuntu、…）」→「バックエンドPC（Windows 11、…）」
  - 7節 配布・公開方法：「自動起動にする（Ubuntu）」→「サインイン時に自動で起動する（Windows 11のタスクスケジューラ。自動サインインにする）」
- `tekurobokun_system_const_v4.html`：バックエンドPCの箱の「Ubuntu」→「Windows 11」、VOICEVOXの箱の「Linux CPU版」→「Windows CPU版」
- そのほか（brand・icon_master・mock・tokens）：中身は変えず、`_v4`でコピーする

### imple（新版）

- 1節：「LLMとVOICEVOXはバックエンドPC（Ubuntu）にしかないため」→「LLMとVOICEVOXは本番ではバックエンドPCで動かすため」
- 10節「本番」：「バックエンドPC（Ubuntu、RX480）」→「バックエンドPC（Windows 11、RX480）」。「仮のサーバーと同じ手順で、llama-serverをVulkan版に替えて置く」を足す
- 自動起動の方式（タスクスケジューラのログオン時のタスク、自動サインイン、`apps/backend`は見えるウィンドウで起動）と、その理由を書く

### tasks（新版。完了済みの項目はIDとチェックを引き継ぐ）

- 変更 T4-9：「バックエンドPC（Ubuntu）の準備」→「バックエンドPC（Windows 11）の準備（仮のサーバーの手順を土台に、Vulkan版のllama-server、ファイアウォール、スリープとWindows Updateの設定）」。あわせて、`CONTRIBUTING.md`の「バックエンドPC（Ubuntu）」の記述（冒頭と「開発機の仮のサーバー」の節）を直す
- 変更 T4-10：「バックエンドPC（Ubuntu）を準備する」→「バックエンドPC（Windows 11）を準備する」。「VOICEVOX ENGINE 0.25.2（Linux CPU版）」→「（Windows CPU版）」。「LANのネットワークをプライベートにし、ポート8787の受信を許可する。スリープを無効にし、展示期間のWindows Updateを一時停止する」を足す
- 変更 T5-2：「systemdユニット」→「タスクスケジューラに、ログオン時に起動するタスクを登録するPowerShellのスクリプト（`scripts/`）と、登録の取り消し」
- 変更 T5-3：「自動起動の設定を入れる」→「自動サインインを設定し、T5-2のスクリプトでタスクを登録する」

### walk（新版。完了済みの項目はIDとチェックを引き継ぐ）

- 変更 W4-6：「バックエンドPC（Ubuntu）で」→「バックエンドPC（Windows 11）で」。「別の端末（機体またはタブレット）からポート8787に届くこと」を足す
- 変更 W5-4：「バックエンドPCを再起動し」→「バックエンドPCを再起動し、自動でサインインして」。「`apps/backend`のウィンドウで数字キーの切り替えが効くこと」を足す
- 作業ツリーにあるW3-6の完了（未コミット）は、そのまま引き継ぐ

### そのほか

- `roadmap/timeline.md`：プランアセット v4の行を追記する
- 新規の項目はない。推奨と`Phaseの推奨`は変えない
- Phase 3の引き継ぎメモは変えない（次はユーザーのW3-7・W3-8）

## 承認後の進め方

1. v3のプランアセット一式と、現行のimple・tasks・walkを`archived/`へ移す
2. v4のプランアセット、新版のimple・tasks・walkを作り、`timeline.md`に追記する
3. Phase 3の残り（ユーザーのW3-7・W3-8）に戻る。変更した項目はPhase 4・5のため、いま着手する【エージェント】の項目はない
