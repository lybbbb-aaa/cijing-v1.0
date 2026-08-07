Dim WshShell, WshEnv
Set WshShell = CreateObject("WScript.Shell")
Set WshEnv = WshShell.Environment("Process")

' Remove ELECTRON_RUN_AS_NODE so Electron launches as a proper app
On Error Resume Next
WshEnv.Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0

Dim distDir
distDir = "C:\Users\liuyb07\Desktop\project\ielts-vocab\node_modules\electron\dist"

Dim exePath
exePath = distDir & "\electron.exe"

If Not CreateObject("Scripting.FileSystemObject").FileExists(exePath) Then
    MsgBox "electron.exe not found. Please run 安装依赖.bat first.", 16, "IELTS Widget"
    WScript.Quit
End If

WshShell.CurrentDirectory = distDir
WshShell.Run """" & exePath & """", 0, False
