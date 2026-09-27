<#
  create-shortcut.ps1 — 创建「一键启动」快捷方式

  用法（在项目目录下）:
      npm run shortcut
    or
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1

  参数:
      -Name <名称>        快捷方式名称，默认 "BUPT-Notify"
      -NoDesktop          不创建桌面快捷方式
      -NoStartMenu        不创建开始菜单快捷方式
      -StartMenuFolder <名称>  开始菜单里的文件夹名（默认与 -Name 相同）

  做的事情:
    1. 固化 node.exe 的绝对路径到 .node-path（启动器不依赖系统 PATH）
    2. 生成 assets\bupt-notify.ico 应用图标
    3. 在桌面 / 开始菜单创建快捷方式，指向隐藏启动器
#>

[CmdletBinding()]
param(
  [string]$Name = 'BUPT-Notify',
  [switch]$NoDesktop,
  [switch]$NoStartMenu,
  [string]$StartMenuFolder = ''
)

$ErrorActionPreference = 'Stop'

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "  $m" }
function Warn($m) { Write-Host "  [!] $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m"  -ForegroundColor Red; exit 1 }

Write-Host "`nBUPT-Notify 一键启动快捷方式" -ForegroundColor Cyan
Write-Host ("-" * 60)

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Info "项目目录: $projectRoot"

# --- 1. launcher + node path ------------------------------------------------
$launcher = Join-Path $projectRoot 'start-bupt-notify.vbs'
if (-not (Test-Path $launcher)) { Die "找不到启动器: $launcher" }
Ok "找到启动器: start-bupt-notify.vbs"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Die "在 PATH 中找不到 node。请先安装 Node.js 并重开终端。" }
$nodeExe = $nodeCmd.Source
Set-Content -Path (Join-Path $projectRoot '.node-path') -Value $nodeExe -Encoding ASCII
Ok "已记录 Node 路径: $nodeExe"

# --- 2. icon ----------------------------------------------------------------
$icon = Join-Path $projectRoot 'assets\bupt-notify.ico'
if (-not (Test-Path $icon)) {
  Info "生成应用图标…"
  try {
    & $nodeExe (Join-Path $scriptDir 'make-icon.mjs') | Out-Null
  } catch {
    Write-Host "  [!] 图标生成失败，将使用系统默认图标" -ForegroundColor Yellow
  }
}
if (Test-Path $icon) { Ok "应用图标: assets\bupt-notify.ico" }

# --- 3. shortcuts -----------------------------------------------------------
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell

function New-Shortcut([string]$linkPath) {
  $sc = $shell.CreateShortcut($linkPath)
  $sc.TargetPath       = $wscript
  $sc.Arguments        = '"' + $launcher + '"'
  $sc.WorkingDirectory = $projectRoot
  $sc.Description      = 'BUPT 校内通知 / 校内文件 自动转发助手'
  $sc.WindowStyle      = 7   # 最小化启动（控制台本身是隐藏的）
  if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Save()

  # 读回来校验：快捷方式保存的是绝对路径，改名或移动文件夹都会让它指向不存在的
  # 文件，而 Windows 只会弹一句「无法启动脚本文件」，很难排查。
  $check = $shell.CreateShortcut($linkPath)
  $scriptPath = $check.Arguments.Trim('"')
  if ($check.TargetPath -ne $wscript) {
    Die "快捷方式目标异常: $($check.TargetPath)"
  }
  if (-not (Test-Path $scriptPath)) {
    Die "快捷方式指向的启动器不存在: $scriptPath`n（如果刚重命名过启动器，请重新运行本脚本）"
  }
  return $linkPath
}

# 检查并报告已存在的、指向失效文件的旧快捷方式（会被下面的创建步骤覆盖）
function Test-StaleShortcut([string]$linkPath) {
  if (-not (Test-Path $linkPath)) { return $null }
  try {
    $sc = $shell.CreateShortcut($linkPath)
    $target = $sc.Arguments.Trim('"')
    if ($target -and -not (Test-Path $target)) {
      return "$linkPath  ->  $target (不存在)"
    }
  } catch { }
  return $null
}

$staleToRepair = @()
if (-not $NoDesktop) {
  $d = [Environment]::GetFolderPath('Desktop')
  if ($d) { $s = Test-StaleShortcut (Join-Path $d "$Name.lnk"); if ($s) { $staleToRepair += $s } }
}
if (-not $NoStartMenu) {
  $p = [Environment]::GetFolderPath('Programs')
  if ($p) { $s = Test-StaleShortcut (Join-Path $p "$Name.lnk"); if ($s) { $staleToRepair += $s } }
}
foreach ($s in $staleToRepair) {
  Warn "发现失效的旧快捷方式，将修复: $s"
}

$created = @()

if (-not $NoDesktop) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $created += New-Shortcut (Join-Path $desktop "$Name.lnk")
    Ok "桌面快捷方式: $desktop\$Name.lnk"
  }
}

if (-not $NoStartMenu) {
  $programs = [Environment]::GetFolderPath('Programs')
  if ($programs) {
    $folder = if ($StartMenuFolder) { Join-Path $programs $StartMenuFolder } else { $programs }
    if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
    $created += New-Shortcut (Join-Path $folder "$Name.lnk")
    Ok "开始菜单快捷方式: $folder\$Name.lnk"
  }
}

Write-Host ("-" * 60)
Write-Host "完成。现在双击桌面上的「$Name」即可启动（不会弹黑框）。" -ForegroundColor Green
Write-Host ""
Write-Host "  程序会在 http://127.0.0.1:17872 打开控制面板窗口"
Write-Host "  再次双击不会启动第二个实例，只会把面板窗口带到前台"
Write-Host ""
