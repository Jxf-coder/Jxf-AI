# Jxf-AI 运维 runner 启动器（Windows 计划任务调用）
#
# 作用：常驻 `npm run ops:runner`，异常退出后 10 秒自动重启；
# 输出追加到 backups/ops-runner.log，避免计划任务无控制台时丢日志。

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $repoRoot

$logDir = Join-Path $repoRoot "backups"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "ops-runner.log"

while ($true) {
  "[$(Get-Date -Format o)] starting ops:runner" | Out-File -FilePath $logFile -Append -Encoding utf8
  & npm.cmd run ops:runner *>> $logFile
  $code = $LASTEXITCODE
  "[$(Get-Date -Format o)] ops:runner exited with $code, restart in 10s" |
    Out-File -FilePath $logFile -Append -Encoding utf8
  Start-Sleep -Seconds 10
}
