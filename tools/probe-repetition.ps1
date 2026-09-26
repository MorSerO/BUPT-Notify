<#
  试验：用「重复间隔」注册计划任务时，RepetitionDuration 能接受多大的值？
  （之前用 [TimeSpan]::MaxValue 生成 P99999999DT23H59M59S，被判越界 0x80041318）
#>

$ErrorActionPreference = 'Continue'
$taskName = 'BUPT-Notify-DurationTest'

function Try-Duration($label, $timespan, $iso) {
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  } catch { }

  $at = (Get-Date).AddMinutes(2)
  try {
    if ($iso) {
      $trigger = New-ScheduledTaskTrigger -Once -At $at
      $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Hours 5) -RepetitionDuration $timespan).Repetition
    } else {
      $trigger = New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Hours 5) -RepetitionDuration $timespan
    }
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null
    $t = Get-ScheduledTask -TaskName $taskName
    $rep = $t.Triggers[0].Repetition
    Write-Output "  OK    $label  -> Interval=$($rep.Interval) Duration=$($rep.Duration)"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  } catch {
    $msg = $_.Exception.Message
    if ($msg.Length -gt 90) { $msg = $msg.Substring(0, 90) }
    Write-Output "  FAIL  $label  -> $msg"
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
}

Write-Output "=== RepetitionDuration candidates (interval PT5H) ==="
Try-Duration '[TimeSpan]::MaxValue' ([TimeSpan]::MaxValue)
Try-Duration '3650 days'            (New-TimeSpan -Days 3650)
Try-Duration '365 days'             (New-TimeSpan -Days 365)
Try-Duration '31 days'              (New-TimeSpan -Days 31)
Try-Duration '1 day'                (New-TimeSpan -Days 1)

Write-Output ""
Write-Output "=== COM API with EMPTY duration (= indefinite) ==="
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $root = $svc.GetFolder('\')
  $def = $svc.NewTask(0)
  $def.RegistrationInfo.Description = 'duration test'
  $def.Settings.Enabled = $true
  $def.Settings.StartWhenAvailable = $true
  $trig = $def.Triggers.Create(1)   # 1 = TASK_TRIGGER_TIME
  $trig.StartBoundary = (Get-Date).AddMinutes(2).ToString('yyyy-MM-ddTHH:mm:ss')
  $trig.Repetition.Interval = 'PT5H'
  # Duration 留空 = 无限重复（COM 与 XML 都支持）
  $action = $def.Actions.Create(0)
  $action.Path = 'cmd.exe'
  $action.Arguments = '/c exit'
  $root.RegisterTaskDefinition($taskName, $def, 6, $null, $null, 3) | Out-Null
  $t = Get-ScheduledTask -TaskName $taskName
  $rep = $t.Triggers[0].Repetition
  Write-Output "  OK    COM empty duration -> Interval=$($rep.Interval) Duration='$($rep.Duration)'"
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {
  $msg = $_.Exception.Message
  if ($msg.Length -gt 120) { $msg = $msg.Substring(0, 120) }
  Write-Output "  FAIL  COM: $msg"
  try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
}
