# Launcher for the Padel+ hall-scoring capture (see scripts/capture-padelplus.mjs).
#
# ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# em-dash decodes to three bytes whose last one is a smart quote - inside a string
# that terminates it early and the whole script fails to parse. Same rule as
# run-refresh-loop.ps1 and run-capture-sporteaser.ps1.
$ErrorActionPreference = "Continue"
$env:PATH = "C:\Program Files\nodejs;$env:PATH"

# Single-instance guard: two capturers would append the same versions twice.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*capture-padelplus*' }
if ($running) { Write-Host "capture already running (PID $($running.ProcessId -join ','))"; return }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path "logs" | Out-Null

# Supervise: if node exits for any reason, restart after a short pause. state.json
# makes the restart resume instead of rewriting what was already kept.
while ($true) {
  & "C:\Program Files\nodejs\node.exe" scripts/capture-padelplus.mjs *>> "logs\capture-padelplus.log"
  "[$([DateTime]::UtcNow.ToString('o'))] capture exited (code $LASTEXITCODE), restarting in 30s" *>> "logs\capture-padelplus.log"
  Start-Sleep -Seconds 30
}
