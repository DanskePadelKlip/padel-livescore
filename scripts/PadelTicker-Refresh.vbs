' Always-on PadelTicker refresh daemon launcher.
' Copy this file into your Startup folder (Win+R -> shell:startup) to have the
' laptop start the refresh daemon, hidden, at every logon. run-refresh-loop.ps1
' has a single-instance guard, so a duplicate launch is a harmless no-op.
CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\Dansk\AI Projects\padel-livescore\scripts\run-refresh-loop.ps1""", 0, False
