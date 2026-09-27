<#
  task-status.ps1 — 查询 BUPT-Notify 计划任务状态，输出一行 JSON 供 Node 解析。

  用法:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\task-status.ps1 [任务名]

  输出示例:
      {"installed":true,"state":"Ready","mode":"once","triggers":["repetition","logon"],
       "intervalHours":3,"lastRunTime":"...","lastTaskResult":0,"nextRunTime":"..."}
#>

[CmdletBinding()]
param(
  [string]$TaskName = 'BUPT-Notify'
)

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Emit @{ installed = $false; taskName = $TaskName }
  }

  # 触发方式：每日时刻（我们按间隔铺开多个）/ 重复间隔 / 登录 / 开机
  $triggers = @()
  $intervalHours = $null
  $dailyCount = 0
  foreach ($t in $task.Triggers) {
    $kind = "$($t.CimClass.CimClassName)"
    if ($kind -match 'DailyTrigger') {
      $dailyCount += 1
    } elseif ($kind -match 'TimeTrigger') {
      $triggers += 'repetition'
      if ($t.Repetition -and $t.Repetition.Interval) {
        # ISO8601 duration: PT5H / PT1H30M / PT45M
        $iso = "$($t.Repetition.Interval)"
        $h = 0; $m = 0
        if ($iso -match '(\d+)H') { $h = [int]$Matches[1] }
        if ($iso -match '(\d+)M') { $m = [int]$Matches[1] }
        if ($h -gt 0 -or $m -gt 0) {
          $intervalHours = [math]::Round($h + ($m / 60), 2)
          if ($intervalHours -eq [math]::Floor($intervalHours)) { $intervalHours = [int]$intervalHours }
        }
      }
    } elseif ($kind -match 'LogonTrigger') {
      $triggers += 'logon'
    } elseif ($kind -match 'BootTrigger') {
      $triggers += 'boot'
    } else {
      $triggers += $kind
    }
  }

  # N daily triggers spread evenly over the day => every 24/N hours.
  if ($dailyCount -gt 0) {
    $triggers = @('daily') + $triggers
    if ($intervalHours -eq $null -and $dailyCount -gt 0) {
      $intervalHours = [math]::Round(24 / $dailyCount, 2)
      if ($intervalHours -eq [math]::Floor($intervalHours)) { $intervalHours = [int]$intervalHours }
    }
    $triggers += "x$dailyCount"
  }

  # 启动模式：从隐藏启动器读取实际参数
  $mode = $null
  $vbs = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'run-hidden.vbs'
  if (Test-Path $vbs) {
    $content = Get-Content $vbs -Raw -ErrorAction SilentlyContinue
    if ($content -match '--once')      { $mode = 'once' }
    elseif ($content -match '--ui')    { $mode = 'ui' }
    elseif ($content -match '--serve') { $mode = 'serve' }
  }

  $info = $null
  try { $info = $task | Get-ScheduledTaskInfo } catch { $info = $null }

  $lastRun = $null
  $nextRun = $null
  $lastResult = $null
  if ($info) {
    if ($info.LastRunTime) { $lastRun = "$($info.LastRunTime)" }
    if ($info.NextRunTime) { $nextRun = "$($info.NextRunTime)" }
    $lastResult = $info.LastTaskResult
  }

  Emit @{
    installed      = $true
    taskName       = $TaskName
    state          = "$($task.State)"
    mode           = $mode
    triggers       = $triggers
    intervalHours  = $intervalHours
    userId         = "$($task.Principal.UserId)"
    lastRunTime    = $lastRun
    lastTaskResult = $lastResult
    nextRunTime    = $nextRun
  }
} catch {
  Emit @{ installed = $false; taskName = $TaskName; error = $_.Exception.Message }
}
