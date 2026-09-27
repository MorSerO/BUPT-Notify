<#
  check-shortcuts.ps1 — 检查桌面 / 开始菜单快捷方式是否仍然有效。

  背景：快捷方式里存的是**绝对路径**。如果启动器被重命名、或者整个文件夹被移动，
  快捷方式就会指向一个不存在的文件，双击时只弹一句「无法启动脚本文件」，
  很难看出原因。这里把实际指向读出来并校验。

  输出一行 JSON:
      {"desktop":{"path":"...","target":"...","exists":true,"valid":true},
       "startMenu":{...}}
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Describe($linkPath, $shell) {
  if (-not (Test-Path $linkPath)) {
    return @{ path = $linkPath; exists = $false; valid = $false; target = $null; reason = 'not-found' }
  }
  try {
    $sc = $shell.CreateShortcut($linkPath)
    $script = "$($sc.Arguments)".Trim('"')
    $targetOk = Test-Path $sc.TargetPath
    $scriptOk = if ($script) { Test-Path $script } else { $false }
    $valid = $targetOk -and $scriptOk
    return @{
      path        = $linkPath
      exists      = $true
      valid       = $valid
      exe         = "$($sc.TargetPath)"
      target      = $script
      exeExists   = $targetOk
      targetExists = $scriptOk
      reason      = if ($valid) { 'ok' } elseif (-not $scriptOk) { 'script-missing' } else { 'exe-missing' }
    }
  } catch {
    return @{ path = $linkPath; exists = $true; valid = $false; reason = "error: $($_.Exception.Message)" }
  }
}

try {
  $shell = New-Object -ComObject WScript.Shell
  $name = 'BUPT-Notify'

  $desktopDir = [Environment]::GetFolderPath('Desktop')
  $programsDir = [Environment]::GetFolderPath('Programs')

  $result = @{
    desktop   = if ($desktopDir) { Describe (Join-Path $desktopDir "$name.lnk") $shell } else { $null }
    startMenu = if ($programsDir) { Describe (Join-Path $programsDir "$name.lnk") $shell } else { $null }
  }
  Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
  exit 0
} catch {
  Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 1
}
