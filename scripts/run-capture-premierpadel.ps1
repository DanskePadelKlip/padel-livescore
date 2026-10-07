# Launcher for the daily Premier Padel capture (see scripts/capture-premierpadel.mjs).
# Task: PadelTicker-PremierPadel-Daily, via run-hidden.vbs so nothing paints.
#
# ASCII ONLY IN THIS FILE (Windows PowerShell 5.1 reads .ps1 as ANSI).
#
# Incremental and idempotent: a failed or missed run loses nothing, the next one
# picks up every finished match that still has no stats file. Safe to re-run.
# Exit: 0 = ok, 1 = node failed (API/network; see the log), 3 = already running.
$ErrorActionPreference = "Continue"
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
# Explicit, not ~: a remoting or SYSTEM run would otherwise write to another profile.
$env:PP_CAPTURE_DIR = "C:\Users\Dansk\premierpadel-capture"

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*capture-premierpadel*' }
if ($running) { exit 3 }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
$log = "logs\capture-premierpadel.log"

"[$([DateTime]::UtcNow.ToString('o'))] start" | Out-File -Append -Encoding ascii $log
# Through cmd, not *>>: PS 5.1 redirection writes UTF-16 and would interleave with
# the ASCII marker lines. node is on PATH (set above).
cmd /c "node scripts\capture-premierpadel.mjs >> $log 2>&1"
$code = $LASTEXITCODE
"[$([DateTime]::UtcNow.ToString('o'))] exit $code" | Out-File -Append -Encoding ascii $log
if ($code -ne 0) { exit 1 }
exit 0
