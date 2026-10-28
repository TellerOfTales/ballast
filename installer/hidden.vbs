' Runs one of Ballast's PowerShell scripts (next to this file) with no console window.
' Usage: wscript.exe hidden.vbs <script.ps1> [arguments...]
Option Explicit
Dim fso, sh, dir, cmd, i, a
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 1
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & fso.BuildPath(dir, WScript.Arguments(0)) & """"
For i = 1 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = """" & a & """"
  cmd = cmd & " " & a
Next
sh.Run cmd, 0, False
