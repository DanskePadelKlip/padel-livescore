# Launcher for the Sporteaser capture (see scripts/capture-sporteaser.mjs).
#
# ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# em-dash decodes to three bytes whose last one is a smart quote - inside a string
# that terminates it early and the whole script fails to parse. Same rule as
# run-refresh-loop.ps1, and it cost a live break once already.
$ErrorActionPreference = "Continue"
$env:PATH = "C:\Program Files\nodejs;$env:PATH"

# Single-instance guard: a re-logon, a manual start and the Startup shortcut can
# all fire together. Two capturers would race on the same output filenames.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*capture-sporteaser*' }
if ($running) { Write-Host "capture already running (PID $($running.ProcessId -join ','))"; return }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path "logs" | Out-Null

# Supervise, don't just launch: the refresh daemon died silently once and nothing
# revived it for ~27h. If node exits for any reason, restart after a short pause.
while ($true) {
  & "C:\Program Files\nodejs\node.exe" scripts/capture-sporteaser.mjs 397 *>> "logs\capture-sporteaser.log"
  "[$([DateTime]::UtcNow.ToString('o'))] capture exited (code $LASTEXITCODE), restarting in 30s" *>> "logs\capture-sporteaser.log"
  Start-Sleep -Seconds 30
}