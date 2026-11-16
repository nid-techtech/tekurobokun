# register_backend_tasks.ps1 で登録したタスク（「\tekurobokun\」のフォルダ）を取り消す（管理者のPowerShellで実行）。
# 起動中のウィンドウ（llama-server・VOICEVOX ENGINE・バックエンド）は止めない。必要なら手で閉じる。
#
#   .\scripts\unregister_backend_tasks.ps1 -WhatIf    # 消えるタスクだけを見る
#   .\scripts\unregister_backend_tasks.ps1

#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$TaskPath = '\tekurobokun\'

$tasks = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue)
if ($tasks.Count -eq 0) {
  Write-Host "登録されたタスクはない（$TaskPath）"
  return
}

foreach ($t in $tasks) {
  if ($PSCmdlet.ShouldProcess("$TaskPath$($t.TaskName)", '取り消し')) {
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $t.TaskName -Confirm:$false
    Write-Host "取り消した: $TaskPath$($t.TaskName)"
  }
}
