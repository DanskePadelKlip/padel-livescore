' run-hidden.vbs - launch a PowerShell script with no console window, ever.
'
' Why this exists: Task Scheduler allocates a console for powershell.exe BEFORE
' -WindowStyle Hidden can take effect, so an interactive-logon task flashes an
' empty black window on the desktop every time it fires. wscript.exe is a GUI
' process, so the console created for the child is born hidden (SW_HIDE) and is
' never painted. Nothing to see, nothing to flash.
'
' Chosen over "conhost.exe --headless" because that wrapper reports 0x0 to Task
' Scheduler even when the script fails, which makes a dead job look healthy.
' This waits for the child and returns its real exit code, so LastTaskResult
' stays truthful.
'
' Usage: wscript.exe "run-hidden.vbs" "<script.ps1>" [extra args...]
' ASCII ONLY IN THIS FILE.

Option Explicit
Dim shell, target, cmd, extra, i

If WScript.Arguments.Count < 1 Then WScript.Quit 2
target = WScript.Arguments(0)

extra = ""
For i = 1 To WScript.Arguments.Count - 1
  extra = extra & " """ & WScript.Arguments(i) & """"
Next

Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & target & """" & extra

' 0 = hidden window, True = wait, so the child's exit code reaches Task Scheduler
WScript.Quit shell.Run(cmd, 0, True)
