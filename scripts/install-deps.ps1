<#
  install-deps.ps1 — 安装 / 更新依赖并创建快捷方式（供 install.cmd 调用）

  用法:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-deps.ps1
      powershell ... -File scripts\install-deps.ps1 -EnableAutostart
      powershell ... -File scripts\install-deps.ps1 -NoShortcut

  做四件事:
    1. 检查 Node.js 版本（需要 20+），没有就给出下载地址并退出
    2. npm install（使用项目内缓存，避免污染全局）
    3. 生成应用图标 + 桌面/开始菜单快捷方式
    4. 可选：启用开机自启（-EnableAutostart）
#>

[CmdletBinding()]
param(
  [switch]$EnableAutostart,
  [switch]$NoShortcut,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Step($m) { if (-not $Quiet) { Write-Host "`n==> $m" -ForegroundColor Cyan } }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n  [X] $m`n" -ForegroundColor Red; exit 1 }

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

Write-Host ""
Write-Host "BUPT-Notify 安装程序" -ForegroundColor Cyan
Write-Host ("-" * 60)
Write-Host "  项目目录: $projectRoot"

# --- 1. Node.js -------------------------------------------------------------
Step "检查 Node.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host ""
  Write-Host "  没有检测到 Node.js。" -ForegroundColor Yellow
  Write-Host "  请先安装 Node.js 20 或更高版本（推荐 LTS）："
  Write-Host "      https://nodejs.org/zh-cn/download" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  安装后请关闭并重新打开此窗口，再运行一次本安装程序。"
  Write-Host ""
  $open = Read-Host "  现在打开下载页面吗? (Y/n)"
  if ($open -notin @('n', 'N', 'no', 'NO')) {
    Start-Process 'https://nodejs.org/zh-cn/download'
  }
  exit 1
}

$nodeExe = $nodeCmd.Source
$nodeVersion = (& $nodeExe --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
Write-Host "  版本: $nodeVersion  ($nodeExe)"
if ($major -lt 20) {
  Die "Node.js 版本过低（需要 20+，当前 $nodeVersion）。请升级后重试: https://nodejs.org/"
}
Ok "Node.js $nodeVersion"

# 固化 node 路径，启动器不依赖 PATH
Set-Content -Path (Join-Path $projectRoot '.node-path') -Value $nodeExe -Encoding ASCII
Ok "已记录 Node 路径到 .node-path"

# --- 2. 依赖 ----------------------------------------------------------------
Step "安装依赖"

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) { Die "找不到 npm（应与 Node.js 一起安装）。" }

# 用项目内缓存，避免写到全局目录（需要管理员权限 / 可能被安全软件拦截）
$cacheDir = Join-Path $projectRoot '.npm-cache'
$env:npm_config_cache = $cacheDir

Push-Location $projectRoot
try {
  if ($Quiet) {
    & npm install --no-fund --no-audit --loglevel=error
  } else {
    & npm install --no-fund --no-audit
  }
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败（退出码 $LASTEXITCODE）。请检查网络后重试。" }
} finally {
  Pop-Location
}
Ok "依赖安装完成"

# --- 3. 图标 + 快捷方式 -----------------------------------------------------
if (-not $NoShortcut) {
  Step "创建桌面快捷方式"
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'create-shortcut.ps1') | Out-Null
    Ok "桌面与开始菜单快捷方式已创建"
  } catch {
    Warn "快捷方式创建失败：$($_.Exception.Message)"
    Warn "不影响使用，可以稍后运行: npm run shortcut"
  }
} else {
  Warn "已跳过快捷方式创建（-NoShortcut）"
}

# --- 4. 开机自启（可选） ----------------------------------------------------
if ($EnableAutostart) {
  Step "启用开机自启"
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'install-autostart.ps1') | Out-Null
    Ok "开机自启已启用"
  } catch {
    Warn "开机自启启用失败：$($_.Exception.Message)"
  }
}

# --- 结果 -------------------------------------------------------------------
Write-Host ""
Write-Host ("-" * 60)
Write-Host "安装完成 ✓" -ForegroundColor Green
Write-Host ""
Write-Host "  启动方式："
if (-not $NoShortcut) {
  Write-Host "    · 双击桌面上的 「BUPT-Notify」 图标" -ForegroundColor Cyan
}
Write-Host "    · 或在项目目录运行: npm run ui" -ForegroundColor Cyan
Write-Host ""
Write-Host "  首次启动后请在控制面板里填写："
Write-Host "    1. QQ 邮箱授权码（QQ邮箱 → 设置 → 账户 → POP3/IMAP/SMTP服务 → 生成授权码）"
Write-Host "    2. 统一身份认证学号与密码（用于自动登录）"
Write-Host "    3. 抓取间隔 / 是否开启开机自启"
Write-Host ""
exit 0
