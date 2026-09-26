' ============================================================================
'  BUPT-Notify 一键启动器
'  双击本文件即可启动（不会弹出黑色控制台窗口）。
'
'  由 scripts/create-shortcut.ps1 生成绝对路径版本；这里的版本使用相对路径，
'  因此整个文件夹移动位置后依然可用。
' ============================================================================
Option Explicit

Dim fso, sh, here, launcher, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' 找到 node.exe（优先使用安装时的绝对路径文件）
nodeExe = "node"
Dim nodePathFile
nodePathFile = fso.BuildPath(here, ".node-path")
If fso.FileExists(nodePathFile) Then
    Dim ts
    Set ts = fso.OpenTextFile(nodePathFile, 1)
    If Not ts.AtEndOfStream Then nodeExe = Trim(ts.ReadLine)
    ts.Close
End If

launcher = fso.BuildPath(here, "src\main.js")
If Not fso.FileExists(launcher) Then
    MsgBox "找不到 " & launcher & vbCrLf & vbCrLf & "请确认本文件位于 BUPT-Notify 文件夹内。", 16, "BUPT-Notify"
    WScript.Quit 1
End If

' 0 = 隐藏控制台窗口, False = 不等待返回
cmd = """" & nodeExe & """ """ & launcher & """ --ui"
sh.Run cmd, 0, False
