<#
  install-autostart.ps1 — 注册「BUPT-Notify」定时抓取计划任务

  模型：**短时执行，不常驻**。
  计划任务每隔 N 小时运行一次 `node src\main.js --once --quiet`，
  跑完就退出——所以：
    * 软件关着也能按时抓取（不需要一直开着）
    * 平时没有任何常驻进程占用内存 / CPU / 显存
    * 运行时完全隐藏，不弹控制台、不弹浏览器窗口

  用法（在项目目录下）:
      npm run autostart
    or
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

  参数:
      -TaskName <名称>        计划任务名，默认 BUPT-Notify
      -IntervalHours <小时>   每隔几小时执行一次（可以是小数，如 1.5）。
                              默认读取 config.json 的 poll.intervalMinutes。
      -DelaySeconds <秒>      登录后首次执行的延迟，默认 60 秒
      -NoLogonTrigger         不注册「登录后也跑一次」，只按固定间隔重复
      -RunNow                 注册后立即执行一次
      -Mode <once|ui>         默认 once（后台抓取后退出）。
                              ui = 登录后打开控制面板（一般不需要）

  实现说明（踩过的坑）:
    用 New-ScheduledTaskTrigger -RepetitionDuration 需要一个**有限**时长，
    传 [TimeSpan]::MaxValue 会生成 P99999999DT23H59M59S，计划任务 XML 判定越界
    （0x80041318）。所以这里改用 COM 的 Schedule.Service，把 Repetition.Duration
    留空 = **无限重复**，这样间隔可以是任意小时数（5 小时、7 小时都行），
    而不必局限于能整除 24 的值。
    如果 COM 不可用，退回到模块方式并给一个足够长的时长（P3650D，10 年）。

  卸载: npm run unautostart
#>

[CmdletBinding()]
param(
  [string]$TaskName = 'BUPT-Notify',
  [double]$IntervalHours = 0,
  [int]$DelaySeconds = 60,
  [switch]$NoLogonTrigger,
  [switch]$RunNow,
  [ValidateSet('once', 'ui')]
  [string]$Mode = 'once'
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m"  -ForegroundColor Red; exit 1 }

Write-Host "`nBUPT-Notify 定时抓取任务安装程序" -ForegroundColor Cyan
Write-Host ("-" * 60)

# --- 1. 定位项目根目录与入口文件 ------------------------------------------
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$entry       = Join-Path $projectRoot 'src\main.js'

Info "项目目录: $projectRoot"
if (-not (Test-Path $entry)) { Die "找不到入口文件: $entry" }
if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
  Warn "未找到 node_modules，请先运行 install.cmd 或 npm install"
}
Ok "入口文件存在"

# --- 2. 定位 node.exe ------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Die "在 PATH 中找不到 node。请先安装 Node.js 并重开终端。" }
$nodeExe = $nodeCmd.Source
Info "Node 路径: $nodeExe ($(& $nodeExe --version))"

# --- 3. 决定执行间隔 -------------------------------------------------------
if ($IntervalHours -le 0) {
  $IntervalHours = 3
  $cfgPath = Join-Path $projectRoot 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.poll.intervalMinutes -and $cfg.poll.intervalMinutes -gt 0) {
        $IntervalHours = [math]::Round($cfg.poll.intervalMinutes / 60, 2)
      }
    } catch {
      Warn "无法读取 config.json，使用默认间隔"
    }
  }
}
if ($IntervalHours -lt 0.25 -or $IntervalHours -gt 24) {
  Die "执行间隔必须在 0.25 - 24 小时之间（收到 $IntervalHours）"
}

# 转成 ISO8601 duration：整点用 PT5H，带分钟用 PT5H30M
$totalMinutes = [int][math]::Round($IntervalHours * 60)
$isoHours = [math]::Floor($totalMinutes / 60)
$isoMins  = $totalMinutes % 60
$iso = if ($isoMins -eq 0) { "PT${isoHours}H" } else { "PT${isoHours}H${isoMins}M" }

$intervalText = if ($isoMins -eq 0) { "每 $isoHours 小时" } else { "每 $isoHours 小时 $isoMins 分" }
Info "执行间隔: $intervalText (ISO: $iso)"

# --- 4. 生成隐藏启动器 (VBScript) -----------------------------------------
# 计划任务直接跑 node.exe 会弹出黑色控制台窗口；
# 用 WScript 以窗口样式 0 启动即可完全隐藏，后台运行不影响日常使用。
$vbsPath = Join-Path $scriptDir 'run-hidden.vbs'
$modeFlag = if ($Mode -eq 'ui') { '--ui' } else { '--once --quiet' }
$vbs = @"
' 由 install-autostart.ps1 自动生成，请勿手改。
' 以隐藏窗口方式执行 BUPT-Notify（$modeFlag），跑完即退出。
Option Explicit
Dim sh, fso, projectRoot, logDir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

projectRoot = "$projectRoot"
logDir = fso.BuildPath(projectRoot, "logs")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir) End If

sh.CurrentDirectory = projectRoot
cmd = """" & "$nodeExe" & """ """ & fso.BuildPath(projectRoot, "src\main.js") & """ $modeFlag"
' 0 = 隐藏窗口, False = 不等待
sh.Run cmd, 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding Default
Ok "已生成隐藏启动器: run-hidden.vbs ($modeFlag)"

# --- 5. 注册计划任务 -------------------------------------------------------
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$wscriptExe  = "$env:WINDIR\System32\wscript.exe"

# 已存在就先删掉，避免 CREATE_OR_UPDATE 之外的行为差异
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Info "已存在同名任务，正在覆盖…"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$registered = $false

# 5a. 首选：COM API，Repetition.Duration 留空 = 无限重复
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $root = $svc.GetFolder('\')

  $def = $svc.NewTask(0)   # TASK_CREATE
  $def.RegistrationInfo.Description = "BUPT 校内通知/校内文件 自动转发助手：$intervalText 后台抓取一次，跑完即退出"
  $def.Principal.UserId    = $currentUser
  $def.Principal.LogonType = 3   # TASK_LOGON_INTERACTIVE_TOKEN
  $def.Principal.RunLevel  = 0   # TASK_RUNLEVEL_LUA（不需要管理员）

  $def.Settings.Enabled                    = $true
  $def.Settings.StartWhenAvailable          = $true
  $def.Settings.DisallowStartIfOnBatteries  = $false
  $def.Settings.StopIfGoingOnBatteries      = $false
  $def.Settings.ExecutionTimeLimit          = 'PT30M'
  $def.Settings.MultipleInstances           = 2   # TASK_INSTANCES_IGNORE_NEW
  $def.Settings.AllowHardTerminate          = $true

  # 触发 1：定时触发 + 无限重复
  $timeTrigger = $def.Triggers.Create(1)   # TASK_TRIGGER_TIME
  $timeTrigger.StartBoundary = (Get-Date).AddMinutes(2).ToString('yyyy-MM-ddTHH:mm:ss')
  $timeTrigger.Repetition.Interval = $iso
  # Repetition.Duration 故意留空 —— 空 = 无限重复

  # 触发 2：登录后延迟执行
  if (-not $NoLogonTrigger) {
    $logonTrigger = $def.Triggers.Create(9)   # TASK_TRIGGER_LOGON
    $logonTrigger.UserId = $currentUser
    $logonTrigger.Delay  = "PT${DelaySeconds}S"
  }

  $action = $def.Actions.Create(0)   # TASK_ACTION_EXEC
  $action.Path             = $wscriptExe
  $action.Arguments        = '"' + $vbsPath + '"'
  $action.WorkingDirectory = $projectRoot

  $root.RegisterTaskDefinition($TaskName, $def, 6, $null, $null, 3) | Out-Null
  $registered = $true
  Ok "计划任务已注册（COM / 无限重复，间隔 $iso）"
} catch {
  Warn "COM 注册失败：$($_.Exception.Message)"
}

# 5b. 回落：模块方式 + 足够长的时长（10 年）
if (-not $registered) {
  Info "改用模块方式注册…"
  try {
    $trigger = New-ScheduledTaskTrigger `
      -Once `
      -At (Get-Date).AddMinutes(2) `
      -RepetitionInterval (New-TimeSpan -Minutes $totalMinutes) `
      -RepetitionDuration (New-TimeSpan -Days 3650)
    $triggers = @($trigger)

    if (-not $NoLogonTrigger) {
      $logon = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
      $logon.Delay = "PT${DelaySeconds}S"
      $triggers += $logon
    }

    $taskAction = New-ScheduledTaskAction `
      -Execute $wscriptExe `
      -Argument "`"$vbsPath`"" `
      -WorkingDirectory $projectRoot

    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
      -MultipleInstances IgnoreNew

    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $taskAction `
      -Trigger $triggers `
      -Settings $settings `
      -Principal $principal | Out-Null

    $registered = $true
    Ok "计划任务已注册（模块方式，间隔 $iso，时长 10 年）"
  } catch {
    Die "计划任务注册失败：$($_.Exception.Message)"
  }
}

if (-not $registered) { Die "计划任务注册失败" }

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Ok "已立即启动一次"
}

# --- 6. 结果 ---------------------------------------------------------------
Write-Host ("-" * 60)
Write-Host "安装完成。" -ForegroundColor Green
Write-Host ""
Write-Host "  执行间隔:   $intervalText"
Write-Host "  运行方式:   node src\main.js $modeFlag （隐藏窗口，跑完即退出）"
Write-Host "  常驻进程:   无 —— 平时不占用内存/CPU/显存"
Write-Host ""
Write-Host "  查看状态:   npm run task-status"
Write-Host "  立即执行:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  上次结果:   Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "  取消定时:   npm run unautostart    （或面板里取消勾选）"
Write-Host "  运行日志:   $projectRoot\logs\"
Write-Host ""
