' Always-on Sporteaser capture launcher. Copy into shell:startup so the laptop
' starts it hidden at every logon. run-capture-sporteaser.ps1 has a single-
' instance guard, so a duplicate launch is a harmless no-op.
CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\Dansk\AI Projects\padel-livescore\scripts\run-capture-sporteaser.ps1""", 0, False