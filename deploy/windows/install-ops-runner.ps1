# Jxf-AI 运维 runner 计划任务安装（Windows）
#
# 用法（管理员 PowerShell）：
#   .\install-ops-runner.ps1              # 当前用户登录时启动（Docker Desktop 场景）
#   .\install-ops-runner.ps1 -AtStartup   # 开机启动（Windows Server + Docker Engine 服务）
#
# 卸载：
#   Unregister-ScheduledTask -TaskName "JxfAI-OpsRunner" -Confirm:$false

param(
  [switch]$AtStartup
)

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$taskName = "JxfAI-OpsRunner"
$runner = Join-Path $PSScriptRoot "run-ops-runner.ps1"
if (-not (Test-Path $runner)) {
  throw "缺少启动脚本：$runner"
}

$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $runner
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U -RunLevel Highest
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Jxf-AI 运维任务队列与 MCP 连接器心跳" `
  -Force | Out-Null

Write-Host ('已注册计划任务：{0}' -f $taskName)
Write-Host ('启动：Start-ScheduledTask -TaskName "{0}"' -f $taskName)
$logPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\backups\ops-runner.log'))
Write-Host "日志：$logPath"
