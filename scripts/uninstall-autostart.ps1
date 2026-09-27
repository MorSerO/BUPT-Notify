<#
  uninstall-autostart.ps1 — 移除 BUPT-Notify 开机自启

  用法:
      npm run unautostart
    or
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1

  参数:
      -TaskName <名称>   默认 BUPT-Notify
      -KeepLauncher      保留 run-hidden.vbs（默认删除）
#>

[CmdletBinding()]
param(
  [string]$TaskName = 'BUPT-Notify',
  [switch]$KeepLauncher
)

$ErrorActionPreference = 'Continue'

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"  -ForegroundColor Yellow }

Write-Host "`nBUPT-Notify 开机自启卸载程序" -ForegroundColor Cyan
Write-Host ("-" * 60)

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  # 先结束可能在运行中的实例，否则节点进程会残留
  $running = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
  if ($task.State -eq 'Running') {
    Warn "任务正在运行，先停止…"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Ok "已删除计划任务: $TaskName"
} else {
  Warn "未找到计划任务 '$TaskName'（可能尚未安装）。"
}

# 结束残留的 node 进程（仅限本项目的 main.js）
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'BUPT-Notify' -and $_.CommandLine -match 'main\.js' }
if ($procs) {
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Ok "已结束残留进程 pid $($p.ProcessId)"
    } catch {
      Warn "无法结束 pid $($p.ProcessId): $($_.Exception.Message)"
    }
  }
} else {
  Ok "没有残留的运行进程"
}

if (-not $KeepLauncher) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $vbs = Join-Path $scriptDir 'run-hidden.vbs'
  if (Test-Path $vbs) {
    Remove-Item $vbs -Force
    Ok "已删除 run-hidden.vbs"
  }
}

# 清理单实例锁 —— 但**只能清理陈旧的**。
#
# 早先的版本无条件删除锁文件，结果：程序正在运行时，只要用户关闭一次开机自启，
# 运行中实例的锁就没了，之后再次启动会误以为没有实例在跑，
# 于是抢端口失败（EADDRINUSE）而不是把已有面板带到前台。
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$lock = Join-Path $projectRoot 'data\bupt-notify.lock'
if (Test-Path $lock) {
  $lockPid = 0
  try { $lockPid = [int](Get-Content $lock -Raw).Trim() } catch { $lockPid = 0 }
  $alive = $false
  if ($lockPid -gt 0) {
    $alive = $null -ne (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)
  }
  if ($alive) {
    Warn "检测到程序仍在运行 (pid $lockPid)，保留锁文件"
  } else {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
    Ok "已清理陈旧的锁文件"
  }
}

Write-Host ("-" * 60)
Write-Host "卸载完成。配置与历史记录（config.json / data / logs）均已保留。" -ForegroundColor Green
Write-Host ""
