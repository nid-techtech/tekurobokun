# バックエンドPCの自動起動を、タスクスケジューラに登録する（管理者のPowerShellで実行）。
# ログオン時に、llama-server・VOICEVOX ENGINE・バックエンド（bun run backend）を、
# 見えるPowerShellのウィンドウで起動する。サービス（セッション0）にしないのは、
# バックエンドのウィンドウの数字キー（端末の切り替え）とGPU（Vulkan）を使うため。
# 登録は「\tekurobokun\」のフォルダにまとめる。取り消しは unregister_backend_tasks.ps1。
#
#   .\scripts\register_backend_tasks.ps1                # 既定の置き場所で登録
#   .\scripts\register_backend_tasks.ps1 -WhatIf        # 登録せず、登録する内容だけを見る
#   .\scripts\register_backend_tasks.ps1 -NoGpu         # llama-serverをCPUで動かす（-ngl allを付けない）

#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # リポジトリのフォルダ（既定：このスクリプトの1つ上）
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  # llama・models・voicevox を置いたフォルダ（CONTRIBUTING.mdの「開発機の仮のサーバー」）
  [string]$ServersRoot = (Join-Path $HOME 'tekurobo_servers'),
  [string]$ModelFile = 'Qwen3-4B-Q4_K_M.gguf',
  # llama-serverの --alias。config/backend.*.json の llm.model と同じにする
  [string]$ModelAlias = 'qwen3-4b',
  # ログオンするユーザー（既定：いまのユーザー）
  [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  # バックエンドの起動をずらす秒数（バックエンドのウィンドウを最前面に出すため）
  [int]$BackendDelaySeconds = 20,
  [switch]$NoGpu
)

$ErrorActionPreference = 'Stop'
$TaskPath = '\tekurobokun\'

$llama = Join-Path $ServersRoot 'llama\llama-server.exe'
$model = Join-Path $ServersRoot "models\$ModelFile"
$voicevox = Join-Path $ServersRoot 'voicevox\run.exe'
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source

# 起動に要るファイルを、登録の前に確かめる
$missing = @()
if (-not (Test-Path -LiteralPath $llama)) { $missing += "llama-server: $llama" }
if (-not (Test-Path -LiteralPath $model)) { $missing += "モデル: $model" }
if (-not (Test-Path -LiteralPath $voicevox)) { $missing += "VOICEVOX ENGINE: $voicevox" }
if (-not $bun) { $missing += 'bun（PATHにない）' }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'apps\backend\src\index.ts'))) {
  $missing += "リポジトリ: $RepoRoot"
}
if ($missing.Count -gt 0) {
  throw "見つからないものがあるため、登録しない:`n  " + ($missing -join "`n  ")
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'apps\console\dist'))) {
  Write-Warning 'apps\console\dist がない。bun run console:build で入力ページをビルドしてください。'
}

$llamaArgs = "-m '$model' --alias $ModelAlias --host 127.0.0.1 --port 8080 -c 4096 --reasoning off"
if (-not $NoGpu) { $llamaArgs += ' -ngl all' }

# タスクの定義：名前、ウィンドウの題、作業フォルダ、実行するコマンド、起動の遅れ（秒）
$tasks = @(
  @{ Name = 'llama-server'; Title = 'tekurobokun llama-server'; Dir = (Split-Path -Parent $llama)
     Command = "& '$llama' $llamaArgs"; Delay = 0 },
  @{ Name = 'voicevox-engine'; Title = 'tekurobokun voicevox'; Dir = (Split-Path -Parent $voicevox)
     Command = "& '$voicevox' --host 127.0.0.1 --port 50021"; Delay = 0 },
  @{ Name = 'backend'; Title = 'tekurobokun backend'; Dir = $RepoRoot
     Command = "& '$bun' run backend"; Delay = $BackendDelaySeconds }
)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

foreach ($t in $tasks) {
  # -NoExit：コマンドが終わっても（落ちても）ウィンドウを残し、出力を読めるようにする
  $inner = "`$Host.UI.RawUI.WindowTitle = '$($t.Title)'; $($t.Command)"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoLogo -NoExit -ExecutionPolicy Bypass -Command `"$inner`"" `
    -WorkingDirectory $t.Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  if ($t.Delay -gt 0) { $trigger.Delay = "PT$($t.Delay)S" }

  if ($PSCmdlet.ShouldProcess("$TaskPath$($t.Name)", "登録（ログオン時：$($t.Command)）")) {
    Register-ScheduledTask -TaskName $t.Name -TaskPath $TaskPath -Action $action `
      -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "登録した: $TaskPath$($t.Name)"
  }
}

Write-Host ''
Write-Host '次の手順：'
Write-Host '  1. 自動サインインを設定する（netplwiz、または「設定」→「アカウント」→「サインインオプション」）'
Write-Host '  2. すぐに試すなら: Start-ScheduledTask -TaskPath \tekurobokun\ -TaskName backend など'
Write-Host '  3. 取り消すとき: .\scripts\unregister_backend_tasks.ps1'
